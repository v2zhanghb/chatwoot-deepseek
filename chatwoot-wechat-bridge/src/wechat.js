import crypto from 'node:crypto';

const BLOCK_SIZE = 32;

/** 微信/企业微信回调签名：把 token、timestamp、nonce、encrypt 字典序排序后 sha1 */
export function computeSignature({ token, timestamp, nonce, encrypt = '' }) {
  return crypto
    .createHash('sha1')
    .update([token, timestamp, nonce, encrypt].map(String).sort().join(''))
    .digest('hex');
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function pkcs7Unpad(buf) {
  let pad = buf[buf.length - 1];
  if (pad < 1 || pad > BLOCK_SIZE) pad = 0;
  return buf.subarray(0, buf.length - pad);
}

function pkcs7Pad(buf) {
  const pad = BLOCK_SIZE - (buf.length % BLOCK_SIZE) || BLOCK_SIZE;
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function aesKeyFrom(encodingAesKey) {
  return Buffer.from(`${encodingAesKey}=`, 'base64');
}

/**
 * 解密微信回调密文。
 * 明文结构：16 字节随机数 + 4 字节长度(大端) + 消息体 + receiveid
 */
export function decryptMessage(encodingAesKey, encrypted) {
  const key = aesKeyFrom(encodingAesKey);
  if (key.length !== 32) throw new Error('WECHAT_ENCODING_AES_KEY 长度非法（应为 43 位）');

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = pkcs7Unpad(
    Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
  );

  const msgLength = plain.readUInt32BE(16);
  return {
    message: plain.subarray(20, 20 + msgLength).toString('utf8'),
    receiveId: plain.subarray(20 + msgLength).toString('utf8')
  };
}

/** 加密（回复密文模式时用；也可用于测试解密正确性） */
export function encryptMessage(encodingAesKey, message, receiveId = '') {
  const key = aesKeyFrom(encodingAesKey);
  const body = Buffer.from(message, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const plain = pkcs7Pad(
    Buffer.concat([crypto.randomBytes(16), length, body, Buffer.from(receiveId, 'utf8')])
  );

  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

/** 极简 XML 字段提取（回调报文只有十来个字段，无需引入 XML 库） */
export function parseXmlFields(xml) {
  const fields = {};
  // 只取叶子节点：普通文本用 [^<]* 限定，避免把根节点 <xml> 整段吞掉
  const re = /<([A-Za-z_][\w]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let match;
  while ((match = re.exec(String(xml || ''))) !== null) {
    fields[match[1]] = (match[2] ?? match[3] ?? '').trim();
  }
  return fields;
}

/**
 * 微信客服 API 客户端
 * - mock 模式：sendText 只写入本地 outbox，不发起真实请求
 * - real 模式：access_token 缓存 + kf/send_msg / kf/sync_msg
 */
export function createWeChatClient(config, { store, logger, fetchImpl = fetch }) {
  const { wechat } = config;
  let tokenCache = { value: '', expiresAt: 0 };

  async function request(pathname, { method = 'GET', body, query = '' } = {}) {
    const url = `${wechat.apiBase}${pathname}${query}`;
    const response = await fetchImpl(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(wechat.timeoutMs)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`微信接口返回非 JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok || (data.errcode && data.errcode !== 0)) {
      throw new Error(`微信接口失败 ${pathname}: ${data.errcode ?? response.status} ${data.errmsg || ''}`);
    }
    return data;
  }

  async function getAccessToken() {
    const now = Date.now();
    if (tokenCache.value && tokenCache.expiresAt > now + 60_000) return tokenCache.value;

    const data = await request('/cgi-bin/gettoken', {
      query: `?corpid=${encodeURIComponent(wechat.corpId)}&corpsecret=${encodeURIComponent(wechat.kfSecret)}`
    });
    tokenCache = {
      value: data.access_token,
      expiresAt: now + (Number(data.expires_in) || 7200) * 1000
    };
    logger.debug('已刷新微信 access_token');
    return tokenCache.value;
  }

  /** 拉取消息（微信客服是"事件通知 + 主动拉取"模型） */
  async function syncMsg({ token, cursor = '', openKfId = '' } = {}) {
    const accessToken = await getAccessToken();
    const body = { token, cursor, limit: 1000, voice_format: 0 };
    if (openKfId) body.open_kfid = openKfId;
    return request('/cgi-bin/kf/sync_msg', { method: 'POST', body, query: `?access_token=${accessToken}` });
  }

  /** 给微信客户发文本消息 */
  async function sendText({ openKfId, externalUserId, content }) {
    if (config.mode === 'mock') {
      const record = {
        ts: new Date().toISOString(),
        open_kfid: openKfId,
        external_userid: externalUserId,
        msgtype: 'text',
        content
      };
      store.addOutbound(record);
      logger.info(`[mock] 出微信 → ${externalUserId}: ${content.slice(0, 80)}`);
      return { errcode: 0, mock: true };
    }

    const accessToken = await getAccessToken();
    return request('/cgi-bin/kf/send_msg', {
      method: 'POST',
      query: `?access_token=${accessToken}`,
      body: { touser: externalUserId, open_kfid: openKfId, msgtype: 'text', text: { content } }
    });
  }

  return { getAccessToken, syncMsg, sendText };
}
