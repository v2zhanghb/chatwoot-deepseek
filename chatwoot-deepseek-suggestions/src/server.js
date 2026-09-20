'use strict';

/**
 * Chatwoot DeepSeek 话术推荐助手 (Dashboard App)
 *
 * - 只把「最近 N 条公开文本消息」送给 DeepSeek
 * - 私密备注(private)、附件、表单卡片、input_email 等一律丢弃
 * - 联系人的邮箱/电话/自定义属性等敏感字段，前后端都不进入请求体
 * - 仅推荐话术，由坐席审阅后复制发送，不会自动回复
 * - 零运行时依赖：Node 18+ 内置 http / fetch 即可运行
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const kb = require('./kb');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* ------------------------------------------------------------------ */
/* 环境与配置                                                          */
/* ------------------------------------------------------------------ */

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return; // 无 .env 文件则仅用进程环境变量
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key || key in process.env) continue; // 不覆盖已存在的环境变量
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
    port: Number(env.PORT) || 8787,
    host: env.HOST || '0.0.0.0',
    apiKey: (env.DEEPSEEK_API_KEY || '').trim(),
    model: (env.DEEPSEEK_MODEL || 'deepseek-chat').trim(),
    baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    timeoutMs: Number(env.DEEPSEEK_TIMEOUT_MS) || 30000,
    appOrigin: (env.APP_ORIGIN || 'http://localhost:8787').replace(/\/+$/, ''),
    chatwootOrigins: (env.CHATWOOT_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    maxMessages: Math.max(1, Number(env.MAX_CONTEXT_MESSAGES) || 24),
  };
}

function allowedOrigins(cfg) {
  const set = new Set([cfg.appOrigin]);
  for (const o of cfg.chatwootOrigins) set.add(o);
  return set;
}

/* ------------------------------------------------------------------ */
/* 消息清洗：只保留公开文本，绝不含联系人或私密字段                    */
/* ------------------------------------------------------------------ */

const INCOMING = new Set([0, 'incoming']);
const OUTGOING = new Set([1, 'outgoing']);

function isPublicTextMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.private === true || m.private === 1 || m.private === 'true') return false;

  // 只处理普通文本消息（忽略卡片/表单/input_email/location/attachments 等）
  const ct = m.content_type;
  if (ct !== undefined && ct !== null && ct !== '' && ct !== 'text') return false;

  const mt = m.message_type !== undefined ? m.message_type : m.type;
  if (!(INCOMING.has(mt) || OUTGOING.has(mt))) return false;

  if (typeof m.content !== 'string' || !m.content.trim()) return false;
  return true;
}

function contentToRole(m) {
  const mt = m.message_type !== undefined ? m.message_type : m.type;
  return OUTGOING.has(mt) ? 'assistant' : 'user';
}

/**
 * 清洗聊天记录 → [{role:'user'|'assistant', content}]，仅公开文本。
 * 新消息在前，最多保留 maxMessages 条，单条超长截断。
 */
function sanitizeMessages(raw, maxMessages) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = raw.length - 1; i >= 0 && out.length < maxMessages; i--) {
    const m = raw[i];
    if (!isPublicTextMessage(m)) continue;
    let content = m.content.trim();
    if (content.length > 3000) content = content.slice(-3000);
    if (!content) continue;
    out.push({ role: contentToRole(m), content });
  }
  return out.reverse(); // 恢复时间正序
}

/* ------------------------------------------------------------------ */
/* Prompt 与 DeepSeek 调用                                             */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = [
  '你是客户服务坐席的「话术写作助手」。根据给出的会话上下文，生成 1-3 条坐席可以直接发送给客户的回复草稿。',
  '会话下方可能附有知识库标准答复作为参考资料：若与客户问题相关，必须以参考资料为准作答，不得编造超出参考资料的政策细节（如时效、金额、流程）。',
  '参考资料没有覆盖的信息，可以正常基于常识表达，但不要虚构具体的业务数据；信息不足时，建议引导客户补充必要信息。',
  '要求：语气自然、专业、简洁，单条建议一般不超过 120 字；直接可用、可复制；不要解释、不要前言、不要 markdown 代码块。',
  '如果客户使用英文，则用英文输出，否则用中文输出。',
  '只输出一个 JSON 对象，格式：{"suggestions":["建议1","建议2","建议3"]}。',
].join(' ');

function buildTranscript(messages) {
  const lines = messages.map((m) => {
    const who = m.role === 'assistant' ? '坐席' : '客户';
    return `${who}: ${m.content}`;
  });
  return ['以下是最近的会话记录：', ...lines].join('\n');
}

/**
 * 生成 DeepSeek 输入：
 * - 取最后一条客户消息 + 整段会话做知识库检索，命中的 FAQ 作为参考资料注入
 * - 返回 { messages, refs }
 */
