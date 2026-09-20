import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBridge } from '../src/bridge.js';
import { createStore } from '../src/store.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxkf-bridge-'));
}

function buildConfig(overrides = {}) {
  return {
    mode: 'mock',
    sourceIdPrefix: 'wxkf',
    chatwoot: { inboxId: '9', accountId: '1' },
    ...overrides
  };
}

/** 记录调用的假 Chatwoot */
function createFakeChatwoot({ existingContact = null } = {}) {
  const calls = [];
  return {
    calls,
    async upsertContact(payload) {
      calls.push({ op: 'upsertContact', payload });
      return existingContact || { id: 101, identifier: payload.identifier };
    },
    async createContactInbox(contactId, payload) {
      calls.push({ op: 'createContactInbox', contactId, payload });
      return { id: 1, source_id: payload.sourceId };
    },
    async createConversation(payload) {
      calls.push({ op: 'createConversation', payload });
      return { id: 55 };
    },
    async createMessage(conversationId, payload) {
      calls.push({ op: 'createMessage', conversationId, payload });
      return { id: 999 };
    }
  };
}

function createFakeWechat() {
  const sent = [];
  return {
    sent,
    async sendText(payload) {
      sent.push(payload);
      return { errcode: 0 };
    }
  };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('入站：新客户 → 建联系人/会话，消息标记为 incoming', async () => {
  const store = createStore(tempDir());
  const chatwoot = createFakeChatwoot();
  const wechat = createFakeWechat();
  const bridge = createBridge({ config: buildConfig(), chatwoot, wechat, store, logger: silentLogger });

  const result = await bridge.handleIncoming({
    openKfId: 'wkABC',
    externalUserId: 'wmUSER001',
    content: '发货了吗？',
    msgId: 'm-1'
  });

  assert.equal(result.conversationId, 55);
  const ops = chatwoot.calls.map((call) => call.op);
  assert.deepEqual(ops, ['upsertContact', 'createContactInbox', 'createConversation', 'createMessage']);
  assert.equal(chatwoot.calls[0].payload.identifier, 'wxkf:wkABC:wmUSER001');
  assert.equal(chatwoot.calls[1].payload.sourceId, 'wxkf:wkABC:wmUSER001');
  assert.equal(chatwoot.calls[3].payload.messageType, 'incoming');
  assert.equal(chatwoot.calls[3].payload.content, '发货了吗？');
  assert.equal(store.getMapping('wxkf:wkABC:wmUSER001'), 55);
});

test('入站：同一客户第二条消息复用会话，不再新建', async () => {
  const store = createStore(tempDir());
  const chatwoot = createFakeChatwoot();
  const bridge = createBridge({
    config: buildConfig(),
    chatwoot,
    wechat: createFakeWechat(),
    store,
    logger: silentLogger
  });

  await bridge.handleIncoming({ openKfId: 'wkABC', externalUserId: 'wmUSER001', content: '在吗', msgId: 'm-1' });
  await bridge.handleIncoming({ openKfId: 'wkABC', externalUserId: 'wmUSER001', content: '发货了吗', msgId: 'm-2' });

  const created = chatwoot.calls.filter((call) => call.op === 'createConversation');
  assert.equal(created.length, 1, '只应创建一次会话');
  const messages = chatwoot.calls.filter((call) => call.op === 'createMessage');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].conversationId, 55);
});

test('入站：同一条消息重复推送要幂等', async () => {
  const store = createStore(tempDir());
  const chatwoot = createFakeChatwoot();
  const bridge = createBridge({
    config: buildConfig(),
    chatwoot,
    wechat: createFakeWechat(),
    store,
    logger: silentLogger
  });

  await bridge.handleIncoming({ openKfId: 'wkABC', externalUserId: 'wmUSER001', content: 'hi', msgId: 'same' });
  const second = await bridge.handleIncoming({
    openKfId: 'wkABC',
    externalUserId: 'wmUSER001',
    content: 'hi',
    msgId: 'same'
  });

  assert.equal(second.skipped, 'duplicate');
  assert.equal(chatwoot.calls.filter((call) => call.op === 'createMessage').length, 1);
});

