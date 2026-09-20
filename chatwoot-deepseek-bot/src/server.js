'use strict';

/**
 * Chatwoot DeepSeek 自动回复机器人 (AgentBot)
 *
 * 工作方式（基于 Chatwoot AgentBot 机制）：
 * - 绑定到「官网客服」收件箱后，新会话自动进入 pending 状态
 * - Chatwoot 把 message_created 事件 POST 到本服务 /webhook
 * - 仅处理「pending 会话中的访客(incoming)公开文本消息」：
 *     · 坐席消息(outgoing)、私密备注、系统消息一律忽略（天然防自激）
 *     · 会话被坐席接管(open)后不再自动回复；坐席可再转回 pending 交还机器人
 * - 回复历史用管理员 token 拉取，回复发送用 bot token（访客看到机器人身份）
 * - 幂等：同一消息 id 只处理一次（Chatwoot 失败会重试投递）
 * - 零运行时依赖：Node 18+ 内置 http / fetch / crypto
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* 环境与配置                                                          */
/* ------------------------------------------------------------------ */

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key || key in process.env) continue;
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

function config(overrides) {
  const env = Object.assign({}, process.env, overrides || {});
  return {
    port: Number(env.PORT) || 8788,
    host: env.HOST || '0.0.0.0',
    apiKey: (env.DEEPSEEK_API_KEY || '').trim(),
    model: (env.DEEPSEEK_MODEL || 'deepseek-chat').trim(),
    baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    timeoutMs: Number(env.DEEPSEEK_TIMEOUT_MS) || 30000,
    chatwootUrl: (env.CHATWOOT_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    accountId: Number(env.CHATWOOT_ACCOUNT_ID) || 1,
    adminToken: (env.CHATWOOT_ADMIN_TOKEN || '').trim(),
    botToken: (env.CHATWOOT_BOT_TOKEN || '').trim(),
    webhookSecret: (env.BOT_WEBHOOK_SECRET || '').trim(),
    maxContextMessages: Math.max(1, Number(env.MAX_CONTEXT_MESSAGES) || 20),
    inboxAllowlist: (env.INBOX_ALLOWLIST || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  };
}

const SYSTEM_PROMPT = [
  '你是网站「官网客服」的 AI 客服助手，代表商家直接回复访客的提问。',
  '要求：语气友好、专业、简洁；单条回复一般不超过 120 字；直接回答，不要解释、不要 markdown、不要称呼前缀。',
  '严禁编造具体信息（订单状态、物流进度、价格承诺、库存等）；缺少必要信息时礼貌引导访客补充（如订单号）。',
  '遇到退款、投诉、纠纷或明显超出自助范围的复杂问题，建议访客等待人工客服跟进。',
  '访客使用英文则用英文回复，否则用中文。',
].join(' ');

/* ------------------------------------------------------------------ */
/* 消息清洗                                                            */
/* ------------------------------------------------------------------ */

const INCOMING = new Set([0, 'incoming']);
const OUTGOING = new Set([1, 'outgoing']);

function isPublicText(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.private === true || m.private === 1 || m.private === 'true') return false;
  const ct = m.content_type;
  if (ct !== undefined && ct !== null && ct !== '' && ct !== 'text') return false;
  const mt = m.message_type !== undefined ? m.message_type : m.type;
  if (!(INCOMING.has(mt) || OUTGOING.has(mt))) return false;
  return typeof m.content === 'string' && m.content.trim().length > 0;
}

function toRole(m) {
  const mt = m.message_type !== undefined ? m.message_type : m.type;
  return OUTGOING.has(mt) ? 'assistant' : 'user';
}

function sanitizeHistory(raw, maxMessages) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = raw.length - 1; i >= 0 && out.length < maxMessages; i--) {
    const m = raw[i];
    if (!isPublicText(m)) continue;
    let content = m.content.trim();
    if (content.length > 2000) content = content.slice(-2000);
    out.push({ role: toRole(m), content });
  }
  return out.reverse();
}

/* ------------------------------------------------------------------ */
/* Chatwoot API                                                        */
/* ------------------------------------------------------------------ */

function chatwootFetch(cfg, pathname, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  opts.headers['Content-Type'] = 'application/json';
  return fetch(`${cfg.chatwootUrl}${pathname}`, opts);
}

async function fetchConversationHistory(cfg, conversationId) {
  const resp = await chatwootFetch(
    cfg,
    `/api/v1/accounts/${cfg.accountId}/conversations/${conversationId}/messages`,
    { headers: { api_access_token: cfg.adminToken } }
  );
  if (!resp.ok) throw new Error(`fetch history HTTP ${resp.status}`);
  const data = await resp.json().catch(() => ({}));
  return Array.isArray(data.payload) ? data.payload : [];
}

