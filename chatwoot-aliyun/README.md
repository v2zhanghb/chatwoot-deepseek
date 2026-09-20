# Chatwoot 阿里云部署指南

单机部署全家桶：Nginx(443) + Chatwoot + Sidekiq + PostgreSQL + Redis + DeepSeek机器人(8788内网) + 话术助手(8787经Nginx)。

## 一、ECS 目录准备

```bash
mkdir -p /opt/chatwoot-deploy/certs
# 上传本目录（docker-compose.yml / .env.example / nginx/）到 /opt/chatwoot-deploy/
# 上传两个机器人项目到 /opt/chatwoot-deepseek-bot/ 与 /opt/chatwoot-deepseek-suggestions/
# 证书（阿里云SSL证书下载 Nginx 格式）解压为：
#   /opt/chatwoot-deploy/certs/fullchain.pem
#   /opt/chatwoot-deploy/certs/privkey.pem
```

## 二、Chatwoot 镜像上云（二选一）

**方案 A：docker save 直传（最快）**

```bash
# 本机
docker save chatwoot-local:4.17.1 | gzip > chatwoot-local.tar.gz
scp chatwoot-local.tar.gz root@<ECS_IP>:/opt/

# ECS
docker load < /opt/chatwoot-local.tar.gz   # 得到 chatwoot-local:4.17.1
```

**方案 B：ACR 个人版（推荐长期用）**

```bash
docker login --username=<阿里云账号> registry.cn-beijing.aliyuncs.com
docker tag chatwoot-local:4.17.1 registry.cn-beijing.aliyuncs.com/<命名空间>/chatwoot:4.17.1
docker push registry.cn-beijing.aliyuncs.com/<命名空间>/chatwoot:4.17.1
# .env 里 CHATWOOT_IMAGE 改成 ACR 完整地址
```

## 三、配置

```bash
cd /opt/chatwoot-deploy
cp .env.example .env
vi .env          # 改域名 / 密钥 / OSS 四件套（AK/SK、bucket、region、endpoint）
```

密钥生成（全新部署）：

```bash
openssl rand -hex 64   # SECRET_KEY_BASE
openssl rand -hex 32   # LOCKBOX_MASTER_KEY
```

机器人项目里的 `.env`（两个项目各一份）：

```env
# chatwoot-deepseek-bot/.env —— CHATWOOT_BASE_URL 保持内网地址
CHATWOOT_BASE_URL=http://chatwoot:3000

# chatwoot-deepseek-suggestions/.env —— 必须改成云端域名
APP_ORIGIN=https://<SUGGESTIONS域名>
CHATWOOT_ORIGINS=https://<CHATWOOT域名>
```

安全组：只放行 22 / 80 / 443。**3000、8787、8788、5432、6379 一律不开**。

## 四、启动与验证

```bash
docker compose up -d --build
docker compose ps                       # 等 chatwoot healthy
curl -k https://<域名>/health           # {"cw_status":200...} 之类即通
# 浏览器打开 https://<域名> 登录 → 设置里确认 widget 嵌码地址已是新域名
# 坐席端 Dashboard App 的 URL 改成 https://<SUGGESTIONS域名>/
```

WebSocket 检查：会话页消息实时刷新即 wss 正常；不刷新则查 Nginx 是否生效了 Upgrade 头（模板已带）。

## 五、迁移本地数据（可选）

```bash
# 本机导出
docker exec chatwoot-local-postgres-1 pg_dump -U postgres -d chatwoot_production -Fc > cw.dump
# 上传 ECS 后恢复（先停 chatwoot/sidekiq，避免迁移中写库）
docker compose stop chatwoot sidekiq
cat cw.dump | docker compose exec -T postgres pg_restore -U postgres -d chatwoot_production --clean --if-exists
docker compose start chatwoot sidekiq
```

迁移数据的**硬前提**：`.env` 的 `SECRET_KEY_BASE` 与 `LOCKBOX_MASTER_KEY` 和本地完全一致（inbox 凭据、API token 等加密字段才能解开）。