function buildDeepSeekMessages(messages) {
  const queryParts = [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser) queryParts.push(lastUser.content);
  queryParts.push(messages.map((m) => m.content).join(' '));
  const hits = kb.searchFaq(queryParts.join('\n'), { topK: 3 });

  const userContent = hits.length
    ? `${kb.buildReferenceText(hits)}\n\n${buildTranscript(messages)}`
    : buildTranscript(messages);

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    refs: hits.map((h) => ({ id: h.faq.id, question: h.faq.question, score: Number(h.score.toFixed(3)) })),
  };
}

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
        max_tokens: 800,
        response_format: { type: 'json_object' },
        stream: false,
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data && (data.error && data.error.message)) || `DeepSeek HTTP ${resp.status}`;
      throw new Error(msg);
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return content || '';
  } finally {
    clearTimeout(timer);
  }
}

function parseSuggestions(content) {
  if (!content) return [];
  let text = String(content).trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/g, '').replace(/```\s*$/g, '').trim();
  }
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    // 兼容模型偶尔输出多余前后文的情况：提取最外层 JSON
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { obj = JSON.parse(text.slice(start, end + 1)); } catch (_2) { obj = null; }
    }
  }
  if (!obj || !Array.isArray(obj.suggestions)) return [];
  return obj.suggestions
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim())
    .slice(0, 3);
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, status, obj, extraHeaders) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const headers = {
    'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(body);
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(opts) {
  const cfg = config(opts);
  const allowed = allowedOrigins(cfg);
  const fetchImpl = (opts && opts.deepSeekFetch) || undefined;

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      const frameAncestors = cfg.chatwootOrigins.length
        ? cfg.chatwootOrigins.join(' ')
        : "'self'";
      send(res, 200, data.toString('utf8'), {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        // 用 CSP frame-ancestors 控制可嵌入来源（不要用 X-Frame-Options，
        // 否则会阻止 Chatwoot 跨源 iframe 嵌入本面板）
        'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
      });
    });
  }

  /** 只读知识库：供 kb-editor.html 载入现网内容。部署在内网/Nginx 后；如需保护请加 Nginx Basic Auth 或移除该路由 */
  function handleKb(res) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(kb.KB_FILE, 'utf8'));
    } catch (e) {
      return send(res, 500, { error: 'kb/faq.json unreadable: ' + e.message });
    }
    if (!doc || !Array.isArray(doc.faqs)) return send(res, 500, { error: 'kb/faq.json invalid' });
    return send(res, 200, {
      version: doc.version || 'v1',
      updatedAt: doc.updatedAt || null,
      note: doc.note || '',
      count: doc.faqs.length,
      faqs: doc.faqs,
    });
  }

  async function handleSuggest(req, res) {
    // 来源保护：仅允许配置中的 Chatwoot 来源或本服务自身来源调用
    const origin = (req.headers.origin || '').replace(/\/+$/, '');
    if (!origin || !allowed.has(origin)) {
      return send(res, 403, { error: 'origin not allowed' });
    }

    let body;
    try {
      body = await readJsonBody(req, 256 * 1024);
    } catch (e) {
      return send(res, 400, { error: e.message === 'invalid JSON' ? 'invalid JSON' : 'payload too large' });
    }

    if (!cfg.apiKey) {
      return send(res, 503, { error: 'DEEPSEEK_API_KEY not configured' });
    }

    // 双保险清洗：即使前端已过滤，服务端仍重新清洗一遍
    let messages = sanitizeMessages(body && body.messages, cfg.maxMessages);
    if (!messages.length && body && typeof body.conversationText === 'string') {
      const text = body.conversationText.trim().slice(0, 6000);
      if (text) messages = [{ role: 'user', content: text }];
    }
    if (!messages.length) {
      return send(res, 400, { error: 'no usable public text messages' });
    }

    let content;
    let refs = [];
    try {
      const built = buildDeepSeekMessages(messages);
      refs = built.refs;
      content = await callDeepSeek(cfg, built.messages, fetchImpl);
    } catch (e) {
      const msg = (e && e.message) || 'deepseek call failed';
      const status = /timed? ?out|abort/i.test(msg) ? 504 : 502;
      return send(res, status, { error: msg });
    }

    const suggestions = parseSuggestions(content);
    if (!suggestions.length) {
      return send(res, 502, { error: 'deepseek returned no usable suggestions' });
    }

    return send(res, 200, { suggestions, refs, model: cfg.model, source: 'deepseek' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    try {
      if (req.method === 'GET' && pathname === '/healthz') {
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/kb') {
        return handleKb(res);
      }
      if (req.method === 'GET') {
        if (pathname === '/' || pathname === '/index.html' ||
            pathname === '/app.js' || pathname === '/styles.css' ||
            pathname === '/kb-editor.html') {
          return serveStatic(req, res, pathname);
        }
        return send(res, 404, { error: 'not found' });
      }
      if (req.method === 'POST' && pathname === '/api/suggest') {
        return await handleSuggest(req, res);
      }
      return send(res, 405, { error: 'method not allowed' });
    } catch (e) {
      return send(res, 500, { error: (e && e.message) || 'internal error' });
    }
  });

  return server;
}

/* ------------------------------------------------------------------ */
/* 启动入口                                                            */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const server = createServer();
  server.listen(config().port, config().host, () => {
    // eslint-disable-next-line no-console
    console.log(`[chatwoot-deepseek-suggestions] listening on http://${config().host}:${config().port}`);
  });
}

module.exports = { createServer, sanitizeMessages, parseSuggestions, buildDeepSeekMessages, config };
