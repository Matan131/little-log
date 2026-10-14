const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const RELOAD_PORT = 35729;

const clients = new Set();

const reloadScript = `
<script>
  (() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(protocol + '//' + location.hostname + ':' + ${RELOAD_PORT});
    socket.addEventListener('message', (event) => {
      if (event.data === 'reload') {
        location.reload();
      }
    });
    window.addEventListener('beforeunload', () => socket.close());
  })();
</script>
`;

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
  };
  return map[ext] || 'application/octet-stream';
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    let body = content;
    if (filePath.endsWith('.html')) {
      const html = content.toString('utf8');
      const injection = html.includes('</body>') ? html.replace('</body>', `${reloadScript}\n</body>`) : `${html}\n${reloadScript}`;
      body = Buffer.from(injection, 'utf8');
    }

    res.writeHead(200, { 'Content-Type': getContentType(filePath) });
    res.end(body);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const safePath = path.normalize(urlPath).replace(/^\.\.(?:\/|\\|$)/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    sendFile(res, filePath);
  });
});

const wsServer = new WebSocketServer({ port: RELOAD_PORT });
wsServer.on('connection', (socket) => {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
});

fs.watch(ROOT, { recursive: true }, (eventType, filename) => {
  if (!filename || filename.startsWith('.git') || filename.includes('node_modules')) return;
  for (const socket of clients) {
    if (socket.readyState === 1) {
      socket.send('reload');
    }
  }
});

server.listen(PORT, () => {
  console.log(`Local dev server running at http://localhost:${PORT}`);
  console.log(`Live reload socket running at ws://localhost:${RELOAD_PORT}`);
});

process.on('SIGINT', () => {
  wsServer.close();
  server.close(() => process.exit(0));
});