async function sendBotReply(cfg, conversationId, content) {
  const resp = await chatwootFetch(
    cfg,
    `/api/v1/accounts/${cfg.accountId}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: { api_access_token: cfg.botToken },
      body: JSON.stringify({ content, message_type: 'outgoing', private: false }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`send reply HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ */
/* DeepSeek                                                            */
/* ------------------------------------------------------------------ */

async function callDeepSeek(cfg, messages, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const resp = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.7,
        max_tokens: 300,
        stream: false,
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || `DeepSeek HTTP ${resp.status}`;
      throw new Error(msg);
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return (content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(history) {
  const lines = history.map((m) => `${m.role === 'assistant' ? '客服' : '访客'}: ${m.content}`);
  return [
    '以下是当前会话记录（你是客服）：',
    ...lines,
    '请直接输出给访客的下一条回复：',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 幂等去重                                                            */
/* ------------------------------------------------------------------ */

function createDeduper(max) {
  const seen = new Map(); // id -> timestamp
  return {
    has(id) {
      return seen.has(id);
    },
    mark(id) {
      seen.set(id, Date.now());
      if (seen.size <= max) return;
      // 淘汰最旧的 20%
      const keys = [...seen.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < Math.floor(max * 0.2); i++) seen.delete(keys[i][0]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* webhook 校验                                                        */
/* ------------------------------------------------------------------ */

function verifySignature(cfg, headers, rawBody) {
  if (!cfg.webhookSecret) return true; // 未配置则不校验（本机调试模式）
  const ts = headers['x-chatwoot-timestamp'];
  const sig = headers['x-chatwoot-signature'];
  if (!ts || !sig) return false;
  const expected = 'sha256=' +
    crypto.createHmac('sha256', cfg.webhookSecret).update(`${ts}.${rawBody}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* webhook 处理                                                        */
/* ------------------------------------------------------------------ */

function shouldHandle(cfg, payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad payload' };
  if (payload.event !== 'message_created') return { ok: false, reason: 'not message_created' };
  if (payload.private === true || payload.private === 1) return { ok: false, reason: 'private note' };
  const ct = payload.content_type;
  if (ct !== undefined && ct !== null && ct !== '' && ct !== 'text') {
    return { ok: false, reason: `content_type=${ct}` };
  }
  const mt = payload.message_type;
  if (!(mt === 0 || mt === 'incoming')) return { ok: false, reason: 'not incoming' };
  if (typeof payload.content !== 'string' || !payload.content.trim()) {
    return { ok: false, reason: 'empty content' };
  }
  const conv = payload.conversation || {};
  if (conv.status !== 'pending') return { ok: false, reason: `status=${conv.status || 'unknown'}` };
  if (!Number.isFinite(Number(conv.id))) return { ok: false, reason: 'no conversation id' };
  const allow = (cfg && cfg.inboxAllowlist) || [];
  if (allow.length && !allow.includes(Number(conv.inbox_id))) {
    return { ok: false, reason: 'inbox not allowlisted' };
  }
  return { ok: true, conversationId: Number(conv.id), messageId: payload.id };
}

function createServer(opts) {
  const cfg = config(opts);
  const deduper = createDeduper(2000);
  const stats = { received: 0, handled: 0, replied: 0, skipped: 0, errors: 0 };
  const fetchImpl = (opts && opts.deepSeekFetch) || undefined;

  async function processWebhook(cfg, payload) {
    const check = shouldHandle(cfg, payload);
    if (!check.ok) {
      stats.skipped += 1;
      return { handled: false, reason: check.reason };
    }
    const { conversationId, messageId } = check;
    if (deduper.has(messageId)) return { handled: false, reason: 'duplicate' };
    deduper.mark(messageId);
    stats.handled += 1;

    if (!cfg.apiKey) throw new Error('DEEPSEEK_API_KEY not configured');
    if (!cfg.adminToken) throw new Error('CHATWOOT_ADMIN_TOKEN not configured');
    if (!cfg.botToken) throw new Error('CHATWOOT_BOT_TOKEN not configured');

    const raw = await fetchConversationHistory(cfg, conversationId);
    const history = sanitizeHistory(raw, cfg.maxContextMessages);
    if (!history.length) return { handled: false, reason: 'no usable history' };

    const reply = await callDeepSeek(
      cfg,
      [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildPrompt(history) }],
      fetchImpl
    );
    if (!reply) return { handled: false, reason: 'empty reply from deepseek' };

    await sendBotReply(cfg, conversationId, reply.slice(0, 2000));
    stats.replied += 1;
    return { handled: true, conversationId, reply: reply.slice(0, 120) };
  }

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 512 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      try {
        if (req.method === 'GET' && url.pathname === '/healthz') {
          return send(res, 200, { ok: true, stats });
        }
        if (req.method === 'POST' && url.pathname === '/webhook') {
          if (!verifySignature(cfg, req.headers, rawBody)) {
            return send(res, 401, { error: 'invalid signature' });
          }
          let payload = null;
          try { payload = rawBody ? JSON.parse(rawBody) : null; } catch (_) { payload = null; }
          stats.received += 1;
          // 立即返回 200，异步处理（Chatwoot 失败重试会导致重复投递，已做幂等）
          processWebhook(cfg, payload).catch((e) => {
            stats.errors += 1;
            console.error('[bot] process error:', e && e.message ? e.message : e);
          });
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'not found' });
      } catch (e) {
        stats.errors += 1;
        return send(res, 500, { error: (e && e.message) || 'internal error' });
      }
    });
    req.on('error', () => {});
  });

  return { server, processWebhook, stats, config: cfg };
}

/* ------------------------------------------------------------------ */
/* 启动入口                                                            */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const { server, config: cfg } = createServer();
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[chatwoot-deepseek-bot] listening on http://${cfg.host}:${cfg.port}`);
    console.log(`[chatwoot-deepseek-bot] chatwoot=${cfg.chatwootUrl} account=${cfg.accountId} model=${cfg.model}`);
  });
}

module.exports = { createServer, shouldHandle, sanitizeHistory, buildPrompt, verifySignature, config };
