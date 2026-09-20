# Chatwoot DeepSeek 官网客服机器人 (AgentBot)

访客在官网 Widget 发消息 → DeepSeek 自动生成回复直接回给访客；坐席随时可接管。

## 工作原理（Chatwoot AgentBot 机制）

1. 通过 Chatwoot API 创建 AgentBot（`outgoing_url` 指向本服务 `/webhook`）
2. 把 bot 绑定到「官网客服」收件箱（`set_agent_bot`）
3. 绑定后**新会话**自动进入 `pending` 状态，访客消息事件推送到本服务
4. 本服务拉取会话历史 → 调 DeepSeek → 用 bot token 回复（访客看到机器人身份）

## 接管规则（重要）

| 会话状态 | 机器人行为 |
|---|---|
| `pending` | 自动回复访客 |
| `open`（坐席已接管） | **不再自动回复**，坐席人工处理 |
| 坐席将会话转回 `pending` | 机器人继续接管 |

- 只回复访客(incoming)公开文本；坐席消息、私密备注、系统消息不触发（防自激）
- 幂等去重：同一消息 id 只处理一次
- HMAC 校验：`X-Chatwoot-Signature`（sha256 of `{timestamp}.{body}`，secret 为 bot secret）

## 配置（.env）

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `CHATWOOT_BASE_URL` | Chatwoot 地址（容器网络内 `http://chatwoot:3000`） |
| `CHATWOOT_ADMIN_TOKEN` | 管理员 access_token（拉会话历史；bot token 无 messages:index 权限） |
| `CHATWOOT_BOT_TOKEN` | AgentBot 的 access_token（发回复） |
| `BOT_WEBHOOK_SECRET` | bot secret，webhook HMAC 校验 |
| `INBOX_ALLOWLIST` | 只处理指定收件箱 id，逗号分隔；空=不限 |
| `MAX_CONTEXT_MESSAGES` | 送入 DeepSeek 的最大历史条数 |

## 运维

```bash
docker compose up -d --build     # 构建启动
docker compose logs -f           # 看日志
curl http://localhost:8788/healthz   # 含处理统计 {received, handled, replied, skipped, errors}
npm test                         # 单元测试（11 项）
```

## 重新配置 Chatwoot 侧（如需重建 bot）

```bash
CW=http://localhost:3000
TOKEN=<管理员access_token>
# 创建 bot（响应含 access_token 与 secret）
curl -s -X POST "$CW/api/v1/accounts/1/agent_bots" \
  -H "api_access_token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"DeepSeek 客服机器人","description":"官网客服自动回复","outgoing_url":"http://chatwoot-deepseek-bot:8788/webhook"}'
# 绑定到官网客服收件箱（id=3）
curl -s -X POST "$CW/api/v1/accounts/1/inboxes/3/set_agent_bot" \
  -H "api_access_token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"agent_bot": <bot_id>}'
```

注意：绑定 bot 后仅**新会话**走机器人；已有会话状态不变。机器人回复以 DeepSeek 生成，`max_tokens=300`，prompt 中已内置"不编造订单信息、复杂问题转人工"约束。

## 关键坑：SafeFetch 私网限制

Chatwoot 投递 webhook 用 `SafeFetch`（ssrf_filter gem），**默认拦截私网 IP**——bot 容器在 compose 内网（172.19.x.x）会被拦，表现为系统消息 "Conversation was marked open by system due to an error with the agent bot"。

已在 `chatwoot-local/.env` 加 `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` 并 recreate chatwoot+sidekiq 解决（webhook 由 sidekiq 执行，两个服务都要生效）。若重建 chatwoot-local 栈时丢失此变量，机器人会再次失效。
