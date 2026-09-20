'use strict';

/**
 * 轻量知识库检索（零依赖）
 *
 * 参考 six-agent 的 FAQ RAG 思路，但不引入 embedding 服务：
 * 用字符 bigram 词袋 + 余弦相似度做中文友好的词法检索，
 * keywords 命中额外加权。FAQ 存于 kb/faq.json，热加载（按 mtime）。
 */

const fs = require('fs');
const path = require('path');

const KB_FILE = path.join(__dirname, '..', 'kb', 'faq.json');
// faqs 是原始数据，index 是预计算好的检索索引（向量 + 小写关键词），随文件变更整体重建
const cache = { mtimeMs: 0, faqs: [], index: [] };

function loadFaq() {
  let stat;
  try {
    stat = fs.statSync(KB_FILE);
  } catch (_) {
    return [];
  }
  if (stat.mtimeMs !== cache.mtimeMs) {
    try {
      const data = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
      cache.faqs = Array.isArray(data.faqs) ? data.faqs.filter((f) => f && f.question && f.answer) : [];
      // 一次性算好每条 FAQ 的 bigram 向量，检索时直接复用（500 条约 6x 提速）
      cache.index = cache.faqs.map((faq) => ({
        faq,
        vec: toBigrams(faqDocument(faq)),
        keywords: (faq.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean)
      }));
      cache.mtimeMs = stat.mtimeMs;
    } catch (_) {
      /* JSON 损坏时沿用上一次可用内容 */
    }
  }
  return cache.faqs;
}

/* 文本 → 字符 bigram 频率向量（ASCII 词按词级切分，中文按字切分） */
function toBigrams(text) {
  const t = String(text || '').toLowerCase();
  const grams = new Map();
  const tokens = t.match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    addGram(grams, tok);
  }
  const zh = t.replace(/[^\u4e00-\u9fa5]+/g, '');
  for (let i = 0; i < zh.length; i++) {
    addGram(grams, zh[i]);
    if (i + 1 < zh.length) addGram(grams, zh.slice(i, i + 2));
  }
  return grams;
}

function addGram(map, gram) {
  map.set(gram, (map.get(gram) || 0) + 1);
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const [g, v] of b) {
    normB += v * v;
    if (a.has(g)) dot += v * a.get(g);
  }
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}

function faqDocument(faq) {
  return [faq.question, ...(faq.keywords || []), faq.answer].join(' ');
}

/**
 * 检索与 query 最相关的 topK 条 FAQ。
 * @returns [{ faq, score }]
 */
function searchFaq(query, { topK = 3, threshold = 0.2 } = {}) {
  loadFaq(); // 确保索引与服务内最新文件同步
  if (!cache.index.length) return [];
  const qVec = toBigrams(query);
  if (!qVec.size) return [];
  const qLower = String(query || '').toLowerCase();

  const scored = cache.index.map((entry) => {
    let score = cosine(qVec, entry.vec);
    // keywords 精确命中加权（问句里直接出现关键词是强信号）
    for (const kw of entry.keywords) {
      if (qLower.includes(kw)) score += 0.15;
    }
    return { faq: entry.faq, score: Math.min(score, 1) };
  });

  return scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** 组装注入 prompt 的参考资料文本；无命中返回空串 */
function buildReferenceText(hits) {
  if (!hits.length) return '';
  const lines = hits.map((h, i) => `${i + 1}. [${h.faq.id}] ${h.faq.question}\n   ${h.faq.answer}`);
  return ['以下是知识库中可能相关的标准答复（参考资料）：', ...lines].join('\n');
}

module.exports = { loadFaq, searchFaq, buildReferenceText, KB_FILE, toBigrams, cosine, faqDocument };
