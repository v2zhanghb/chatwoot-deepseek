/**
 * Chatwoot API 客户端（只用到 5 个接口，全部已对照 4.17.1 源码核实）
 *  - GET    /contacts/search            找联系人（按 identifier）
 *  - POST   /contacts                   建联系人
 *  - POST   /contacts/:id/contact_inboxes  建"联系人-收件箱"关系，source_id 由我们指定
 *  - POST   /conversations              建会话（API 渠道下可带首条消息）
 *  - POST   /conversations/:id/messages 追加消息（message_type=incoming 仅 API 渠道允许）
 */
export function createChatwootClient(config, { logger, fetchImpl = fetch }) {
  const { chatwoot } = config;
  const base = `${chatwoot.baseUrl}/api/v1/accounts/${chatwoot.accountId}`;
  const headers = {
    'content-type': 'application/json',
    api_access_token: chatwoot.apiToken
  };

  async function request(method, pathname, body) {
    const response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(chatwoot.timeoutMs)
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`Chatwoot ${method} ${pathname} -> ${response.status} ${text.slice(0, 300)}`);
    }
    return data;
  }

  async function findContact(identifier) {
    const data = await request('GET', `/contacts/search?q=${encodeURIComponent(identifier)}`);
    const list = data?.payload || [];
    return list.find((item) => item.identifier === identifier) || null;
  }

  async function upsertContact({ identifier, name, additionalAttributes }) {
    const existing = await findContact(identifier);
    if (existing) return existing;

    try {
      // 创建接口返回 { payload: { contact, contact_inbox } }，这里只取 contact
      const data = await request('POST', '/contacts', {
        name,
        identifier,
        additional_attributes: additionalAttributes
      });
      const contact = data?.payload?.contact || data;
      if (!contact?.id) throw new Error(`创建联系人返回结构异常: ${JSON.stringify(data).slice(0, 200)}`);
      return contact;
    } catch (error) {
      // 并发下可能刚好被别人创建，再查一次
      const retry = await findContact(identifier);
      if (retry) return retry;
      throw error;
    }
  }

  async function createContactInbox(contactId, { inboxId, sourceId }) {
    return request('POST', `/contacts/${contactId}/contact_inboxes`, {
      inbox_id: inboxId,
      source_id: sourceId
    });
  }

  async function createConversation({ sourceId, inboxId, contactId, status = 'open', additionalAttributes }) {
    return request('POST', '/conversations', {
      source_id: sourceId,
      inbox_id: inboxId,
      contact_id: contactId,
      status,
      additional_attributes: additionalAttributes
    });
  }

  async function createMessage(conversationId, { content, messageType = 'incoming' }) {
    return request('POST', `/conversations/${conversationId}/messages`, {
      content,
      message_type: messageType
    });
  }

  async function listInboxes() {
    const data = await request('GET', '/inboxes');
    return data?.payload || [];
  }

  async function getInbox(inboxId) {
    return request('GET', `/inboxes/${inboxId}`);
  }

  async function createApiInbox({ name, webhookUrl }) {
    return request('POST', '/inboxes', {
      name,
      channel: { type: 'api', webhook_url: webhookUrl }
    });
  }

  async function updateInboxWebhook(inboxId, webhookUrl) {
    return request('PATCH', `/inboxes/${inboxId}`, {
      channel: { webhook_url: webhookUrl }
    });
  }

  async function getConversation(conversationId) {
    return request('GET', `/conversations/${conversationId}`);
  }

  async function sendAgentMessage(conversationId, content) {
    return createMessage(conversationId, { content, messageType: 'outgoing' });
  }

  return {
    request,
    findContact,
    upsertContact,
    createContactInbox,
    createConversation,
    createMessage,
    listInboxes,
    getInbox,
    createApiInbox,
    updateInboxWebhook,
    getConversation,
    sendAgentMessage,
    logger
  };
}
