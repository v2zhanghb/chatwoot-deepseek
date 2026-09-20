import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { loadConfig, validateConfig } from './config.js';
import { loadDotEnv } from './env.js';
import { createLogger } from './logger.js';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // 项目根目录的 .env 自动加载（已存在的环境变量优先）
  loadDotEnv(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));

  const config = loadConfig();
  const logger = createLogger(process.env.LOG_LEVEL || 'info');
  const { errors, warnings } = validateConfig(config);

  warnings.forEach((item) => logger.warn(item));
  if (errors.length) {
    errors.forEach((item) => logger.error(`配置缺失：${item}`));
    logger.error('请先修正 .env（参考 .env.example）再启动');
    process.exit(1);
  }

  const { server } = createApp(config, { logger });

  server.listen(config.port, () => {
    logger.info(`桥接服务已启动：http://localhost:${config.port}（模式：${config.mode}）`);
    logger.info(`微信客服回调地址：POST /wechat/callback　Chatwoot 渠道 webhook：POST /chatwoot/webhook`);
    if (config.mode === 'mock') {
      logger.info('当前为 mock 模式：出微信的消息只写入本地 outbox，可用 GET /mock/outbox 查看');
    }
  });

  const shutdown = () => {
    logger.info('收到退出信号，正在关闭…');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
