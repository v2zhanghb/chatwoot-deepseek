# 微信客服 ↔ Chatwoot 桥接服务

把「微信客服」的咨询接进 Chatwoot，坐席（或 DeepSeek 机器人）的回复再送回微信。

```
微信客户 ──消息──▶ 微信客服回调 ──▶ 本桥接服务 ──REST──▶ Chatwoot API 渠道（收件箱）
                                                              │
                                         坐席/机器人在 Chatwoot 回复
                                                              ▼
微信客户 ◀──send_msg── 微信客服 API ◀── 本桥接服务 ◀──渠道 webhook── Chatwoot
```

- **零依赖**：只用 Node 内置模块（`node:crypto` 做 AES 解密与签名校验），不需要 `npm install`
- **mock 模式**：不连真实微信也能把闭环跑通，"发往微信"的消息写进本地 outbox 供核对
- **真实模式**：实现微信客服官方协议（回调验签、AES-256-CBC 解密、`sync_msg` 拉取、`send_msg` 发送）

---

## 一、先跑通闭环（mock 模式，5 分钟）

### 1. 拿到 Chatwoot 管理员 token

Chatwoot → 头像 → **个人资料 / Profile Settings** → **访问令牌 / Access Token**，复制。

### 2. 创建 API 渠道收件箱

```bash
cd chatwoot-wechat-bridge
cp .env.example .env
# 编辑 .env：填 CHATWOOT_API_TOKEN

npm run setup -- --webhook http://host.docker.internal:8789/chatwoot/webhook
```

> `host.docker.internal` 是容器访问宿主机的地址（Docker Desktop 自带）。
> 桥接也跑在 Docker 里时，改成 `http://chatwoot-wechat-bridge:8789/chatwoot/webhook`。

脚本会输出 `CHATWOOT_INBOX_ID=4`，写回 `.env`。渠道 secret 接口不返回，可从数据库取：

```bash
docker exec chatwoot-local-postgres-1 psql -U postgres -d chatwoot_production -t -A \
  -c "select i.id, i.name, c.secret from inboxes i join channel_api c on c.id=i.channel_id where i.channel_type='Channel::Api';"
# 对应收件箱的那一行 secret 填进 CHATWOOT_CHANNEL_SECRET（留空则跳过签名校验）
```

### 3. 启动

```bash
npm start          # http://localhost:8789
npm test           # 15 项测试（含端到端闭环）
```

### 4. 模拟微信客户发消息

浏览器打开 <http://localhost:8789/mock>：

1. 点「发送到桥接」→ 去 Chatwoot 的「微信客服（桥接）」收件箱，应出现新会话
2. 在 Chatwoot 里回复 → 回到测试页点「刷新」，右侧出现"发往微信"的内容

命令行等价操作：

```bash
curl -X POST http://localhost:8789/mock/wechat \
  -H "content-type: application/json" \
  -d '{"open_kfid":"wkMOCK001","external_userid":"wmMOCKUSER001","content":"什么时候发货？"}'

curl http://localhost:8789/mock/outbox    # 查看发往微信的消息
curl http://localhost:8789/mock/state     # 查看会话映射与统计
curl -X POST http://localhost:8789/mock/reset   # 清空状态重新测
```

### 5. 换成 Docker 跑（可选）

```bash
docker compose up -d --build
```

---

## 二、切到真实微信客服

### 1. 微信侧准备（企业微信后台）

1. 完成**企业认证**，进入 **微信客服**（kf.weixin.qq.com 或企业微信后台 → 微信客服）
2. 创建客服账号，拿到 **客服账号 ID**（`open_kfid`，形如 `wkXXXX`）
3. 在 **API** 页获取：**企业 ID（corpid）**、**Secret**、**Token**、**EncodingAESKey**
4. 配置**回调地址**：`https://你的域名/wechat/callback`（必须公网 HTTPS，微信要求）
   - 本机调试可用内网穿透（frp / ngrok / cpolar）映射到 `localhost:8789`
5. 在「接入方式」里把客服账号配到公众号菜单、网页链接或小程序入口

### 2. 填 `.env`

```env
WECHAT_MODE=real
WECHAT_CORP_ID=ww1234567890abcdef
WECHAT_KF_SECRET=xxx
WECHAT_TOKEN=xxx
WECHAT_ENCODING_AES_KEY=43位字符串
```

重启服务。启动时会自动校验：回调 GET 请求能通过验签并返回解密后的 `echostr`，就说明密钥配对无误。

### 3. 验证

- 在微信里从客服入口发一条消息 → Chatwoot 收件箱应出现会话
- 坐席回复 → 微信端收到（微信客服有 **48 小时会话窗口**：客户发消息后 48 小时内可回复）

