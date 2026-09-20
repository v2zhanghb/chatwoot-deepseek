#!/usr/bin/env node
'use strict';

/**
 * 演示链路端到端验证（零依赖）
 *
 *   模拟一个"客户"在网页 widget 里发一条消息，确认它真的落进了坐席收件箱。
 *   顺带检查最常踩的坑：FRONTEND_URL 是否还指向 localhost（导致别的设备发不出消息）。
 *
 * 用法：
 *   node e2e.js                          # 用本机 Chatwoot 验证
 *   node e2e.js --cw=http://192.168.5.106:3000
 *   node e2e.js --clean                  # 验证后自动删掉这条测试会话
 *   node e2e.js --admin-token=xxxx       # 手动指定管理员 token
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

/* 从隔壁机器人项目借管理员 token（避免把密钥写进本文件） */
function readBotEnv() {
  const file = path.join(__dirname, '..', 'chatwoot-deepseek-bot', '.env');
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (_) {
    /* 没有就算了 */
  }
  return out;
}

const CW = opt('cw', process.env.CHATWOOT_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const WEBSITE_TOKEN = opt('website-token', process.env.WEBSITE_TOKEN || 'fPyiYpNjapiXhHfquvRsBMgU');
const ACCOUNT_ID = opt('account', process.env.CHATWOOT_ACCOUNT_ID || '1');
const DEMO_PORT = Number(process.env.PORT || 8081);
const ADMIN_TOKEN = opt('admin-token', process.env.CHATWOOT_ADMIN_TOKEN || readBotEnv().CHATWOOT_ADMIN_TOKEN || '');

const TEST_MESSAGE = '【链路验证】请问今天下单什么时候能发货？';

const OK = '✅';
const BAD = '❌';
const WARN = '⚠️ ';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localIPv4() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch (_) {
    return {};
  }
}

