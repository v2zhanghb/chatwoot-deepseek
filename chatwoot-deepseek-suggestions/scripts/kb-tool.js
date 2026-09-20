#!/usr/bin/env node
'use strict';

/**
 * 知识库工具（零依赖）
 *
 *   node scripts/kb-tool.js check        校验 kb/faq.json（语法/必填/重复/统计）
 *   node scripts/kb-tool.js build        由 kb/faq.csv 生成 kb/faq.json
 *   node scripts/kb-tool.js csv          由 kb/faq.json 反向导出 kb/faq.csv（Excel 可编辑）
 *
 * 对应 npm 命令：kb:check / kb:build / kb:csv
 *
 * CSV 约定（UTF-8，建议 Excel「另存为 CSV UTF-8」）：
 *   表头：id,category,question,keywords,answer
 *   - keywords 多值用竖线分隔，如：发货|催单|备货
 *   - answer 可含逗号/换行，工具会自动加引号
 *   - 以 # 开头的行视为注释，空行忽略
 *   - id 留空时自动生成 faq_auto_001 式编号（不推荐，id 会出现在坐席端「知识库参考」里）
 */

const fs = require('fs');
const path = require('path');
const { toBigrams, cosine, faqDocument } = require('../src/kb.js');

const ROOT = path.join(__dirname, '..');
const JSON_FILE = path.join(ROOT, 'kb', 'faq.json');
const CSV_FILE = path.join(ROOT, 'kb', 'faq.csv');

const COLUMNS = ['id', 'category', 'question', 'keywords', 'answer'];
// 允许中文表头，方便直接用 Excel 给同事改
const ALIAS = {
  id: 'id', 编号: 'id',
  category: 'category', 分类: 'category',
  question: 'question', 问题: 'question', 标题: 'question',
  keywords: 'keywords', 关键词: 'keywords', 关键字: 'keywords',
  answer: 'answer', 答案: 'answer', 回复: 'answer'
};

/* ------------------------------------------------------------------ */
/* CSV 读写（RFC4180 简化实现，支持引号包裹、双引号转义、字段内换行）  */
/* ------------------------------------------------------------------ */

function parseCsv(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { endRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length) endRow();
  // 丢弃完全空白的行与 # 注释行
  return rows.filter((r) => r.some((c) => String(c).trim() !== '') && !/^\s*#/.test(r[0] || ''));
}

function csvCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  // BOM 让 Excel 正确识别 UTF-8 中文；CRLF 兼容 Excel
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ */
/* 数据层                                                              */
/* ------------------------------------------------------------------ */

function slugId(index, used) {
  let n = index + 1;
  let id;
  do {
    id = `faq_auto_${String(n).padStart(3, '0')}`;
    n += 1;
  } while (used.has(id));
  return id;
}

/** CSV 文本 → { faqs, warnings } */
function csvToFaqs(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV 为空');
  const header = rows[0].map((h) => ALIAS[String(h).trim().toLowerCase()] || ALIAS[String(h).trim()] || '');
  const missing = ['question', 'answer'].filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`CSV 缺少必需列：${missing.join('、')}（当前表头：${rows[0].join(',')}）`);

  const warnings = [];
  const used = new Set();
  const faqs = [];

  rows.slice(1).forEach((cells, idx) => {
    const rec = {};
    header.forEach((col, i) => { if (col) rec[col] = (cells[i] || '').trim(); });
    if (!rec.question && !rec.answer) return; // 空行

    let id = rec.id || '';
    if (!id) { id = slugId(idx, used); warnings.push(`第 ${idx + 2} 行无 id，已自动生成 ${id}`); }
    if (used.has(id)) warnings.push(`第 ${idx + 2} 行 id 重复：${id}（已保留，check 会标为错误）`);
    used.add(id);

    faqs.push({
      id,
      category: rec.category || '未分类',
      question: rec.question || '',
      keywords: (rec.keywords || '').split(/[|、,;；]/).map((k) => k.trim()).filter(Boolean),
      answer: rec.answer || ''
    });
  });

  return { faqs, warnings };
}

function faqsToCsv(faqs) {
  const rows = [COLUMNS];
  for (const f of faqs) {
    rows.push([f.id || '', f.category || '', f.question || '', (f.keywords || []).join('|'), f.answer || '']);
  }
  return toCsv(rows);
}

/** 序列化时把 keywords 数组折回单行，保持文件紧凑、diff 干净 */
function stringifyDoc(doc) {
  return JSON.stringify(doc, null, 2).replace(
    /"keywords": \[\n([\s\S]*?)\n(\s*)\]/g,
    (m, inner, pad) => {
      const items = inner
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter(Boolean);
      return `"keywords": [${items.join(', ')}]`;
    }
  );
}

