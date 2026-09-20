/**
 * 一键在 Chatwoot 里创建「微信客服」API 渠道收件箱，并配置渠道 webhook。
 *
 *   node scripts/setup-chatwoot.js                     # 创建（或复用同名）收件箱
 *   node scripts/setup-chatwoot.js --webhook http://host.docker.internal:8789/chatwoot/webhook
 *   node scripts/setup-chatwoot.js --inbox 5           # 只更新已有收件箱的 webhook
 *
 * 需要 .env 里的 CHATWOOT_BASE_URL / CHATWOOT_API_TOKEN（管理员 access_token）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createChatwootClient } from '../src/chatwoot.js';
import { createLogger } from '../src/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '..', '.env');

// 极简 .env 读取（不引入 dotenv 依赖）
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] === undefined) process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}
loadDotEnv(envFile);

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const config = loadConfig(process.env);
const logger = createLogger('info');
const chatwoot = createChatwootClient(config, { logger });

const inboxName = argValue('--name') || '微信客服（桥接）';
const webhookUrl =
  argValue('--webhook') || process.env.BRIDGE_PUBLIC_WEBHOOK_URL || 'http://host.docker.internal:8789/chatwoot/webhook';
const targetInboxId = argValue('--inbox') || config.chatwoot.inboxId;

if (!config.chatwoot.apiToken) {
  console.error('缺少 CHATWOOT_API_TOKEN，请先在 .env 里填管理员 access_token');
  process.exit(1);
}

async function main() {
  let inbox;

  if (targetInboxId) {
    logger.info(`更新已有收件箱 ${targetInboxId} 的 webhook → ${webhookUrl}`);
    inbox = await chatwoot.updateInboxWebhook(targetInboxId, webhookUrl);
  } else {
    const existing = (await chatwoot.listInboxes()).find((item) => item.name === inboxName);
    if (existing) {
      logger.info(`已存在同名收件箱 ${existing.id}，更新其 webhook → ${webhookUrl}`);
      inbox = await chatwoot.updateInboxWebhook(existing.id, webhookUrl);
    } else {
      logger.info(`创建 API 渠道收件箱「${inboxName}」…`);
      inbox = await chatwoot.createApiInbox({ name: inboxName, webhookUrl });
    }
  }

  const channel = inbox.channel || {};
  console.log('\n==================== 结果 ====================');
  console.log(`收件箱 ID       : ${inbox.id}`);
  console.log(`收件箱名称      : ${inbox.name}`);
  console.log(`渠道类型        : ${inbox.channel_type || channel.type || 'Channel::Api'}`);
  console.log(`渠道 webhook    : ${channel.webhook_url || webhookUrl}`);
  console.log(`渠道 secret     : ${channel.secret || '(接口未返回，可在 设置→收件箱→API 渠道 查看，或从数据库 channel_api.secret 读取)'}`);
  console.log('=============================================\n');
  console.log('把下面两行写进 .env：');
  console.log(`CHATWOOT_INBOX_ID=${inbox.id}`);
  if (channel.secret) console.log(`CHATWOOT_CHANNEL_SECRET=${channel.secret}`);
  console.log('');
}

main().catch((error) => {
  console.error(`执行失败：${error.message}`);
  process.exit(1);
});
