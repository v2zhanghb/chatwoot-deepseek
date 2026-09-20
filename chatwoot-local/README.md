# Chatwoot 本机联调环境（配合 chatwoot-deepseek-suggestions）

在本地用 Docker 跑一套官方 Chatwoot（Web + Sidekiq + PostgreSQL 15 + Redis 7），
并把 DeepSeek 话术助手嵌进去联调。服务端口 **3000**。

## 前置条件

- 已安装并启动 **Docker Desktop**（Linux 引擎 running）
- 若尚未安装：去 https://www.docker.com/products/docker-desktop/ 安装后启动

## 一键准备 .env（生成随机密钥）

```powershell
powershell -ExecutionPolicy Bypass -File .\new-env.ps1
```

或手动：复制 `.env.example` 为 `.env`，填好 `POSTGRES_PASSWORD`、
`SECRET_KEY_BASE`（64位hex）与 `LOCKBOX_MASTER_KEY`（64位hex）。

## 启动

```powershell
# 1) 先起数据库与缓存
docker compose up -d postgres redis

# 2) 初始化数据库（首次或数据卷被重建后必做）
docker compose run --rm chatwoot bundle exec rails db:chatwoot_prepare

# 3) 启动 Web 与后台任务
docker compose up -d

# 4) 等待就绪（首次启动较慢）
docker compose ps
# 打开 http://localhost:3000
```

> 首次访问进入初始化向导：注册管理员账号（`ENABLE_ACCOUNT_SIGNUP=true` 已开）。

## 接入话术助手

参考同目录兄弟项目 `../chatwoot-deepseek-suggestions/README.md`：

1. 把助手的 `.env` 设为：
   ```env
   APP_ORIGIN=http://localhost:8787
   CHATWOOT_ORIGINS=http://localhost:3000
   ```
   并填入真实 `DEEPSEEK_API_KEY`，然后 `docker compose up -d --build`（在助手目录）。
2. Chatwoot → Settings → Integrations → **Dashboard apps**：
   - 名称：`DeepSeek 话术助手`
   - URL：`http://localhost:8787`
3. 新建 Inbox 与测试会话，打开会话右侧面板 → **生成推荐话术** → 复制后手动发送。

## 常用命令

```powershell
docker compose logs -f chatwoot     # 看 Web 日志
docker compose logs -f sidekiq      # 看后台任务日志
docker compose down                 # 停止（保留数据卷）
docker compose down -v              # 停止并清空数据（会丢账号/会话）
docker compose restart chatwoot
```

重启电脑后 Docker Desktop 未自动恢复的话：启动 Docker Desktop，然后在
`chatwoot-local` 目录执行 `docker compose up -d` 即可。
- **ENABLE_API_CORS=true**（本地 8080 固定会话测试页跨域直连 widget API 必需，勿删）
- **SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true**（webhook 打私网 bot 必需）
