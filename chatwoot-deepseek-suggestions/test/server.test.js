'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, sanitizeMessages, parseSuggestions } = require('../src/server.js');

const BASE_CFG = {
  DEEPSEEK_API_KEY: 'sk-test-not-real',
  DEEPSEEK_MODEL: 'deepseek-chat',
  APP_ORIGIN: 'http://localhost:8787',
  CHATWOOT_ORIGINS: 'http://localhost:3000',
  MAX_CONTEXT_MESSAGES: '24',
};

function makeFakeDeepSeek() {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                suggestions: ['好的，马上为您处理。', '麻烦提供一下订单号，我来帮您核实。', '已为您登记，请稍候。'],
              }),
            },
          },
        ],
      }),
    };
  };
  return { calls, fn };
}

async function startApp(extra) {
  const fake = makeFakeDeepSeek();
  const srv = createServer(Object.assign({}, BASE_CFG, extra || {}, { deepSeekFetch: fake.fn }));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, fake, base };
}

test('1. 健康检查与静态页面可访问', async (t) => {
  const app = await startApp();
  t.after(() => new Promise((r) => app.srv.close(r)));

  const health = await fetch(`${app.base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const page = await fetch(`${app.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /DeepSeek 话术助手/);

  const js = await fetch(`${app.base}/app.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /requestSuggestions/);

  const css = await fetch(`${app.base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('2. API 来源保护：未授权 Origin 一律 403', async (t) => {
  const app = await startApp();
  t.after(() => new Promise((r) => app.srv.close(r)));

  const evil = await fetch(`${app.base}/api/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ messages: [{ message_type: 'incoming', content: 'hi', content_type: 'text' }] }),
  });
  assert.equal(evil.status, 403);

  const noOrigin = await fetch(`${app.base}/api/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(noOrigin.status, 403);
});

test('3. 私密备注/活动/表单等消息在服务端被过滤，且不会泄露给 DeepSeek', async (t) => {
  const app = await startApp();
  t.after(() => new Promise((r) => app.srv.close(r)));

  const raw = [
    { id: 1, message_type: 'incoming', content_type: 'text', content: '你好，想退货。', private: false },
    { id: 2, message_type: 'outgoing', content_type: 'text', content: '您好，请提供订单号。', private: false },
    { id: 3, message_type: 'outgoing', content_type: 'text', content: '这是私密备注：客户手机 13900000000', private: true },
    { id: 4, message_type: 2, content_type: 'text', content: '会话已转接', private: false }, // activity
    { id: 5, message_type: 'outgoing', content_type: 'input_email', content: 'a@b.com', private: false },
    { id: 6, message_type: 'incoming', content_type: 'text', content: '我马上补发。', private: false },
    { id: 7, message_type: 'incoming', content_type: 'cards', content: '卡片消息', private: false },
  ];

  const resp = await fetch(`${app.base}/api/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8787' },
    body: JSON.stringify({ messages: raw }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.ok(Array.isArray(data.suggestions) && data.suggestions.length >= 1 && data.suggestions.length <= 3);

  assert.equal(app.fake.calls.length, 1);
  const sent = app.fake.calls[0].body.messages;
  const joined = JSON.stringify(sent);

  // 请求体应为 system + 单条 user 转录，内容只含 3 条公开文本，且无任何敏感信息
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user']);
  assert.ok(joined.includes('你好，想退货。'));
  assert.ok(joined.includes('请提供订单号。'));
  assert.ok(joined.includes('我马上补发。'));
  assert.ok(!joined.includes('13900000000'));
  assert.ok(!joined.includes('私密备注'));
  assert.ok(!joined.includes('a@b.com'));
  assert.ok(!joined.includes('会话已转接'));
  assert.ok(!joined.includes('卡片消息'));

  // 模型与 JSON 输出要求正确下发
  assert.equal(app.fake.calls[0].body.model, 'deepseek-chat');
  assert.deepEqual(app.fake.calls[0].body.response_format, { type: 'json_object' });
  assert.equal(app.fake.calls[0].auth, 'Bearer sk-test-not-real');
});

test('4. 清洗函数与建议解析器行为正确', () => {
  const cleaned = sanitizeMessages([
    { message_type: 'incoming', content_type: 'text', content: '  hi  ', private: false },
    { message_type: 'outgoing', content_type: 'text', content: 'hello', private: true },
    { message_type: 'incoming', content_type: 'text', content: '   ', private: false },
    { message_type: 'incoming', content_type: 'text', content: 'second', private: false },
  ], 24);
  assert.deepEqual(cleaned, [
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'second' },
  ]);

  const suggestions = parseSuggestions('```json\n{"suggestions":["a","b"]}\n```');
  assert.deepEqual(suggestions, ['a', 'b']);

  const extra = parseSuggestions('前缀 {"suggestions":["x"]} 后缀');
  assert.deepEqual(extra, ['x']);

  const capped = parseSuggestions(JSON.stringify({ suggestions: ['1', '2', '3', '4'] }));
  assert.equal(capped.length, 3);
});
