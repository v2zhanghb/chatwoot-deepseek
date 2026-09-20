import path from 'node:path';

/**
 * 读取环境变量 → 配置对象（纯函数，便于测试注入）
 */
export function loadConfig(env = process.env) {
  const mode = String(env.WECHAT_MODE || 'mock').toLowerCase();
  const rawInboxId = String(env.CHATWOOT_INBOX_ID || '').trim();
  return {
    port: Number(env.PORT || 8789),
    // mock：不调真实微信接口，"出微信"的消息写进本地 outbox 供验证
    // real：走 qyapi.weixin.qq.com 真实收发
    mode: mode === 'real' ? 'real' : 'mock',
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    // contact_inbox.source_id 前缀，用于识别"这条会话属于本桥接"
    sourceIdPrefix: env.SOURCE_ID_PREFIX || 'wxkf',
    chatwoot: {
      baseUrl: String(env.CHATWOOT_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
      accountId: String(env.CHATWOOT_ACCOUNT_ID || '1'),
      apiToken: env.CHATWOOT_API_TOKEN || '',
      // 数字型收件箱 id，空字符串表示未配置
      inboxId: /^\d+$/.test(rawInboxId) ? Number(rawInboxId) : '',
      // API 渠道的 secret，用于校验 Chatwoot → 桥接 的 X-Chatwoot-Signature；留空则跳过校验
      channelSecret: env.CHATWOOT_CHANNEL_SECRET || '',
      timeoutMs: Number(env.CHATWOOT_TIMEOUT_MS || 10000)
    },
    wechat: {
      corpId: env.WECHAT_CORP_ID || '',
      kfSecret: env.WECHAT_KF_SECRET || '',
      token: env.WECHAT_TOKEN || '',
      encodingAesKey: env.WECHAT_ENCODING_AES_KEY || '',
      apiBase: String(env.WECHAT_API_BASE || 'https://qyapi.weixin.qq.com').replace(/\/+$/, ''),
      timeoutMs: Number(env.WECHAT_TIMEOUT_MS || 10000)
    }
  };
}

/**
 * 启动前自检：把致命缺失项一次列清楚，而不是等第一条消息进来才报错
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.chatwoot.apiToken) errors.push('CHATWOOT_API_TOKEN 未配置（需要管理员 access_token）');
  if (!config.chatwoot.inboxId) errors.push('CHATWOOT_INBOX_ID 未配置（先跑 npm run setup 创建 API 渠道）');
  if (!config.chatwoot.channelSecret) warnings.push('CHATWOOT_CHANNEL_SECRET 未配置，将跳过渠道 webhook 签名校验');

  if (config.mode === 'real') {
    if (!config.wechat.corpId) errors.push('WECHAT_CORP_ID 未配置');
    if (!config.wechat.kfSecret) errors.push('WECHAT_KF_SECRET 未配置');
    if (!config.wechat.token) errors.push('WECHAT_TOKEN 未配置（微信客服回调 Token）');
    if (!config.wechat.encodingAesKey) errors.push('WECHAT_ENCODING_AES_KEY 未配置（43 位）');
  }

  return { errors, warnings };
}
