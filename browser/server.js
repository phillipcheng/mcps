#!/usr/bin/env node

/**
 * Browser Automation Server
 * Entry point that initializes all modules and starts the server
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

// Configuration
const { PORT } = require('./config');

// Database
const { initDatabase } = require('./database');
const { saveTaskToDb } = require('./database/tasks');
const { saveScreenshotToDb } = require('./database/screenshots');

// Engine modules
const {
  createBrowserPool,
  createSelectiveProxy,
  getProxyConfig,
  LOCAL_PROXY_PORT,
  loadCookies,
  convertToPuppeteerCookies,
  pollForCondition,
  handleTaskError,
  getBrowserPid,
  forceKillBrowser,
  cleanupOrphanedBrowsers
} = require('./engine');

// Task runners
const { createTaskRunners } = require('./tasks');

// Routes
const { createRoutes } = require('./routes');

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory stores
const tasks = new Map();
const screenshots = new Map();
const runningBrowsers = new Map();

// Create browser pool
const browserPool = createBrowserPool();

// Build context for dependency injection
const ctx = {
  tasks,
  screenshots,
  runningBrowsers,
  browserPool,
  proxyConfig: getProxyConfig(),
  LOCAL_PROXY_PORT,
  saveScreenshotToDb,
  saveTaskToDb,
  createSelectiveProxy,
  getBrowserPid,
  forceKillBrowser,
  loadCookies,
  convertToPuppeteerCookies,
  handleTaskError: (opts) => handleTaskError({
    ...opts,
    runningBrowsers,
    saveTaskToDb,
    forceKillBrowser
  }),
  pollForCondition
};

// Create task runners with context
const taskRunners = createTaskRunners(ctx);
ctx.taskRunners = taskRunners;

// Mount routes
app.use(createRoutes(ctx));

// Cleanup interval - run every 5 minutes
setInterval(() => {
  const hasRunningTasks = [...tasks.values()].some(t => t.status === 'running');
  if (hasRunningTasks) {
    console.log('[CLEANUP] Skipping cleanup - tasks are running');
    return;
  }
  if (browserPool.inUse) {
    console.log('[CLEANUP] Skipping cleanup - browser pool in use');
    return;
  }
  cleanupOrphanedBrowsers(runningBrowsers, browserPool).then(count => {
    if (count > 0) {
      console.log(`[CLEANUP] Cleaned up ${count} orphaned browser processes`);
    }
  });
}, 5 * 60 * 1000);

// Start server
async function startServer() {
  // Initialize database
  await initDatabase();

  // Start selective proxy
  await createSelectiveProxy();

  // Start HTTP server
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Browser Automation UI running at:`);
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://0.0.0.0:${PORT}`);
    console.log(`\n⚠️  For Janus automation, ensure Mac proxy is running:`);
    console.log(`   Mac Terminal 1: node mac_cdn_proxy.js`);
    console.log(`   Mac Terminal 2: ssh -R 9999:localhost:9999 yi.cheng1@<devbox>\n`);
  });
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  await browserPool.close(console.log);
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down...');
  await browserPool.close(console.log);
  process.exit(0);
});

// Start the server
startServer().catch(console.error);
