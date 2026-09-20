#!/usr/bin/env node
'use strict';

/**
 * 演示页静态服务器（零依赖）
 *
 *   node serve.js              # 默认 8080
 *   PORT=8090 node serve.js
 *
 * 启动后会打印所有可用访问地址（本机 / 局域网 / 公网提示），
 * 直接把局域网或公网地址发给人即可演示。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
// 默认 8081：避开已有的 8080 测试页，需要时用 PORT=xxxx 覆盖
const PORT = Number(process.env.PORT) || 8081;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function localIPv4() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`${a.address}  (${name})`);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found: ' + rel);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  const ips = localIPv4();
  console.log('\n演示页已启动（端口 ' + PORT + '）\n');
  console.log('  本机访问   http://localhost:' + PORT + '/');
  ips.forEach((ip) => console.log('  局域网/公网  http://' + ip.split('  ')[0] + ':' + PORT + '/'));
  if (!ips.length) console.log('  （未检测到非回环 IPv4 地址）');
  console.log('\n坐席后台   http://<上面同一个主机>:3000');
  console.log('提示：演示页会自动把 Chatwoot 地址指向「同一主机名:3000」，');
  console.log('      若 Chatwoot 在别处，用 ?cw=http://IP:3000 覆盖。\n');
  console.log('按 Ctrl+C 停止。\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。换一个：PORT=8090 node serve.js\n`);
  } else {
    console.error('\n启动失败：' + e.message + '\n');
  }
  process.exit(1);
});
