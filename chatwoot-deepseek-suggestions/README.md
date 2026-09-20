# Chatwoot DeepSeek 话术助手

基于 DeepSeek 的 Chatwoot **Dashboard App**：读取当前会话的最近公开文本消息，生成 1–3 条可直接复制的坐席回复话术。**只推荐、不自动发送**，由坐席审阅后自行复制发出。

- 采用 Chatwoot 官方支持的 [Dashboard Apps](https://www.chatwoot.com/hc/user-guide/articles/1677691702-how-to-use-dashboard-apps) 机制，不依赖已废弃的插件接口
- DeepSeek 使用 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 的 JSON 输出（`response_format: json_object`）
- 私密备注、附件、表单/邮件采集卡片、活动消息会被丢弃；联系人的邮箱、电话、自定义属性等敏感字段**不会进入请求体**（前端、服务端双重过滤）
- 服务端按 `Origin` 白名单校验来源，避免被任意站点盗用

## 目录结构

```
chatwoot-deepseek-suggestions/
├─ src/server.js        # 零依赖 Node HTTP 服务（Node 18+）
├─ src/kb.js            # 知识库检索（bigram 余弦 + 关键词加权，按 mtime 热加载）
├─ kb/
│  ├─ faq.json          # 知识库本体（唯一真相源）
│  └─ faq.csv           # 同内容的 Excel 可编辑版（由 kb:csv 生成）
├─ scripts/kb-tool.js   # 知识库工具：check 校验 / build CSV→JSON / csv JSON→CSV
├─ public/              # 嵌入 Chatwoot 的前端面板
│  ├─ index.html
│  ├─ app.js            # postMessage 收会话上下文、调 /api/suggest、复制
│  ├─ styles.css
│  └─ kb-editor.html    # 知识库所见即所得编辑器（非嵌入，独立打开）
├─ test/server.test.js  # node:test 单元测试
├─ Dockerfile           # node:20-alpine
├─ docker-compose.yml
├─ .env.example         # 环境变量模板（复制为 .env 使用）
└─ README.md
```

## 配置

```powershell
copy .env.example .env
```

编辑 `.env`：

```env
DEEPSEEK_API_KEY=你的DeepSeek密钥      # https://platform.deepseek.com
APP_ORIGIN=http://localhost:8787      # 本服务自身地址
CHATWOOT_ORIGINS=http://localhost:3000  # Chatwoot 根域名（可多个，逗号分隔）
```

`CHATWOOT_ORIGINS` 只填 Chatwoot 根域名（如 `https://app.chatwoot.com`、`http://localhost:3000`），不要带 `/app` 路径。

## 运行与验证

无 Docker 时直接用 Node：

```powershell
node src/server.js          # 默认 http://localhost:8787
node --test test/server.test.js
```

Docker 方式：

```powershell
docker compose up -d --build
# 健康检查：http://localhost:8787/healthz → {"ok":true}
```

## 接入 Chatwoot

1. 打开 Chatwoot → **Settings → Integrations → Dashboard apps**
2. 新建 Dashboard App：
   - 名称：`DeepSeek 话术助手`
   - URL：`http://localhost:8787`（云端/HTTPS Chatwoot 需换成公网 HTTPS 地址，否则被混合内容策略拦截）
3. 打开任意会话 → 右侧应用面板点 **生成推荐话术** → 复制后自行发送

> 独立打开 `http://localhost:8787` 是正常的：它没有会话上下文，仅用于预览。可用页面下方「本地调试」粘贴文本来试用。

## 知识库维护

知识库就是 `kb/faq.json` 一个文件，**不依赖数据库**；`src/kb.js` 按文件 mtime 热加载，改动后无需重启。命中结果会作为"参考资料"注入 DeepSeek 的 prompt，并在面板上以「📚 知识库参考」显示。

### 三种改法，按偏好选

**① 网页编辑器（推荐给人用）** —— 打开 `http://localhost:8787/kb-editor.html`

- 自动从 `/kb` 载入服务端当前内容，也可拖入本地 `faq.json` / `faq.csv`
- 表格化编辑，实时标出 **id 重复 / 问题或答案为空 / 问题疑似重复**（相似度 ≥ 0.75 会黄底提示）
- 「导出 JSON」直接覆盖服务器 `kb/faq.json` 即生效；「导出 CSV」发给同事用 Excel 改

**② Excel / WPS（推荐给非技术同事）**

```bash
npm run kb:csv      # faq.json → kb/faq.csv（带 BOM，Excel 打开不乱码）
# 用 Excel 编辑：keywords 多值用 | 分隔，answer 可含逗号与换行
npm run kb:build    # kb/faq.csv → faq.json（校验不通过会拒绝写入）
```

> 保存 CSV 时务必选「CSV UTF-8」，否则中文乱码；表头支持中文（分类/问题/关键词/答案）。

**③ 直接改 JSON（开发时最快）**

```bash
npm run kb:check    # 校验 + 统计
```

### 校验会检查什么

| 级别 | 内容 |
|---|---|
| ❌ 错误（会阻止 build 写入） | JSON 语法、`faqs` 数组存在、id 非空且唯一、question/answer 非空、keywords 必须是数组 |
| ⚠️ 警告 | 问题相似度 ≥ 0.75（疑似重复，会互相抢 topK）、answer 少于 10 字、keywords 全空 |
| 📊 统计 | 条目数、分类分布、关键词总数、平均答案字数、文件大小 |

### 检索性能参考（实测）

| 条目数 | 单次检索 | 索引构建 | 内存 |
|---|---|---|---|
| 10 条 | < 0.5 ms | ~0 ms | 可忽略 |
| 500 条 | **3.1 ms** | 11.3 ms（仅文件变更时） | ≈ 11 MB |

向量在文件变更时预计算一次并缓存，因此检索耗时与条目数基本解耦。**500 条量级继续用文件即可**，等需要"多人、在网页上、带权限地编辑"时再考虑入库。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查 |
| GET | `/` `/app.js` `/styles.css` | 嵌入面板 |
| GET | `/kb-editor.html` | 知识库编辑器（独立打开，不嵌入） |
| GET | `/kb` | 只读知识库内容（给编辑器载入用；如需保护请加 Nginx Basic Auth） |
| POST | `/api/suggest` | 见下 |

`POST /api/suggest`（需携带白名单内 `Origin` 头）：

```json
{
  "messages": [
    { "message_type": "incoming", "content_type": "text", "content": "你好，想退货。", "private": false }
  ]
}
```

返回：

```json
{
  "suggestions": ["话术1", "话术2", "话术3"],
  "refs": [{ "id": "faq_logistics_002", "question": "订单什么时候发货？…", "score": 0.838 }],
  "model": "deepseek-chat",
  "source": "deepseek"
}
```

`refs` 是本次命中的知识库条目（面板显示为「📚 知识库参考」），便于核对话术依据。

请求体只接受 `message_type/content/content_type/private` 这类结构；服务端重新清洗后**仅把公开文本转录**发送给 DeepSeek。