test('入站：非文本消息用占位符，不丢事件', async () => {
  const store = createStore(tempDir());
  const chatwoot = createFakeChatwoot();
  const bridge = createBridge({
    config: buildConfig(),
    chatwoot,
    wechat: createFakeWechat(),
    store,
    logger: silentLogger
  });

  await bridge.handleIncoming({
    openKfId: 'wkABC',
    externalUserId: 'wmUSER001',
    msgType: 'image',
    msgId: 'm-img'
  });
  const message = chatwoot.calls.find((call) => call.op === 'createMessage');
  assert.equal(message.payload.content, '[image]');
});

test('出站：坐席 outgoing 消息 → 发往微信', async () => {
  const store = createStore(tempDir());
  const wechat = createFakeWechat();
  const bridge = createBridge({
    config: buildConfig(),
    chatwoot: createFakeChatwoot(),
    wechat,
    store,
    logger: silentLogger
  });

  const result = await bridge.handleChatwootEvent({
    event: 'message_created',
    id: 777,
    message_type: 'outgoing',
    private: false,
    content: '亲，48 小时内发货哦',
    conversation: { id: 55, contact_inbox: { source_id: 'wxkf:wkABC:wmUSER001' } }
  });

  assert.equal(result.sent, true);
  assert.deepEqual(wechat.sent, [
    { openKfId: 'wkABC', externalUserId: 'wmUSER001', content: '亲，48 小时内发货哦' }
  ]);
});

test('出站：incoming / 私密备注 / 非本渠道 / 空内容 都要跳过', async () => {
  const store = createStore(tempDir());
  const wechat = createFakeWechat();
  const bridge = createBridge({
    config: buildConfig(),
    chatwoot: createFakeChatwoot(),
    wechat,
    store,
    logger: silentLogger
  });

  const base = {
    event: 'message_created',
    id: 1,
    message_type: 'outgoing',
    private: false,
    content: 'hello',
    conversation: { id: 55, contact_inbox: { source_id: 'wxkf:wkABC:wmUSER001' } }
  };

  assert.equal((await bridge.handleChatwootEvent({ ...base, id: 11, message_type: 'incoming' })).skipped, 'not_outgoing');
  assert.equal((await bridge.handleChatwootEvent({ ...base, id: 12, private: true })).skipped, 'private');
  assert.equal(
    (await bridge.handleChatwootEvent({
      ...base,
      id: 13,
      conversation: { id: 55, contact_inbox: { source_id: 'abc:other' } }
    })).skipped,
    'not_our_inbox'
  );
  assert.equal((await bridge.handleChatwootEvent({ ...base, id: 14, content: '   ' })).skipped, 'empty');
  assert.equal((await bridge.handleChatwootEvent({ ...base, id: 15, event: 'conversation_created' })).skipped, 'event');

  assert.equal(wechat.sent.length, 0);
});

test('出站：同一条消息重复投递要幂等', async () => {
  const store = createStore(tempDir());
  const wechat = createFakeWechat();
  const bridge = createBridge({
    config: buildConfig(),
    chatwoot: createFakeChatwoot(),
    wechat,
    store,
    logger: silentLogger
  });

  const payload = {
    event: 'message_created',
    id: 888,
    message_type: 'outgoing',
    private: false,
    content: '收到',
    conversation: { id: 55, contact_inbox: { source_id: 'wxkf:wkABC:wmUSER001' } }
  };

  await bridge.handleChatwootEvent(payload);
  const second = await bridge.handleChatwootEvent(payload);

  assert.equal(second.skipped, 'duplicate');
  assert.equal(wechat.sent.length, 1);
});

test('source_id 编解码：非法格式返回 null', () => {
  const bridge = createBridge({
    config: buildConfig(),
    chatwoot: createFakeChatwoot(),
    wechat: createFakeWechat(),
    store: createStore(tempDir()),
    logger: silentLogger
  });

  assert.equal(bridge.encodeSourceId({ openKfId: 'wkA', externalUserId: 'wmB' }), 'wxkf:wkA:wmB');
  assert.deepEqual(bridge.decodeSourceId('wxkf:wkA:wmB'), { openKfId: 'wkA', externalUserId: 'wmB' });
  assert.equal(bridge.decodeSourceId('wxkf:wkA'), null);
  assert.equal(bridge.decodeSourceId('other:wkA:wmB'), null);
  assert.equal(bridge.decodeSourceId(undefined), null);
});
