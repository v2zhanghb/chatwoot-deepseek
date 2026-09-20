import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  computeSignature,
  decryptMessage,
  encryptMessage,
  parseXmlFields
} from '../src/wechat.js';

const AES_KEY = 'a'.repeat(43); // 43 位合法 EncodingAESKey

test('computeSignature：token/timestamp/nonce/encrypt 字典序 sha1', () => {
  const actual = computeSignature({ token: 'tok', timestamp: '1700000000', nonce: 'abc', encrypt: 'XYZ' });
  assert.match(actual, /^[0-9a-f]{40}$/);

  // 与独立实现（node:crypto 直接算排序拼接）交叉验证
  const crossCheck = crypto
    .createHash('sha1')
    .update(['tok', '1700000000', 'abc', 'XYZ'].sort().join(''))
    .digest('hex');
  assert.equal(actual, crossCheck);

  // 参数顺序不影响结果（内部排序）
  assert.equal(
    computeSignature({ token: 'tok', timestamp: '1700000000', nonce: 'abc', encrypt: 'XYZ' }),
    computeSignature({ token: 'abc', timestamp: 'XYZ', nonce: '1700000000', encrypt: 'tok' })
  );
});

test('encrypt/decrypt：往返一致，且能取回 receiveId', () => {
  const message = '<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content></xml>';
  const encrypted = encryptMessage(AES_KEY, message, 'wwcorpid123');
  const decrypted = decryptMessage(AES_KEY, encrypted);
  assert.equal(decrypted.message, message);
  assert.equal(decrypted.receiveId, 'wwcorpid123');
});

test('decryptMessage：AESKey 长度非法要报错', () => {
  assert.throws(() => decryptMessage('tooshort', 'AAAA'), /WECHAT_ENCODING_AES_KEY/);
});

test('parseXmlFields：支持 CDATA 与普通文本', () => {
  const xml = `
    <xml>
      <ToUserName><![CDATA[ww123]]></ToUserName>
      <FromUserName><![CDATA[wmUSER001]]></FromUserName>
      <CreateTime>1700000000</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[发货了吗？]]></Content>
      <MsgId>1234567890</MsgId>
      <OpenKfId><![CDATA[wkABC]]></OpenKfId>
    </xml>`;
  const fields = parseXmlFields(xml);
  assert.equal(fields.ToUserName, 'ww123');
  assert.equal(fields.FromUserName, 'wmUSER001');
  assert.equal(fields.MsgType, 'text');
  assert.equal(fields.Content, '发货了吗？');
  assert.equal(fields.MsgId, '1234567890');
  assert.equal(fields.OpenKfId, 'wkABC');
  assert.equal(parseXmlFields('').Content, undefined);
});

test('parseXmlFields：事件报文（kf_msg_or_event）', () => {
  const fields = parseXmlFields(`
    <xml>
      <ToUserName><![CDATA[ww123]]></ToUserName>
      <FromUserName><![CDATA[sys]]></FromUserName>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[kf_msg_or_event]]></Event>
      <Token><![CDATA[ENC_TOKEN_ABC]]></Token>
      <OpenKfId><![CDATA[wkABC]]></OpenKfId>
    </xml>`);
  assert.equal(fields.MsgType, 'event');
  assert.equal(fields.Event, 'kf_msg_or_event');
  assert.equal(fields.Token, 'ENC_TOKEN_ABC');
  assert.equal(fields.OpenKfId, 'wkABC');
});