历史附件如需迁移：本地 `chatwoot-storage` 卷里的文件对应 OSS 换存储后的存量，量大可用 ossutil 批量传到 bucket 同名 key。

## 六、上云后差异对照

| 项 | 本地 | 云端 |
|---|---|---|
| FRONTEND_URL | http://localhost:3000 | https://域名 |
| 附件 | local 磁盘卷 | OSS（s3_compatible） |
| 机器人 outgoing_url | http://chatwoot-deepseek-bot:8788/webhook | 不变（同 compose 内网） |
| 话术助手 | http://localhost:8787 | https://SUGGESTIONS域名 |
| Dashboard App URL | http://localhost:8787 | https://SUGGESTIONS域名 |
| 8080 测试页 | 本地联调 | 不上云，用真实官网嵌 widget 验证 |
| ENABLE_ACCOUNT_SIGNUP | true | 建议 false（防陌生人注册） |

## 七、知识库（FAQ）存储

话术助手的知识库就是 `chatwoot-deepseek-suggestions/kb/faq.json` 这一个 JSON 文件（结构 `{faqs:[{id,category,question,keywords[],answer}]}`），**不依赖数据库**，服务按文件 mtime 热加载——文件一变立刻生效，不用重启、不用重建镜像。

已在上面的 compose 里把 `kb/` 目录**挂载出容器**（`../chatwoot-deepseek-suggestions/kb:/app/kb`），所以云端改知识库的方式是：

```bash
# 在 ECS 上直接改，保存即生效
vi /opt/chatwoot-deepseek-suggestions/kb/faq.json
curl -s https://<SUGGESTIONS域名>/healthz     # 确认服务仍在
```

三种存储方案，按规模选：

| 方案 | 怎么存 | 适用 | 代价 |
|---|---|---|---|
| **A. ECS 本地文件（默认，推荐）** | `/opt/chatwoot-deepseek-suggestions/kb/faq.json`，已挂载 | 单人维护、几十~几百条 | 无。多台 ECS 需各自同步 |
| **B. OSS 当知识库** | faq.json 上传到 OSS bucket，ECS 定时拉回本地目录 | 想集中管理/多人改、留版本历史 | **零代码改动**：装 `ossutil` 后加一条 crontab 定时 `ossutil cp oss://<bucket>/kb/faq.json /opt/chatwoot-deepseek-suggestions/kb/faq.json`，服务自动热加载。间隔建议 1~5 分钟 |
| **C. 真入库** | 建 `kb_faq` 表存 RDS PostgreSQL（复用现有 pg 实例即可，它已开 pgvector） | 上千条、要网页端增删改查、要按坐席权限编辑 | 要改 `src/kb.js` 取数逻辑 + 写一个管理界面 |

**建议**：现在 10 条的量级用 A；等你需要「改完不用登 ECS」时升级到 B（成本几乎为零，一个 ossutil + 一行 cron）；等 FAQ 上百条且要多人协作编辑再考虑 C。

关于「放 OSS 是不是和附件用同一个 bucket」——可以共用，建议分目录（`kb/faq.json` 与附件的 key 不冲突），也可以单独建 bucket 便于设权限。**注意**：知识库这个 JSON 不需要公开读，bucket 保持私有，靠 ossutil 用 AK/SK 拉取即可。

备份：知识库本身很小，跟着 `crontab` 或 `ossutil cp -r kb oss://<bucket>/kb-backup/$(date +%F)/` 一起做个每日快照就行。

## 八、常用运维

```bash
docker compose logs -f chatwoot chatwoot-deepseek-bot   # 追日志
docker compose restart chatwoot                          # 改 .env 后重启
docker compose up -d --build chatwoot-deepseek-suggestions  # 改话术助手代码后重建
# 只改知识库不用重建（kb 已挂载）：直接改 kb/faq.json 即可
# 定期备份：
docker compose exec postgres pg_dump -U postgres -d chatwoot_production -Fc > /opt/backup/cw-$(date +%F).dump
```
