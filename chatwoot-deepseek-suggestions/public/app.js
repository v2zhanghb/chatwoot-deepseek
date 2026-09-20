/* DeepSeek 话术助手 - 前端逻辑（零依赖） */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const emptyEl = $('emptyState');
  const genRowEl = $('genRow');
  const genBtnEl = $('genBtn');
  const metaEl = $('meta');
  const resultsEl = $('results');
  const countEl = $('count');
  const listEl = $('list');
  const manualTextEl = $('manualText');
  const manualBtnEl = $('manualBtn');
  const manualHintEl = $('manualHint');
  const toastEl = $('toast');

  const MAX_CLIENT_MESSAGES = 40;
  const ALLOWED_TYPES = new Set(['incoming', 'outgoing', 0, 1]);
  const TEXT_CONTENT_TYPES = new Set(['text', 'input_text', undefined, null, '']);

  /* ---------------- 状态 ---------------- */
  let contextMessages = []; // 最近公开文本（精简字段）

  /* ---------------- 工具 ---------------- */
  function setStatus(text, mode) {
    statusEl.textContent = text;
    statusEl.dataset.mode = mode || 'idle';
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, 2200);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function textToItem(text) {
    return { message_type: 'incoming', content_type: 'text', content: String(text).trim(), private: false };
  }

  /* ---------------- 消息过滤（前端第一道） ---------------- */
  function isPublicText(m) {
    if (!m || typeof m !== 'object') return false;
    if (m.private === true || m.private === 1 || m.private === 'true') return false;
    const ct = m.content_type;
    if (!TEXT_CONTENT_TYPES.has(ct)) return false;
    const mt = m.message_type !== undefined ? m.message_type : m.type;
    if (!ALLOWED_TYPES.has(mt)) return false;
    return typeof m.content === 'string' && m.content.trim().length > 0;
  }

  function toPublicItem(m) {
    return {
      message_type: m.message_type !== undefined ? m.message_type : m.type,
      content_type: 'text',
      content: m.content.trim().slice(0, 3000),
      private: false,
    };
  }

  /* ---------------- 接收 Chatwoot 会话上下文 ---------------- */
  function extractMessages(payload) {
    if (!payload) return null;
    let data = payload;
    // 兼容常见包装：{ data: ... } / { event, data } / payload.data
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) data = payload.data;
    if (payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message) && payload.message.data) {
      data = payload.message.data;
    }
    let msgs = null;
    const conv = data.conversation;
    if (Array.isArray(data)) msgs = data;
    else if (Array.isArray(data.messages)) msgs = data.messages;
    else if (conv && Array.isArray(conv.messages)) msgs = conv.messages;
    else if (Array.isArray(data.message)) msgs = data.message;
    else if (Array.isArray(conv)) msgs = conv;
    if (!Array.isArray(msgs)) return null;
    return msgs.filter(isPublicText).slice(-MAX_CLIENT_MESSAGES).map(toPublicItem);
  }

  window.addEventListener('message', function (evt) {
    // 仅接受来自父窗口（Chatwoot 内嵌 iframe）的消息
    if (evt.source !== window.parent) return;
    let raw = evt.data;
    // Chatwoot 用 JSON.stringify 发送 {event:'appContext', data:{conversation,...}}
    // 必须 parse 为对象，否则 .data 恒为 undefined 导致整包丢弃
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (_) {
        return;
      }
    }
    const msgs = extractMessages(raw);
    if (!msgs) return;
    contextMessages = msgs;
    autoFillLatestCustomer(msgs);
    if (msgs.length === 0) {
      setStatus('无可用的公开文本', 'empty');
      return;
    }
    setStatus('已就绪 ' + msgs.length + ' 条消息', 'ready');
    emptyEl.hidden = true;
    genRowEl.hidden = false;
    metaEl.textContent = '将基于最近 ' + msgs.length + ' 条公开消息生成';
    genBtnEl.disabled = false;
  });

  /* ---------------- 自动填入客户最新消息 ---------------- */
  let lastAutoFilled = null; // 上一次自动填入的内容（用于判断是否可安全覆盖）

  function latestCustomerText(items) {
    for (var i = items.length - 1; i >= 0; i--) {
      var mt = items[i].message_type;
      if (mt === 0 || mt === 'incoming') return items[i].content;
    }
    return null;
  }

  function autoFillLatestCustomer(items) {
    var text = latestCustomerText(items);
    if (!text) return;
    var cur = manualTextEl.value.trim();
    // 输入框为空、或仍是上一次自动填入的内容时才覆盖；用户手动编辑过则不打扰
    if (cur === '' || cur === lastAutoFilled) {
      manualTextEl.value = text;
      lastAutoFilled = text;
      manualHintEl.textContent = '已自动填入客户最新消息（切换会话或新消息到达时自动更新）';
    }
  }

  /* ---------------- 调用后端生成 ---------------- */
  async function requestSuggestions(messages) {
    const resp = await fetch('/api/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const reason = data && data.error ? data.error : 'HTTP ' + resp.status;
      throw new Error(reason);
    }
    return {
      suggestions: (data && Array.isArray(data.suggestions)) ? data.suggestions : [],
      refs: (data && Array.isArray(data.refs)) ? data.refs : [],
    };
  }

  async function runGenerate(messages) {
    if (!messages.length) return;
    genBtnEl.disabled = true;
    manualBtnEl.disabled = true;
    setStatus('生成中…', 'busy');
    resultsEl.hidden = true;
    try {
      const { suggestions, refs } = await requestSuggestions(messages);
      if (!suggestions.length) throw new Error('未返回可用的推荐');
      renderResults(suggestions, refs);
      setStatus('生成完成', 'ready');
    } catch (e) {
      setStatus('生成失败', 'error');
      showToast('生成失败：' + (e && e.message ? e.message : '未知错误'));
    } finally {
      genBtnEl.disabled = false;
      manualBtnEl.disabled = false;
    }
  }

  /* ---------------- 渲染结果 ---------------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  function renderResults(suggestions, refs) {
    listEl.innerHTML = '';
    countEl.textContent = suggestions.length + ' 条';
    suggestions.forEach(function (text, i) {
      const card = document.createElement('article');
      card.className = 'suggestion';
      const head = document.createElement('div');
      head.className = 'suggestion-head';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '建议 ' + (i + 1);
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', function () {
        copyText(text)
          .then(function () { showToast('已复制到剪贴板'); })
          .catch(function () { showToast('复制失败，请手动选择文本'); });
      });
      head.appendChild(badge);
      head.appendChild(copyBtn);
      const body = document.createElement('p');
      body.className = 'suggestion-body';
      body.textContent = text;
      card.appendChild(head);
      card.appendChild(body);
      listEl.appendChild(card);
    });
    renderRefs(refs);
    resultsEl.hidden = false;
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* 知识库参考来源（refs 来自服务端检索结果） */
  function renderRefs(refs) {
    let box = document.getElementById('kbRefs');
    if (!box) {
      box = document.createElement('div');
      box.id = 'kbRefs';
      box.className = 'kb-refs';
      listEl.parentNode.appendChild(box);
    }
    box.innerHTML = '';
    if (!refs || !refs.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const title = document.createElement('div');
    title.className = 'kb-refs-title';
    title.textContent = '📚 知识库参考';
    box.appendChild(title);
    refs.forEach(function (r) {
      const chip = document.createElement('span');
      chip.className = 'kb-ref';
      chip.textContent = r.question;
      chip.title = '[' + r.id + '] 相关度 ' + r.score;
      box.appendChild(chip);
    });
  }

  /* ---------------- 事件 ---------------- */
  genBtnEl.addEventListener('click', function () {
    runGenerate(contextMessages);
  });

  manualBtnEl.addEventListener('click', function () {
    const text = manualTextEl.value.trim();
    if (!text) {
      manualHintEl.textContent = '请先粘贴文本';
      return;
    }
    manualHintEl.textContent = '';
    // 手动调试文本同样只作为“客户消息”处理，不包含任何联系人字段
    runGenerate([textToItem(text)]);
  });

  /* ---------------- 独立打开提示 ---------------- */
  setStatus('等待会话…', 'idle');
  if (window.self === window.top) {
    // 独立打开（未嵌入 Chatwoot）：仅提示，不会伪造上下文
    setTimeout(function () {
      setStatus('未嵌入会话', 'idle');
      manualBtnEl.disabled = false;
    }, 600);
  } else {
    // 已嵌入 Chatwoot：主动握手，请求父窗口立刻推送一次会话上下文
    // （官方协议：postMessage 字符串 'chatwoot-dashboard-app:fetch-info'）
    setTimeout(function () {
      try {
        window.parent.postMessage('chatwoot-dashboard-app:fetch-info', '*');
      } catch (_) { /* 忽略跨域异常 */ }
    }, 300);
  }
})();