function readJsonFile() {
  const raw = fs.readFileSync(JSON_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`kb/faq.json 不是合法 JSON：${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function validate(doc) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object') {
    errors.push('顶层不是对象');
    return { errors, warnings };
  }
  if (!Array.isArray(doc.faqs)) {
    errors.push('缺少 faqs 数组');
    return { errors, warnings };
  }
  if (!doc.faqs.length) errors.push('faqs 为空数组');

  const seen = new Map();
  doc.faqs.forEach((f, i) => {
    const at = `第 ${i + 1} 条`;
    if (!f || typeof f !== 'object') { errors.push(`${at}：不是对象`); return; }
    const id = String(f.id || '').trim();
    if (!id) errors.push(`${at}：id 为空`);
    else if (seen.has(id)) errors.push(`${at}：id 与第 ${seen.get(id) + 1} 条重复 —— ${id}`);
    else seen.set(id, i);

    if (!String(f.question || '').trim()) errors.push(`${at}（${id || '无 id'}）：question 为空`);
    if (!String(f.answer || '').trim()) errors.push(`${at}（${id || '无 id'}）：answer 为空`);
    if (f.keywords !== undefined && !Array.isArray(f.keywords)) {
      errors.push(`${at}（${id || '无 id'}）：keywords 必须是数组`);
    }
    if (Array.isArray(f.keywords) && !f.keywords.some((k) => String(k || '').trim())) {
      warnings.push(`${at}（${id || '无 id'}）：keywords 为空，检索只能靠 question/answer 文本`);
    }
    if (String(f.answer || '').trim().length < 10) {
      warnings.push(`${at}（${id || '无 id'}）：answer 少于 10 字，可能信息不足`);
    }
  });

  // 相似问题检测（同一知识库内答案会互相抢 topK，重复条目应在源头合并）
  const vecs = doc.faqs.map((f) => (f && f.question ? toBigrams(faqDocument(f)) : null));
  for (let i = 0; i < doc.faqs.length; i++) {
    if (!vecs[i]) continue;
    for (let j = i + 1; j < doc.faqs.length; j++) {
      if (!vecs[j]) continue;
      const score = cosine(vecs[i], vecs[j]);
      if (score >= 0.75) {
        warnings.push(
          `疑似重复（相似度 ${score.toFixed(2)}）：` +
          `「${String(doc.faqs[i].id)}」与「${String(doc.faqs[j].id)}」—— ${String(doc.faqs[i].question).slice(0, 24)}`
        );
      }
    }
  }
  return { errors, warnings };
}

function stats(faqs) {
  const byCat = {};
  let kw = 0;
  let answerLen = 0;
  for (const f of faqs) {
    const c = f.category || '未分类';
    byCat[c] = (byCat[c] || 0) + 1;
    kw += Array.isArray(f.keywords) ? f.keywords.length : 0;
    answerLen += String(f.answer || '').length;
  }
  const size = fs.existsSync(JSON_FILE) ? fs.statSync(JSON_FILE).size : 0;
  return {
    条目数: faqs.length,
    分类数: Object.keys(byCat).length,
    分类分布: byCat,
    关键词总数: kw,
    平均答案字数: faqs.length ? Math.round(answerLen / faqs.length) : 0,
    文件大小: `${(size / 1024).toFixed(1)} KB`
  };
}

/* ------------------------------------------------------------------ */
/* 子命令                                                              */
/* ------------------------------------------------------------------ */

function cmdCheck() {
  const doc = readJsonFile();
  const { errors, warnings } = validate(doc);
  console.log('知识库校验：kb/faq.json');
  console.log(JSON.stringify(stats(doc.faqs), null, 2));

  if (warnings.length) {
    console.log(`\n⚠️  警告 ${warnings.length} 条：`);
    warnings.forEach((w) => console.log(`   - ${w}`));
  }
  if (errors.length) {
    console.error(`\n❌ 错误 ${errors.length} 条：`);
    errors.forEach((e) => console.error(`   - ${e}`));
    return 1;
  }
  console.log(`\n✅ 通过${warnings.length ? '（有警告，建议处理）' : ''}`);
  return 0;
}

function cmdBuild() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌ 找不到 ${path.relative(ROOT, CSV_FILE)}，先跑 npm run kb:csv 生成模板`);
    return 1;
  }
  const { faqs, warnings } = csvToFaqs(fs.readFileSync(CSV_FILE, 'utf8'));
  const old = fs.existsSync(JSON_FILE) ? readJsonFile() : {};
  const doc = {
    version: old.version || 'v1',
    updatedAt: new Date().toISOString().slice(0, 10),
    note: old.note || '话术助手知识库。answer 供 DeepSeek 生成建议时参考。',
    faqs
  };

  const { errors, warnings: schemaWarnings } = validate(doc);
  const allWarnings = [...warnings, ...schemaWarnings];
  if (errors.length) {
    console.error(`❌ CSV 校验未通过，未写入 faq.json：`);
    errors.forEach((e) => console.error(`   - ${e}`));
    return 1;
  }
  if (allWarnings.length) {
    console.log(`⚠️  警告 ${allWarnings.length} 条：`);
    allWarnings.forEach((w) => console.log(`   - ${w}`));
  }

  fs.writeFileSync(JSON_FILE, stringifyDoc(doc) + '\n', 'utf8');
  console.log(`\n✅ 已生成 kb/faq.json`);
  console.log(JSON.stringify(stats(faqs), null, 2));
  console.log('\n提示：服务按文件 mtime 热加载，无需重启；云端改完记得同步到 ECS。');
  return 0;
}

function cmdCsv() {
  const doc = readJsonFile();
  const { errors } = validate(doc);
  if (errors.length) {
    console.error('❌ faq.json 存在问题，先修复再导出：');
    errors.forEach((e) => console.error(`   - ${e}`));
    return 1;
  }
  fs.writeFileSync(CSV_FILE, faqsToCsv(doc.faqs), 'utf8');
  console.log(`✅ 已导出 kb/faq.csv（${doc.faqs.length} 条）`);
  console.log('用 Excel / WPS 打开编辑，改完跑 npm run kb:build 生成 faq.json。');
  console.log('注意：保存时选「CSV UTF-8」编码，否则中文会乱码。');
  return 0;
}

const COMMANDS = { check: cmdCheck, build: cmdBuild, csv: cmdCsv };

if (require.main === module) {
  const cmd = (process.argv[2] || 'check').toLowerCase();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`用法：node scripts/kb-tool.js <check|build|csv>`);
    process.exit(1);
  }
  process.exit(fn());
}

module.exports = { parseCsv, toCsv, csvToFaqs, faqsToCsv, validate, stats, COLUMNS };
