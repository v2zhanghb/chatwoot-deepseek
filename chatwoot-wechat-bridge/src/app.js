import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridge } from './bridge.js';
import { createChatwootClient } from './chatwoot.js';
import { createLogger } from './logger.js';
import { createStore } from './store.js';
import { computeSignature, createWeChatClient, decryptMessage, parseXmlFields, safeEqual } from './wechat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 校验 Chatwoot → 桥接 的签名：sha256=HMAC_SHA256(secret, `${ts}.${rawBody}`) */
export function verifyChatwootSignature({ secret, timestamp, signature, rawBody }) {
  if (!secret) return { ok: true, skipped: true };
  if (!timestamp || !signature) return { ok: false, reason: 'missing headers' };
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  return { ok: safeEqual(expected, signature), reason: 'signature mismatch' };
}

export function createApp(config, deps = {}) {
  const logger = deps.logger || createLogger();
  const fetchImpl = deps.fetchImpl || fetch;
  const store = deps.store || createStore(config.dataDir);
  const chatwoot = createChatwootClient(config, { logger, fetchImpl });
  const wechat = createWeChatClient(config, { store, logger, fetchImpl });
  const bridge = createBridge({ config, chatwoot, wechat, store, logger });

  const stats = { incoming: 0, outgoing: 0, errors: 0, callbacks: 0 };

  /** 异步处理，失败只记日志（微信要求 5 秒内响应，不能阻塞） */
  const runAsync = (label, fn) => {
    Promise.resolve()
      .then(fn)
      .catch((error) => {
        stats.errors += 1;
        logger.error(`${label} 处理失败: ${error.message}`);
      });
  };

  /** 处理一条微信客服消息（供真实回调与 mock 共用） */
  async function ingestWeChatMessage(message) {
    stats.incoming += 1;
    return bridge.handleIncoming(message);
  }

  /** 微信客服"事件通知 + 拉取"：拿 token 调 sync_msg 拉真实消息 */
  async function pullWeChatMessages({ token, openKfId }) {
    let cursor = store.getCursor();
    let guard = 0;
    do {
      const data = await wechat.syncMsg({ token, cursor, openKfId });
      store.setCursor(data.next_cursor || '');
      const list = data.msg_list || [];
      logger.debug(`sync_msg 拉到 ${list.length} 条（has_more=${data.has_more}）`);

      for (const item of list) {
        if (Number(item.origin) !== 3) continue; // 3 = 微信客户发送
        if (item.msgtype !== 'text') {
          await ingestWeChatMessage({
            openKfId: item.open_kfid || openKfId,
            externalUserId: item.external_userid,
            content: item.text?.content,
            msgId: item.msgid,
            msgType: item.msgtype
          });
          continue;
        }
        await ingestWeChatMessage({
          openKfId: item.open_kfid || openKfId,
          externalUserId: item.external_userid,
          content: item.text?.content,
          msgId: item.msgid,
          msgType: 'text'
        });
      }

      cursor = data.next_cursor || '';
      guard += 1;
    } while (cursor && guard < 20);
  }

  /** 真实微信客服回调（GET=URL 校验，POST=消息推送） */
  async function handleWeChatCallback(req, res, url) {
    const params = Object.fromEntries(url.searchParams.entries());
    const { msg_signature: msgSignature, timestamp, nonce, echostr: echoStr } = params;

    if (config.wechat.token) {
      const expected = computeSignature({
        token: config.wechat.token,
        timestamp,
        nonce,
        encrypt: req.method === 'GET' ? echoStr || '' : ''
      });
      // POST 时校验需要用到 body 里的 Encrypt，放到下面解析后校验
      if (req.method === 'GET' && !safeEqual(expected, msgSignature || '')) {
        logger.warn('微信回调 GET 校验签名不通过');
        res.writeHead(401).end('signature mismatch');
        return;
      }
    }

    if (req.method === 'GET') {
      try {
        const { message } = decryptMessage(config.wechat.encodingAesKey, echoStr);
        logger.info('微信回调 URL 校验通过');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(message);
      } catch (error) {
        logger.warn(`echostr 解密失败（可能未配置 AESKey）：${error.message}`);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(echoStr || '');
      }
      return;
    }

    const rawBody = await readBody(req);
    let fields = parseXmlFields(rawBody);

    if (fields.Encrypt) {
      if (config.wechat.token) {
        const expected = computeSignature({
          token: config.wechat.token,
          timestamp,
          nonce,
          encrypt: fields.Encrypt
        });
        if (!safeEqual(expected, msgSignature || '')) {
          logger.warn('微信回调 POST 校验签名不通过');
          res.writeHead(401).end('signature mismatch');
          return;
        }
      }
      const { message } = decryptMessage(config.wechat.encodingAesKey, fields.Encrypt);
      fields = parseXmlFields(message);
    }

    stats.callbacks += 1;
    // 先回 200，再异步处理（微信要求 5s 内响应）
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');

    const event = String(fields.Event || '');
    const msgType = String(fields.MsgType || '');

    if (msgType === 'event' && event.toLowerCase() === 'kf_msg_or_event') {
      runAsync('微信消息拉取', () =>
        pullWeChatMessages({ token: fields.Token, openKfId: fields.OpenKfId })
      );
      return;
    }

    if (msgType === 'text' || msgType === 'image' || msgType === 'voice' || msgType === 'file') {
      runAsync('微信消息入站', () =>
        ingestWeChatMessage({
          openKfId: fields.OpenKfId,
          externalUserId: fields.FromUserName,
          content: fields.Content,
          msgId: fields.MsgId,
          msgType
        })
      );
      return;
    }

    logger.debug(`忽略未处理的微信回调：MsgType=${msgType} Event=${event}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      // ---------- 健康检查 ----------
      if (req.method === 'GET' && pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          mode: config.mode,
          inboxId: config.chatwoot.inboxId,
          mappings: Object.keys(store.allMappings()).length,
          outbox: store.listOutbound().length,
          stats
        });
      }

      // ---------- 模拟微信用户发消息 ----------
      if (req.method === 'POST' && pathname === '/mock/wechat') {
        const rawBody = await readBody(req);
        let payload = {};
        const contentType = String(req.headers['content-type'] || '');
        if (contentType.includes('application/json')) {
          payload = rawBody ? JSON.parse(rawBody) : {};
        } else {
          payload = Object.fromEntries(new URLSearchParams(rawBody).entries());
        }

        const message = {
          openKfId: payload.open_kfid || payload.openKfId || 'wkMOCK001',
          externalUserId: payload.external_userid || payload.externalUserId || 'wmMOCKUSER001',
          content: payload.content || payload.text || '',
          msgId: payload.msgid || payload.msgId || `mock-${Date.now()}`,
          msgType: payload.msgtype || 'text'
        };
        if (!message.content) return sendJson(res, 400, { error: 'content 不能为空' });

        const result = await ingestWeChatMessage(message);
        return sendJson(res, 200, { ok: true, message, result });
      }

      // ---------- 查看"出微信"的消息 ----------
      if (req.method === 'GET' && pathname === '/mock/outbox') {
        return sendJson(res, 200, { mode: config.mode, count: store.listOutbound().length, items: store.listOutbound() });
      }

      // ---------- 查看映射状态 ----------
      if (req.method === 'GET' && pathname === '/mock/state') {
        return sendJson(res, 200, {
          mode: config.mode,
          cursor: store.getCursor(),
          mappings: store.allMappings(),
          stats
        });
      }

      if (req.method === 'POST' && pathname === '/mock/reset') {
        store.reset();
        return sendJson(res, 200, { ok: true, message: '状态已清空（映射/游标/outbox/去重）' });
      }

      // ---------- 微信客服真实回调 ----------
      if ((req.method === 'GET' || req.method === 'POST') && pathname === '/wechat/callback') {
        return await handleWeChatCallback(req, res, url);
      }

      // ---------- Chatwoot 渠道 webhook（坐席/机器人回复）----------
      if (req.method === 'POST' && pathname === '/chatwoot/webhook') {
        const rawBody = await readBody(req);
        const check = verifyChatwootSignature({
          secret: config.chatwoot.channelSecret,
          timestamp: req.headers['x-chatwoot-timestamp'],
          signature: req.headers['x-chatwoot-signature'],
          rawBody
        });
        if (!check.ok) {
          logger.warn(`Chatwoot webhook 签名校验失败：${check.reason}`);
          return sendJson(res, 401, { error: 'invalid signature' });
        }

        let payload;
        try {
          payload = JSON.parse(rawBody || '{}');
        } catch {
          return sendJson(res, 400, { error: 'invalid json' });
        }

        const result = await bridge.handleChatwootEvent(payload);
        if (result?.sent) stats.outgoing += 1;
        return sendJson(res, 200, { ok: true, result });
      }

      // ---------- 模拟测试页 ----------
      if (req.method === 'GET' && (pathname === '/mock' || pathname === '/mock/')) {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'mock.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          `<meta charset="utf-8"><h2>微信客服 ↔ Chatwoot 桥接</h2>
           <p>模式：<b>${config.mode}</b>　收件箱 ID：<b>${config.chatwoot.inboxId || '(未配置)'}</b></p>
           <ul>
             <li><a href="/mock">模拟微信用户发消息（测试页）</a></li>
             <li><a href="/mock/outbox">查看"发往微信"的消息</a></li>
             <li><a href="/mock/state">查看会话映射</a></li>
             <li><a href="/healthz">健康检查</a></li>
           </ul>
           <p>真实回调地址：<code>POST /wechat/callback</code>　Chatwoot 渠道 webhook：<code>POST /chatwoot/webhook</code></p>`
        );
      }

      return sendJson(res, 404, { error: 'not found', pathname });
    } catch (error) {
      stats.errors += 1;
      logger.error(`${req.method} ${pathname} 异常: ${error.message}`);
      return sendJson(res, 500, { error: error.message });
    }
  });

  return { server, bridge, store, chatwoot, wechat, logger, config, stats };
}
