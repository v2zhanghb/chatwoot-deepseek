'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { shouldHandle, sanitizeHistory, buildPrompt, verifySignature } = require('../src/server.js');

const base = (over) => Object.assign({
  event: 'message_created',
  id: 101,
  content: '你好，查询一下我的快递到哪了？',
  content_type: 'text',
  message_type: 0,
  private: false,
  conversation: { id: 9, status: 'pending', inbox_id: 3 },
}, over);

test('shouldHandle: 正常的 pending 会话访客消息', () => {
  const r = shouldHandle({}, base());
  assert.ok(r.ok);
  assert.strictEqual(r.conversationId, 9);
  assert.strictEqual(r.messageId, 101);
});

test('shouldHandle: 非 pending（坐席已接管）不处理', () => {
  const r = shouldHandle({}, base({ conversation: { id: 9, status: 'open', inbox_id: 3 } }));
  assert.strictEqual(r.ok, false);
});

test('shouldHandle: 坐席/机器人消息(outgoing)不处理', () => {
  assert.strictEqual(shouldHandle({}, base({ message_type: 1 })).ok, false);
});

test('shouldHandle: 私密备注不处理', () => {
  assert.strictEqual(shouldHandle({}, base({ private: true })).ok, false);
});

test('shouldHandle: 系统活动消息不处理', () => {
  const r = shouldHandle({}, base({ content_type: 'activity', content: '会话已标记' }));
  assert.strictEqual(r.ok, false);
});

test('shouldHandle: 非 message_created 事件不处理', () => {
  assert.strictEqual(shouldHandle({}, base({ event: 'conversation_updated' })).ok, false);
});

test('shouldHandle: 收件箱白名单', () => {
  const cfg = { inboxAllowlist: [3] };
  assert.strictEqual(shouldHandle(cfg, base({ conversation: { id: 9, status: 'pending', inbox_id: 2 } })).ok, false);
  assert.ok(shouldHandle(cfg, base()).ok);
});

test('sanitizeHistory: 过滤私密/活动消息并转换角色', () => {
  const out = sanitizeHistory([
    { message_type: 0, content: '在吗', content_type: 'text' },
    { message_type: 2, content: '系统消息', content_type: 'activity' },
    { message_type: 1, content: '您好', content_type: 'text', private: false },
    { message_type: 1, content: '内部备注', content_type: 'text', private: true },
  ], 20);
  assert.deepStrictEqual(out, [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '您好' },
  ]);
});

test('sanitizeHistory: 限制条数取最近', () => {
  const raw = [];
  for (let i = 0; i < 30; i++) raw.push({ message_type: 0, content: `msg${i}`, content_type: 'text' });
  const out = sanitizeHistory(raw, 5);
  assert.strictEqual(out.length, 5);
  assert.strictEqual(out[4].content, 'msg29');
});

test('buildPrompt: 历史转提示文本', () => {
  const p = buildPrompt([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '您好，请问有什么可以帮您？' },
  ]);
  assert.ok(p.includes('访客: 你好'));
  assert.ok(p.includes('客服: 您好，请问有什么可以帮您？'));
});

test('verifySignature: HMAC 校验通过/拒绝', () => {
  const cfg = { webhookSecret: 's3cret' };
  const body = JSON.stringify(base());
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(`${ts}.${body}`).digest('hex');
  assert.ok(verifySignature(cfg, { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': sig }, body));
  assert.strictEqual(verifySignature(cfg, { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': 'sha256=bad' }, body), false);
  assert.strictEqual(verifySignature(cfg, {}, body), false);
  // 未配置 secret 时不校验
  assert.ok(verifySignature({ webhookSecret: '' }, {}, body));
});
