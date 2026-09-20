# Chatwoot × DeepSeek 工作区

这个仓库汇集了基于 Chatwoot 的 DeepSeek 自动回复、坐席话术推荐、微信客服桥接，以及本地/阿里云部署与演示工具。各子目录可独立使用；请先阅读目标目录内的 `README.md`。

## 目录

| 目录 | 用途 |
| --- | --- |
| `chatwoot-local` | 本机 Docker 联调环境：Chatwoot、PostgreSQL、Redis 与话术助手。 |
| `chatwoot-aliyun` | 阿里云 ECS 单机部署：Nginx、Chatwoot、Sidekiq、机器人和话术助手。 |
| `chatwoot-deepseek-bot` | Chatwoot AgentBot webhook：在 `pending` 会话中使用 DeepSeek 自动回复，人工接管后停止自动回复。 |
| `chatwoot-deepseek-suggestions` | Chatwoot Dashboard App：只生成坐席回复建议，由人工复制发送。 |
| `chatwoot-wechat-bridge` | 微信客服与 Chatwoot API 渠道双向桥接，支持 mock 与真实微信协议模式。 |
| `chatwoot-demo` | 不依赖域名的演示页面、预检和端到端验证脚本。 |
| `widget-test` | Chatwoot 网站 Widget 的测试页面与验证素材。 |

## 推荐使用顺序

1. 在 `chatwoot-local` 按说明启动本地 Chatwoot；
2. 在 `chatwoot-deepseek-suggestions` 配置并启动话术助手；
3. 按需启用 `chatwoot-deepseek-bot` 自动回复或 `chatwoot-wechat-bridge` 微信客服桥接；
4. 需要公网部署时参考 `chatwoot-aliyun`；演示场景参考 `chatwoot-demo`。

## 前置条件

- Docker Desktop（本机联调或部署）；
- Node.js 18+（机器人、话术助手和微信桥接）；
- 已部署的 Chatwoot 实例；
- 按使用的模块准备 DeepSeek API Key、Chatwoot Access Token、微信客服参数等。

## 配置与安全

每个需要配置的模块都提供 `.env.example`。复制为 `.env` 后填写真实值：

```powershell
Copy-Item .env.example .env
```

请勿提交 `.env`、API Key、Chatwoot Access Token、数据库密码、微信 AppSecret、证书或生产会话数据。根目录 `.gitignore` 已忽略 `.env` 和 `.env.*`，同时保留 `.env.example` 模板。

## 验证

以下模块包含 Node.js 测试，可分别运行：

```powershell
cd chatwoot-deepseek-bot
npm test

cd ..\chatwoot-deepseek-suggestions
npm test

cd ..\chatwoot-wechat-bridge
npm test
```

`chatwoot-demo` 的预检与端到端验证方式见其目录内 README。

## 贡献约定

提交前请确认不包含真实环境配置或客户数据；涉及 DeepSeek、Chatwoot 或微信 API 的变更，应说明数据会发送到哪里、触发条件以及如何关闭该行为。