---

## 三、让 DeepSeek 机器人也自动回微信客户（可选）

机器人是 AgentBot 机制，只要把它绑到本收件箱即可，回复会走同一条出站链路：

```bash
# 1. 机器人放行新收件箱（chatwoot-deepseek-bot/.env）
INBOX_ALLOWLIST=3,4        # 4 = 微信客服（桥接）

# 2. 把 AgentBot 绑定到收件箱 4（Chatwoot API）
curl -X POST http://localhost:3000/api/v1/accounts/1/inboxes/4/set_agent_bot \
  -H "api_access_token: <管理员token>" -H "content-type: application/json" \
  -d '{"agent_bot": 1}'
```

绑定后：新会话进 `pending` → 机器人自动回复访客；坐席在 Chatwoot 点「接管」（转 `open`）后机器人静默。

---

## 四、接口一览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET/POST | `/wechat/callback` | 微信客服回调（GET=URL 校验，POST=消息推送） |
| POST | `/chatwoot/webhook` | 接收 Chatwoot 渠道 webhook（坐席/机器人回复），带签名校验 |
| POST | `/mock/wechat` | 模拟微信客户发消息（mock 模式测试用） |
| GET | `/mock/outbox` | 查看"发往微信"的消息 |
| GET | `/mock/state` | 查看会话映射 / 游标 / 统计 |
| POST | `/mock/reset` | 清空状态 |
| GET | `/mock` | 图形化测试台 |
| GET | `/healthz` | 健康检查 |

---

## 五、关键实现说明

| 点 | 说明 |
|---|---|
| 会话映射 | `contact_inbox.source_id` 固定为 `wxkf:{open_kfid}:{external_userid}`，一个微信客户 ↔ 一个 Chatwoot 会话，持久化在 `data/state.json` |
| 出站识别 | Chatwoot 的 webhook 载荷里带回 `conversation.contact_inbox.source_id`，据此解析出要发给哪个微信客户 |
| 签名校验 | Chatwoot → 桥接：`X-Chatwoot-Signature: sha256=HMAC_SHA256(channel.secret, "{ts}.{body}")`；微信 → 桥接：token/timestamp/nonce/encrypt 字典序 sha1 |
| 幂等 | 进出双向都按消息 id 去重（各保留最近 1000 条），webhook 重投或微信重推不会重复发 |
| 只转发该转的 | `message_type=outgoing` 且非私密备注才外发；`incoming`/activity/私密备注一律跳过 |
| 微信"事件+拉取" | 微信客服只推 `kf_msg_or_event` 事件，桥接收到后用事件里的 `Token` 调 `kf/sync_msg` 拉真实消息（游标持久化），同时兼容直接推文本的模式 |
| 5 秒限制 | 回调先返回 200，再异步处理，避免微信超时重推 |
| 入站仅限 API 渠道 | Chatwoot 源码里 `Incoming messages are only allowed in Api inboxes`，所以必须用 API 渠道收件箱 |

---

## 六、已知限制

- **媒体消息**：图片/语音/文件目前只在 Chatwoot 里落一条 `[image]` 占位文本，不做附件中继（需要 `kf/media` 上传下载 + Chatwoot 附件 API，后续可加）
- **48 小时窗口**：微信客服规定客户发消息后 48 小时内可回复，超时 `send_msg` 会报错（桥接会记日志）
- **主动触达**：微信客服不能主动发起会话，只能被动应答；主动营销要靠公众号模板消息/企微群发
- **单实例**：状态存本地 JSON，多副本部署需换成 Redis/数据库

---

## 七、目录结构

```
chatwoot-wechat-bridge/
├─ src/
│  ├─ server.js      # 入口：加载 .env、自检、监听
│  ├─ app.js         # HTTP 路由、签名校验、微信回调处理
│  ├─ bridge.js      # 双向转换核心（不依赖 HTTP，可单测）
│  ├─ chatwoot.js    # Chatwoot API 客户端（联系人/会话/消息/收件箱）
│  ├─ wechat.js      # 微信客服协议（AES 解密、签名、sync_msg、send_msg）
│  ├─ store.js       # 映射/游标/outbox/去重 的本地持久化
│  ├─ config.js      # 环境变量 → 配置对象 + 启动自检
│  ├─ env.js         # 极简 .env 加载
│  └─ logger.js
├─ scripts/setup-chatwoot.js   # 一键创建 API 渠道收件箱
├─ public/mock.html            # 模拟微信用户测试台
├─ test/                       # 15 项测试（协议 + 桥接逻辑 + 端到端闭环）
├─ Dockerfile / docker-compose.yml
└─ .env.example
```
