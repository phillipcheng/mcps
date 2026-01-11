#!/usr/bin/env node
/**
 * CDN Proxy Server - Run this on your Mac
 *
 * This creates an HTTP proxy that forwards requests to cdn-tos.bytedance.net
 *
 * SETUP:
 * 1. Copy this file to your Mac
 * 2. On Mac: node mac_cdn_proxy.js
 * 3. On Mac: ssh -R 9999:localhost:9999 yi.cheng1@devbox "sleep infinity"
 * 4. On devbox: Test with curl --proxy http://localhost:9999 https://cdn-tos.bytedance.net/
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 9999;

const server = http.createServer((req, res) => {
  const targetUrl = req.url.startsWith('http') ? req.url : `https://${req.headers.host}${req.url}`;
  console.log(`[PROXY] ${req.method} ${targetUrl}`);

  try {
    const parsed = new URL(targetUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers, host: parsed.hostname }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      console.log(`[PROXY] ${proxyRes.statusCode} ${targetUrl.substring(0, 60)}`);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      console.error(`[ERROR] ${e.message}`);
      res.writeHead(502);
      res.end(`Proxy Error: ${e.message}`);
    });

    req.pipe(proxyReq);
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    res.writeHead(500);
    res.end(e.message);
  }
});

// Handle HTTPS CONNECT tunneling
server.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':');
  console.log(`[CONNECT] ${hostname}:${port}`);

  const serverSocket = require('net').connect(port || 443, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', (e) => {
    console.error(`[CONNECT ERROR] ${e.message}`);
    clientSocket.end();
  });

  clientSocket.on('error', (e) => {
    console.error(`[CLIENT ERROR] ${e.message}`);
    serverSocket.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           CDN Proxy Server Started on port ${PORT}            ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  Next steps:                                               ║
║                                                            ║
║  1. Keep this running                                      ║
║                                                            ║
║  2. In another terminal on Mac, run:                       ║
║     ssh -R 9999:localhost:9999 yi.cheng1@DEVBOX_IP         ║
║                                                            ║
║  3. On devbox, test with:                                  ║
║     curl -x http://localhost:9999 https://cdn-tos.bytedance.net/ ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);
});
