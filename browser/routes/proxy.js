/**
 * Proxy configuration routes
 */

const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { getProxyConfig, updateProxyConfig } = require('../engine/proxy');

const router = express.Router();

// GET /api/proxy/config - Get proxy configuration
router.get('/config', (req, res) => {
  res.json(getProxyConfig());
});

// POST /api/proxy/config - Update proxy configuration
router.post('/config', (req, res) => {
  try {
    const { macProxyDomains, macProxyPort, proxyEnabled } = req.body;
    updateProxyConfig({ macProxyDomains, macProxyPort, proxyEnabled });
    res.json({ success: true, ...getProxyConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/proxy/test - Test Mac proxy connection
router.get('/test', (req, res) => {
  const config = getProxyConfig();
  const port = parseInt(req.query.port) || config.macProxyPort || 9999;

  const socket = net.connect({ port, host: '127.0.0.1', timeout: 3000 }, () => {
    socket.end();
    res.json({ connected: true, port });
  });

  socket.on('error', (e) => {
    res.json({ connected: false, port, error: e.message });
  });

  socket.on('timeout', () => {
    socket.destroy();
    res.json({ connected: false, port, error: 'Connection timeout' });
  });
});

// GET /api/proxy/script - Get Mac proxy script content
router.get('/script', (req, res) => {
  try {
    const scriptPath = path.join(__dirname, '..', 'mac_cdn_proxy.js');
    if (fs.existsSync(scriptPath)) {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      res.json({ success: true, content });
    } else {
      res.status(404).json({ success: false, error: 'Script file not found' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
