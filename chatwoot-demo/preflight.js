#!/usr/bin/env node
'use strict';

/**
 * 演示前自检（零依赖）
 *
 *   node preflight.js
 *   node preflight.js --cw=http://192.168.1.10:3000
 *
 * 依次确认：Chatwoot 是否在跑、widget 是否可用、演示页是否已启动、
 * 可选组件（话术助手 / 自动回复机器人）状态，并给出该填的地址。
 */

const os = require('os');

const args = process.argv.slice(2);
const cwArg = args.find((a) => a.startsWith('--cw='));
const CW = (cwArg ? cwArg.slice(5) : process.env.CHATWOOT_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const WEB_TOKEN = process.env.WEBSITE_TOKEN || 'fPyiYpNjapiXhHfquvRsBMgU';
const DEMO_PORT = Number(process.env.PORT) || 8081;

const PASS = '✅';
const FAIL = '❌';
const SKIP = '⚪';
const WARN = '⚠️ ';

function localIPv4() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

async function probe(url, { method = 'GET', json = null, expectJson = false, timeout = 4000 } = {}) {
  try {
    const r = await fetch(url, {
      method,
      headers: json === null ? undefined : { 'Content-Type': 'application/json' },
      body: json === null ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(timeout)
    });
    let body = null;
    if (expectJson) body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'TimeoutError' ? '超时' : e.message };
  }
}

function line(icon, label, detail) {
  console.log(`${icon} ${label.padEnd(22, ' ')} ${detail}`);
}

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

(async () => {
  console.log('\n=== Chatwoot 演示环境自检 ===\n');

  /* 1. Chatwoot 服务 */
  const health = await probe(`${CW}/health`);
  if (health.ok) line(PASS, 'Chatwoot 服务', `${CW}/health → ${health.status}`);
  else line(FAIL, 'Chatwoot 服务', `${CW} 无响应（${health.error || 'HTTP ' + health.status}）→ docker compose up -d`);

  /* 2. Widget 资源与凭据 */
  if (health.ok) {
    const sdk = await probe(`${CW}/packs/js/sdk.js`);
    if (sdk.ok) line(PASS, '客服组件资源', `sdk.js 可加载`);
    else line(FAIL, '客服组件资源', `sdk.js 拉取失败（HTTP ${sdk.status}）→ 镜像可能未预编译前端资源`);

    const w = await probe(`${CW}/api/v1/widget/config?website_token=${WEB_TOKEN}`, {
      method: 'POST',
      json: {},
      expectJson: true
    });
    const cfg = w.body && w.body.website_channel_config;
    if (w.ok && cfg) {
      const jwt = jwtPayload(cfg.auth_token);
      const inbox = jwt && jwt.inbox_id ? `inbox_id=${jwt.inbox_id}` : 'inbox 未知';
      line(PASS, '客服组件(widget)', `token 有效 · ${inbox} · api_host=${cfg.api_host}`);
      const localIps = localIPv4();
      let apiHostName = '';
      try { apiHostName = new URL(cfg.api_host).hostname; } catch (_) { /* ignore */ }
      const onlyLoopback = ['localhost', '127.0.0.1', '::1'].includes(apiHostName);
      if (onlyLoopback && localIps.length) {
        line(WARN, 'FRONTEND_URL', `api_host=${cfg.api_host} 只有本机浏览器能用 → 别人在演示页发消息会失败`);
        console.log(`                       → 改 Desktop\\chatwoot-local\\.env:  FRONTEND_URL=http://${localIps[0]}:3000`);
        console.log('                         再执行  docker compose up -d chatwoot sidekiq');
      } else {
        line(PASS, 'FRONTEND_URL', `api_host=${cfg.api_host}（本机与局域网设备均可收发）`);
      }
    } else {
      line(FAIL, '客服组件(widget)', `配置拉取失败（HTTP ${w.status}）→ 检查 website_token 是否正确`);
    }
  } else {
    line(SKIP, '客服组件(widget)', '跳过（Chatwoot 未就绪）');
  }

  /* 3. 演示页 */
  const demoUrl = `http://127.0.0.1:${DEMO_PORT}/`;
  const demo = await probe(demoUrl, { timeout: 3000 });
  if (demo.ok) {
    let mine = false;
    try {
      const html = await (await fetch(demoUrl, { signal: AbortSignal.timeout(3000) })).text();
      mine = html.includes('云仓优选');
    } catch (_) { /* ignore */ }
    if (mine) line(PASS, '演示页', `${demoUrl} 已就绪`);
    else line(WARN, '演示页', `端口 ${DEMO_PORT} 被其他服务占了（不是本演示页）→ PORT=8090 node serve.js`);
  } else {
    line(FAIL, '演示页', '未启动 → 另开一个终端运行：node serve.js');
  }

  /* 4. 可选组件 */
  const opt = [
    ['话术助手 (8787)', 'http://127.0.0.1:8787/healthz'],
    ['自动回复机器人 (8788)', 'http://127.0.0.1:8788/healthz']
  ];
  for (const [label, url] of opt) {
    const r = await probe(url, { timeout: 2500 });
    if (r.status) line(PASS, label, `在运行（HTTP ${r.status}）`);
    else line(SKIP, label, '未启动（演示可不依赖）');
  }

  /* 5. 地址建议 */
  const ips = localIPv4();
  console.log('\n--- 本机可用地址 ---');
  console.log(`  本机演示   http://localhost:${DEMO_PORT}/`);
  ips.forEach((ip) => console.log(`  局域网/公网  http://${ip}:${DEMO_PORT}/`));
  if (!ips.length) console.log('  （未检测到非回环 IPv4）');

  console.log('\n--- 用它人机器演示时，Chatwoot 侧需要改的配置 ---');
  if (ips.length) {
    const ip = ips[0];
    console.log(`  Chatwoot .env:  FRONTEND_URL=http://${ip}:3000`);
    console.log(`  改完执行:       docker compose up -d chatwoot sidekiq   （或重启对应服务）`);
    console.log(`  然后打开:       http://${ip}:3000  确认后台正常，再回到演示页`);
  } else {
    console.log('  未检测到局域网 IP，若仅本机演示则无需改动（FRONTEND_URL 用 localhost 即可）');
  }

  console.log('\n--- 上传公网演示（可选）---');
  console.log('  先确认阿里云安全组放行了 ' + DEMO_PORT + ' 与 3000 端口（非 80/443 不需要备案）');
  console.log('  然后用公网 IP 打开演示页即可；微信真实回调则需 cpolar/natapp 临时域名。\n');

  const critical = [health.ok, demo.ok].filter(Boolean).length;
  console.log(critical === 2 ? '结论：核心链路就绪，可以开演 🎬\n' : `结论：还有 ${2 - critical} 项核心检查未通过，按上面提示处理后重跑本脚本。\n`);
})();
