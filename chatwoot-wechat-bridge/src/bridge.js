/**
 * 桥接核心：两个方向的转换逻辑，不依赖 HTTP，便于单测。
 *
 *  入站  handleIncoming(微信消息)   → 联系人/会话/消息 写入 Chatwoot
 *  出站  handleChatwootEvent(载荷)  → 坐席或机器人回复 发回微信
 */
export function createBridge({ config, chatwoot, wechat, store, logger }) {
  const prefix = config.sourceIdPrefix;

  const encodeSourceId = ({ openKfId, externalUserId }) => `${prefix}:${openKfId}:${externalUserId}`;

  const decodeSourceId = (sourceId) => {
    const parts = String(sourceId || '').split(':');
    if (parts.length !== 3 || parts[0] !== prefix) return null;
    const [, openKfId, externalUserId] = parts;
    if (!openKfId || !externalUserId) return null;
    return { openKfId, externalUserId };
  };

  const displayName = (externalUserId) => `微信用户 ${String(externalUserId).slice(-6)}`;

  /** 微信 → Chatwoot */
  async function handleIncoming({ openKfId, externalUserId, content, msgId, msgType = 'text' }) {
    if (!openKfId || !externalUserId) {
      logger.warn('入站消息缺少 open_kfid / external_userid，已丢弃');
      return null;
    }
    if (msgId && !store.markSeen(`in:${msgId}`)) {
      logger.debug(`入站消息重复，跳过 ${msgId}`);
      return { skipped: 'duplicate' };
    }

    // 文本直接用；其他类型先占位（媒体转发见 README「已知限制」）
    const text = msgType === 'text' ? String(content || '').trim() : `[${msgType}]`;
    if (!text) return { skipped: 'empty' };

    const sourceId = encodeSourceId({ openKfId, externalUserId });
    const contact = await chatwoot.upsertContact({
      identifier: sourceId,
      name: displayName(externalUserId),
      additionalAttributes: {
        source: 'wechat_kf',
        wechat_open_kfid: openKfId,
        wechat_external_userid: externalUserId
      }
    });

    await chatwoot.createContactInbox(contact.id, {
      inboxId: config.chatwoot.inboxId,
      sourceId
    });

    let conversationId = store.getMapping(sourceId);
    if (!conversationId) {
      const conversation = await chatwoot.createConversation({
        sourceId,
        inboxId: config.chatwoot.inboxId,
        contactId: contact.id,
        status: 'open',
        additionalAttributes: { wechat_open_kfid: openKfId }
      });
      conversationId = conversation.id;
      store.setMapping(sourceId, conversationId);
      logger.info(`新建会话 ${conversationId}（${displayName(externalUserId)}）`);
    }

    const message = await chatwoot.createMessage(conversationId, { content: text, messageType: 'incoming' });
    logger.info(`入站 → 会话 ${conversationId}: ${text.slice(0, 80)}`);

    return { conversationId, messageId: message?.id };
  }

  /** Chatwoot → 微信（渠道 webhook 载荷） */
  async function handleChatwootEvent(payload) {
    if (!payload || payload.event !== 'message_created') return { skipped: 'event' };
    if (payload.message_type !== 'outgoing') return { skipped: 'not_outgoing' };
    if (payload.private === true) return { skipped: 'private' };

    const target = decodeSourceId(payload.conversation?.contact_inbox?.source_id);
    if (!target) return { skipped: 'not_our_inbox' };

    if (payload.id && !store.markSeen(`out:${payload.id}`)) {
      logger.debug(`出站消息重复，跳过 ${payload.id}`);
      return { skipped: 'duplicate' };
    }

    const content = String(payload.content || '').trim();
    if (!content) {
      logger.warn(`坐席消息 ${payload.id} 无文本内容（附件暂不转发）`);
      return { skipped: 'empty' };
    }

    await wechat.sendText({ ...target, content });
    logger.info(`出站 ← 会话 ${payload.conversation?.id}: ${content.slice(0, 80)}`);
    return { sent: true, target };
  }

  return { handleIncoming, handleChatwootEvent, encodeSourceId, decodeSourceId };
}
