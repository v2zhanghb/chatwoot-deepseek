/**
 * 端到端闭环测试（不依赖真实 Chatwoot / 真实微信）：
 *   模拟微信用户发消息 → 桥接 → 假 Chatwoot 收到 incoming 消息
 *   假 Chatwoot 回推坐席回复（带签名）→ 桥接 → outbox 出现"发往微信"的内容
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const CHANNEL_SECRET = 's3cr3t-channel-key';

/** 假 Chatwoot：只实现桥接会用到的 5 个接口 */
function startFakeChatwoot() {
  const state = { contacts: [], contactInboxes: [], conversations: [], messages: [] };
  let nextId = 100;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const json = (payload, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const base = '/api/v1/accounts/1';

    if (req.method === 'GET' && url.pathname === `${base}/contacts/search`) {
      const query = url.searchParams.get('q') || '';
      return json({ payload: state.contacts.filter((c) => c.identifier === query) });
    }

    if (req.method === 'POST' && url.pathname === `${base}/contacts`) {
      const contact = { id: ++nextId, name: body.name, identifier: body.identifier };
      state.contacts.push(contact);
      return json(contact);
    }

    if (req.method === 'POST' && /^\/api\/v1\/accounts\/1\/contacts\/\d+\/contact_inboxes$/.test(url.pathname)) {
      const contactId = Number(url.pathname.split('/')[5]);
      const record = { id: ++nextId, contact_id: contactId, inbox_id: body.inbox_id, source_id: body.source_id };
      state.contactInboxes.push(record);
      return json(record);
    }

    if (req.method === 'POST' && url.pathname === `${base}/conversations`) {
      const conversation = {
        id: ++nextId,
        inbox_id: body.inbox_id,
        contact_id: body.contact_id,
        source_id: body.source_id
      };
      state.conversations.push(conversation);
      return json(conversation);
    }

    if (req.method === 'POST' && /^\/api\/v1\/accounts\/1\/conversations\/\d+\/messages$/.test(url.pathname)) {
      const conversationId = Number(url.pathname.split('/')[6]);
      const message = {
        id: ++nextId,
        conversation_id: conversationId,
        content: body.content,
        message_type: body.message_type
      };
      state.messages.push(message);
      return json(message);
    }

    return json({ error: 'not found', pathname: url.pathname }, 404);
  });

  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('E2E：微信消息进 Chatwoot，坐席回复出微信', async (t) => {
  const fake = startFakeChatwoot();
  const chatwootPort = await listen(fake.server);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxkf-e2e-'));
  const config = loadConfig({
    WECHAT_MODE: 'mock',
    DATA_DIR: dataDir,
    CHATWOOT_BASE_URL: `http://127.0.0.1:${chatwootPort}`,
    CHATWOOT_ACCOUNT_ID: '1',
    CHATWOOT_API_TOKEN: 'test-token',
    CHATWOOT_INBOX_ID: '9',
    CHATWOOT_CHANNEL_SECRET: CHANNEL_SECRET
  });

  const app = createApp(config, { logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const bridgePort = await listen(app.server);

  t.after(() => {
    app.server.close();
    fake.server.close();
  });

  // ---------- ① 微信客户发消息 ----------
  const incomingResponse = await fetch(`http://127.0.0.1:${bridgePort}/mock/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ open_kfid: 'wkABC', external_userid: 'wmUSER001', content: '发货了吗？' })
  });
  const incomingBody = await incomingResponse.json();
  assert.equal(incomingResponse.status, 200);
  assert.equal(incomingBody.result.conversationId, fake.state.conversations[0].id);

  // 假 Chatwoot 侧应看到：联系人、contact_inbox、会话、incoming 消息
  assert.equal(fake.state.contacts.length, 1);
  assert.equal(fake.state.contacts[0].identifier, 'wxkf:wkABC:wmUSER001');
  assert.equal(fake.state.contactInboxes[0].source_id, 'wxkf:wkABC:wmUSER001');
  assert.equal(fake.state.contactInboxes[0].inbox_id, 9);
  assert.equal(fake.state.messages.length, 1);
  assert.equal(fake.state.messages[0].message_type, 'incoming');
  assert.equal(fake.state.messages[0].content, '发货了吗？');

  // ---------- ② 坐席在 Chatwoot 回复 → 渠道 webhook → 桥接 → 微信 ----------
  const conversationId = fake.state.conversations[0].id;
  const payload = JSON.stringify({
    event: 'message_created',
    id: 5001,
    message_type: 'outgoing',
    private: false,
    content: '亲，今天下午发出，48 小时内到货～',
    conversation: {
      id: conversationId,
      contact_inbox: { source_id: 'wxkf:wkABC:wmUSER001' },
      inbox_id: 9
    }
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${crypto.createHmac('sha256', CHANNEL_SECRET).update(`${timestamp}.${payload}`).digest('hex')}`;

  const webhookResponse = await fetch(`http://127.0.0.1:${bridgePort}/chatwoot/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chatwoot-timestamp': timestamp,
      'x-chatwoot-signature': signature
    },
    body: payload
  });
  assert.equal(webhookResponse.status, 200);
  const webhookBody = await webhookResponse.json();
  assert.equal(webhookBody.result.sent, true);

  // ---------- ③ 验证"发往微信"的内容 ----------
  const outbox = await fetch(`http://127.0.0.1:${bridgePort}/mock/outbox`).then((r) => r.json());
  assert.equal(outbox.count, 1);
  assert.equal(outbox.items[0].open_kfid, 'wkABC');
  assert.equal(outbox.items[0].external_userid, 'wmUSER001');
  assert.equal(outbox.items[0].content, '亲，今天下午发出，48 小时内到货～');

  // ---------- ④ 签名不对必须拒绝 ----------
  const badResponse = await fetch(`http://127.0.0.1:${bridgePort}/chatwoot/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chatwoot-timestamp': timestamp,
      'x-chatwoot-signature': 'sha256=deadbeef'
    },
    body: payload
  });
  assert.equal(badResponse.status, 401);

  // ---------- ⑤ 客户第二条消息复用同一会话 ----------
  await fetch(`http://127.0.0.1:${bridgePort}/mock/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ open_kfid: 'wkABC', external_userid: 'wmUSER001', content: '好的谢谢' })
  });
  assert.equal(fake.state.conversations.length, 1, '同一客户不应重复建会话');
  assert.equal(fake.state.messages.length, 2);

  // ---------- ⑥ 健康检查 ----------
  const health = await fetch(`http://127.0.0.1:${bridgePort}/healthz`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'mock');
  assert.equal(health.stats.incoming, 2);
  assert.equal(health.stats.outgoing, 1);
});

test('E2E：真实回调 URL 校验（GET /wechat/callback）返回解密后的 echostr', async (t) => {
  const { encryptMessage, computeSignature } = await import('../src/wechat.js');
  const aesKey = 'b'.repeat(43);
  const token = 'my-callback-token';
  const echoPlain = '1616140317555161061';

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxkf-e2e-cb-'));
  const config = loadConfig({
    WECHAT_MODE: 'mock',
    DATA_DIR: dataDir,
    CHATWOOT_BASE_URL: 'http://127.0.0.1:1',
    CHATWOOT_API_TOKEN: 't',
    CHATWOOT_INBOX_ID: '9',
    WECHAT_TOKEN: token,
    WECHAT_ENCODING_AES_KEY: aesKey
  });

  const app = createApp(config, { logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const port = await listen(app.server);
  t.after(() => app.server.close());

  const encrypt = encryptMessage(aesKey, echoPlain);
  const timestamp = '1700000000';
  const nonce = 'abc123';
  const signature = computeSignature({ token, timestamp, nonce, encrypt });

  const url = `http://127.0.0.1:${port}/wechat/callback?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(encrypt)}`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), echoPlain);

  // 签名错误 → 401
  const badUrl = url.replace(signature, 'f'.repeat(40));
  assert.equal((await fetch(badUrl)).status, 401);
});
