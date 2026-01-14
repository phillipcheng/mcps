/**
 * Selective proxy server for routing traffic
 */

const http = require('http');
const net = require('net');
const { LOCAL_PROXY_PORT, defaultProxyConfig } = require('../config');

let localProxyServer = null;
let proxyConfig = { ...defaultProxyConfig };

/**
 * Get current proxy configuration
 * @returns {Object} Proxy configuration
 */
function getProxyConfig() {
  return proxyConfig;
}

/**
 * Update proxy configuration
 * @param {Object} updates - Configuration updates
 */
function updateProxyConfig(updates) {
  if (updates.macProxyDomains) proxyConfig.macProxyDomains = updates.macProxyDomains;
  if (updates.macProxyPort) proxyConfig.macProxyPort = updates.macProxyPort;
  if (typeof updates.proxyEnabled === 'boolean') proxyConfig.proxyEnabled = updates.proxyEnabled;
}

/**
 * Connect through Mac proxy helper
 */
function connectViaMac(hostname, targetPort, clientSocket, head, macPort) {
  const macSocket = net.connect(macPort, '127.0.0.1', () => {
    macSocket.write(`CONNECT ${hostname}:${targetPort} HTTP/1.1\r\nHost: ${hostname}:${targetPort}\r\n\r\n`);
  });

  let connected = false;
  macSocket.on('data', (data) => {
    if (!connected) {
      const response = data.toString();
      if (response.includes('200')) {
        connected = true;
        try {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) macSocket.write(head);
          macSocket.pipe(clientSocket).on('error', () => {});
          clientSocket.pipe(macSocket).on('error', () => {});
        } catch(e) {}
      } else {
        console.log(`[MAC FAIL] ${hostname}`);
        try { clientSocket.end(); macSocket.end(); } catch(e) {}
      }
    }
  });

  macSocket.on('error', (e) => {
    console.log(`[MAC ERR] ${hostname} - ${e.message}`);
    try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch(e) {}
  });

  clientSocket.on('error', () => {
    try { macSocket.destroy(); } catch(e) {}
  });
}

/**
 * Create selective proxy server
 * Routes CDN domains through Mac proxy, others direct
 * @returns {Promise} Resolves when proxy is ready
 */
function createSelectiveProxy() {
  return new Promise((resolve) => {
    if (localProxyServer) {
      resolve(localProxyServer);
      return;
    }

    const server = http.createServer((req, res) => {
      res.writeHead(400);
      res.end('Use CONNECT for HTTPS');
    });

    server.on('connect', (req, clientSocket, head) => {
      const [hostname, port] = req.url.split(':');
      const targetPort = parseInt(port) || 443;
      const macPort = proxyConfig.macProxyPort;
      const macProxyDomains = proxyConfig.macProxyDomains || [];

      // Check if this domain should go through Mac proxy
      const useMacProxy = macProxyDomains.some(d => hostname.includes(d));

      if (useMacProxy) {
        console.log(`[MAC] ${hostname}:${targetPort}`);
        connectViaMac(hostname, targetPort, clientSocket, head, macPort);
        return;
      }

      // Direct connection for other domains
      console.log(`[DIRECT] ${hostname}:${targetPort}`);
      const serverSocket = net.connect(targetPort, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        serverSocket.write(head);
        serverSocket.pipe(clientSocket).on('error', () => {});
        clientSocket.pipe(serverSocket).on('error', () => {});
      });

      serverSocket.on('error', (e) => {
        if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') {
          console.log(`[FALLBACK] ${hostname}:${targetPort} -> Mac proxy (DNS failed)`);
          connectViaMac(hostname, targetPort, clientSocket, head, macPort);
        } else {
          console.log(`[DIRECT] Error ${hostname}: ${e.message}`);
          try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch(e) {}
        }
      });

      clientSocket.on('error', () => {
        try { serverSocket.destroy(); } catch(e) {}
      });
    });

    server.on('error', (e) => {
      console.log(`[PROXY SERVER] ${e.message}`);
      if (e.code === 'EADDRINUSE') {
        console.log(`[PROXY] Port ${LOCAL_PROXY_PORT} already in use, assuming existing proxy is working`);
        localProxyServer = { existing: true };
        resolve(localProxyServer);
      }
    });

    server.listen(LOCAL_PROXY_PORT, '127.0.0.1', () => {
      console.log(`[PROXY] Selective proxy running on port ${LOCAL_PROXY_PORT}`);
      console.log(`[PROXY] Mac proxy domains -> Route through Mac (port ${proxyConfig.macProxyPort})`);
      console.log(`[PROXY] Other traffic -> Direct connection`);
      localProxyServer = server;
      resolve(server);
    });
  });
}

module.exports = {
  createSelectiveProxy,
  getProxyConfig,
  updateProxyConfig,
  LOCAL_PROXY_PORT
};
