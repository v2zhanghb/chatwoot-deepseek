import fs from 'node:fs';
import path from 'node:path';

/**
 * 极简持久化存储：
 * - mappings: source_id -> conversation_id（微信用户与 Chatwoot 会话的对应关系）
 * - cursor:   微信客服 sync_msg 的游标
 * - outbox:   mock 模式下"发往微信"的消息（用于验证闭环）
 * - seen:     消息 id 去重（进出双向，防 webhook 重投 / 微信重推）
 */
export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'state.json');

  let state = { mappings: {}, cursor: '', outbox: [], seen: [] };
  if (fs.existsSync(file)) {
    try {
      state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      // 状态文件损坏时从空开始，不影响服务可用
    }
  }

  let timer = null;
  const persist = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch {
      // 磁盘问题不应中断消息处理
    }
  };
  const persistSoon = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, 50);
    timer.unref?.();
  };

  const seenSet = new Set(state.seen);

  return {
    getMapping: (sourceId) => state.mappings[sourceId] || null,
    setMapping: (sourceId, conversationId) => {
      state.mappings[sourceId] = conversationId;
      persistSoon();
    },
    removeMapping: (sourceId) => {
      delete state.mappings[sourceId];
      persistSoon();
    },
    allMappings: () => ({ ...state.mappings }),

    getCursor: () => state.cursor || '',
    setCursor: (cursor) => {
      state.cursor = cursor || '';
      persistSoon();
    },

    addOutbound: (item) => {
      state.outbox.push(item);
      if (state.outbox.length > 200) state.outbox.shift();
      persistSoon();
    },
    listOutbound: () => [...state.outbox],

    /** 返回 true 表示这条消息第一次见（应处理）；false 表示重复（应跳过） */
    markSeen: (key) => {
      if (seenSet.has(key)) return false;
      seenSet.add(key);
      state.seen.push(key);
      if (state.seen.length > 1000) {
        const dropped = state.seen.splice(0, state.seen.length - 1000);
        dropped.forEach((k) => seenSet.delete(k));
      }
      persistSoon();
      return true;
    },

    reset: () => {
      state = { mappings: {}, cursor: '', outbox: [], seen: [] };
      seenSet.clear();
      persist();
    },

    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      persist();
    }
  };
}