(async () => {
  console.log('\n=== Chatwoot 演示链路端到端验证 ===\n');

  /* 1. 取 widget 配置 */
  let cfg;
  try {
    const r = await fetch(`${CW}/api/v1/widget/config?website_token=${WEBSITE_TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cfg = (await r.json()).website_channel_config;
  } catch (e) {
    console.log(`${BAD} 拉取 widget 配置失败（${e.message}）`);
    console.log(`   → 确认 Chatwoot 在跑：${CW}/health\n`);
    process.exit(1);
  }

  const inboxId = jwtPayload(cfg.auth_token).inbox_id;
  console.log(`Chatwoot      ${CW}`);
  console.log(`api_host      ${cfg.api_host}`);
  console.log(`收件箱        inbox_id=${inboxId}`);

  /* 2. 检查最常踩的坑：api_host 是否只对本机有效 */
  const ips = localIPv4();
  let apiHostName = '';
  try {
    apiHostName = new URL(cfg.api_host).hostname;
  } catch (_) {
    /* ignore */
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(apiHostName);
  if (isLoopback) {
    console.log(`\n${BAD} FRONTEND_URL 仍是 ${cfg.api_host} —— 只有"本机浏览器"能用它`);
    console.log('   → 别人用手机/另一台电脑打开演示页时，widget 会去请求「那台设备自己的 localhost」，消息发不出去。');
    console.log(`   → 修正：改 Desktop\\chatwoot-local\\.env 为 FRONTEND_URL=http://${ips[0] || '192.168.x.x'}:3000`);
    console.log('     然后执行  docker compose up -d chatwoot sidekiq');
  } else if (ips.includes(apiHostName)) {
    console.log(`\n${OK} api_host 指向本机局域网 IP（${apiHostName}），其他设备可正常收发`);
  } else {
    console.log(`\n${WARN}api_host 的 host「${apiHostName}」不在本机网卡地址中：${ips.join(', ') || '无'}`);
    console.log('   → 若这是域名/公网 IP 且客户能访问，可忽略；否则按上面方式改成局域网 IP。');
  }

  /* 3. 模拟客户发消息（后续请求只走 api_host，等价于"外部设备"视角） */
  const base = cfg.api_host;
  let conv;
  try {
    const r = await fetch(`${base}/api/v1/widget/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Auth-Token': cfg.auth_token },
      body: JSON.stringify({
        website_token: WEBSITE_TOKEN,
        contact: { name: '链路验证客户', email: 'e2e@example.com' },
        message: { content: TEST_MESSAGE, referer_url: `http://${ips[0] || 'localhost'}:${DEMO_PORT}/` }
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    conv = await r.json();
  } catch (e) {
    console.log(`\n${BAD} 客户消息发送失败：${e.message}`);
    console.log('   → 若 api_host 是 localhost 且你在别的设备上跑本脚本，这就是被坑的现象本身。\n');
    process.exit(1);
  }
  const convId = conv.id;
  const contactId = conv.messages && conv.messages[0] && conv.messages[0].sender && conv.messages[0].sender.id;
  console.log(`\n${OK} 客户消息已发出 → 会话 #${convId}（HTTP 200）`);

  /* 4. 从"坐席视角"回查，确认真的能看到 */
  if (ADMIN_TOKEN) {
    await sleep(1500);
    try {
      const r = await fetch(`${CW}/api/v1/accounts/${ACCOUNT_ID}/conversations/${convId}`, {
        headers: { api_access_token: ADMIN_TOKEN },
        signal: AbortSignal.timeout(8000)
      });
      if (r.ok) {
        const c = await r.json();
        const msgCount = (c.messages || []).length;
        const assignee = (c.meta && c.meta.assignee && c.meta.assignee.name) || '未分配';
        console.log(`${OK} 坐席端可查到该会话：status=${c.status} · 消息 ${msgCount} 条 · 负责人 ${assignee}`);
      } else {
        console.log(`${WARN}坐席端回查失败 HTTP ${r.status}（token 是否有效？）`);
      }
    } catch (e) {
      console.log(`${WARN}坐席端回查异常：${e.message}`);
    }
  } else {
    console.log(`${WARN}未拿到管理员 token，跳过坐席端回查`);
  }

  /* 5. 告诉用户去哪儿看 */
  console.log('\n--- 到坐席端查看 ---');
  console.log(`  列表  ${CW}/app/accounts/${ACCOUNT_ID}/inbox/${inboxId}`);
  console.log(`  直达  ${CW}/app/accounts/${ACCOUNT_ID}/inbox/${inboxId}/conversations/${convId}`);
  console.log('  提示：新会话状态是 pending，列表左上角状态筛选切到「Pending」或「全部」才看得到；');
  console.log('        若列表停在「我的」，未分配的会话也不显示。');

  /* 6. 清理 */
  if (hasFlag('clean')) {
    if (!ADMIN_TOKEN) {
      console.log(`\n${WARN}--clean 需要管理员 token，跳过清理`);
    } else {
      try {
        await fetch(`${CW}/api/v1/accounts/${ACCOUNT_ID}/conversations/${convId}`, {
          method: 'DELETE',
          headers: { api_access_token: ADMIN_TOKEN }
        });
        if (contactId) {
          await fetch(`${CW}/api/v1/accounts/${ACCOUNT_ID}/contacts/${contactId}`, {
            method: 'DELETE',
            headers: { api_access_token: ADMIN_TOKEN }
          });
        }
        console.log(`\n🧹 已清理测试会话 #${convId}${contactId ? ` 与联系人 #${contactId}` : ''}`);
      } catch (e) {
        console.log(`\n${WARN}清理失败（可手动删）：${e.message}`);
      }
    }
  } else {
    console.log(`\n（加 --clean 可在验证后自动删掉这条测试会话）`);
  }
  console.log('');
})().catch((e) => {
  console.error('未预期的错误:', e);
  process.exit(1);
});
