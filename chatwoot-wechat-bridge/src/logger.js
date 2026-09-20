const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = process.env.LOG_LEVEL || 'info', sink = console) {
  const min = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;

  const emit = (name, message, extra) => {
    if (LEVELS[name] < min) return;
    const line = `[${new Date().toISOString()}] ${name.toUpperCase().padEnd(5)} ${message}`;
    if (extra === undefined) sink.log(line);
    else sink.log(line, extra);
  };

  return {
    debug: (message, extra) => emit('debug', message, extra),
    info: (message, extra) => emit('info', message, extra),
    warn: (message, extra) => emit('warn', message, extra),
    error: (message, extra) => emit('error', message, extra)
  };
}
