#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const http = require('http');
const net = require('net');
const mysql = require('mysql2/promise');
const { createJanusTaskRunner, createWorkorderTaskRunner } = require('./janus_mini');

/**
 * Utility: Poll for a condition with timeout and logging
 * @param {Function} checkFn - Async function that returns {ready: boolean, ...status}
 * @param {Object} options - {timeout, interval, description, log}
 * @returns {Object} Final check result
 */
async function pollForCondition(checkFn, options = {}) {
  const { timeout = 30000, interval = 1000, description = 'condition', log = console.log } = options;
  const maxAttempts = Math.ceil(timeout / interval);
  let consecutiveErrors = 0;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await checkFn();
      consecutiveErrors = 0; // Reset on success
      if (result.ready) {
        log(`[${description}] Ready after ${((i + 1) * interval / 1000).toFixed(1)}s: ${JSON.stringify(result).substring(0, 100)}`);
        return result;
      }
      // Log progress every 3 seconds
      if ((i * interval) % 3000 === 0) {
        log(`[${description}] ${(i * interval / 1000)}s: ${JSON.stringify(result).substring(0, 80)}`);
      }
    } catch (e) {
      consecutiveErrors++;
      log(`[${description}] Error at ${(i * interval / 1000)}s: ${e.message.substring(0, 50)}`);

      // Fail fast on fatal errors (browser disconnected, frame detached, session closed)
      const fatalErrors = ['detached Frame', 'Session closed', 'Target closed', 'Browser disconnected', 'not defined'];
      if (fatalErrors.some(err => e.message.includes(err))) {
        log(`[${description}] Fatal error detected, aborting poll`);
        return { ready: false, fatalError: true, error: e.message };
      }

      // Fail after 5 consecutive errors
      if (consecutiveErrors >= 5) {
        log(`[${description}] Too many consecutive errors (${consecutiveErrors}), aborting poll`);
        return { ready: false, tooManyErrors: true, error: e.message };
      }
    }
    await new Promise(r => setTimeout(r, interval));
  }

  log(`[${description}] Timeout after ${timeout / 1000}s`);
  return { ready: false, timedOut: true };
}

const app = express();
const PORT = process.env.PORT || 3456;
const MAC_PROXY_PORT = 9999;  // Mac proxy via SSH tunnel
const LOCAL_PROXY_PORT = 8888;  // Local selective proxy

// Common browser args for stability on Linux/devbox
const COMMON_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',           // Prevent crashes due to limited shared memory
  '--disable-gpu',                      // More stable rendering
  '--disable-software-rasterizer',      // More stable rendering
  '--disable-features=IsolateOrigins,site-per-process,ServiceWorker',  // Help with iframes, disable SW
  '--disable-extensions',               // No extensions
  '--disable-background-networking',    // Reduce background activity
  '--disable-sync',                     // No sync
  '--disable-translate',                // No translate
  '--disable-default-apps',             // No default apps
  '--no-first-run',                     // Skip first run
  '--disable-component-update',         // No component updates
  '--disable-domain-reliability',       // No domain reliability
  '--js-flags=--max-old-space-size=1024' // Increase JS heap
];

// Browser pool for reusing browser instances
const browserPool = {
  browser: null,
  pid: null,
  lastUsed: null,
  createdAt: null,
  inUse: false,
  idleTimeout: 5 * 60 * 1000, // Close browser after 5 minutes idle
  maxAge: 10 * 60 * 1000, // Force new browser after 10 minutes
  idleTimer: null,
  urlHistory: [], // Track visited URLs
  taskHistory: [], // Track tasks that used this browser

  async getBrowser(browserArgs, log = console.log) {
    // Clear idle timer since we're using the browser
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Check if existing browser is still connected and not too old
    if (this.browser) {
      const age = Date.now() - (this.createdAt || 0);
      if (age > this.maxAge) {
        log(`[BrowserPool] Browser too old (${Math.round(age / 1000)}s), closing...`);
        try {
          await this.browser.close();
        } catch (e) {
          log(`[BrowserPool] Error closing old browser: ${e.message}`);
        }
        this.browser = null;
        this.pid = null;
      } else {
        try {
          // Test if browser is still alive
          const pages = await this.browser.pages();
          log(`[BrowserPool] Reusing cached browser (${pages.length} existing pages, age=${Math.round(age / 1000)}s)`);
          this.lastUsed = Date.now();
          this.inUse = true;
          return { browser: this.browser, pid: this.pid, cached: true };
        } catch (e) {
          log(`[BrowserPool] Cached browser disconnected: ${e.message}`);
          this.browser = null;
          this.pid = null;
        }
      }
    }

    // Launch new browser with common + task-specific args
    log('[BrowserPool] Launching new browser...');
    const allArgs = [...COMMON_BROWSER_ARGS, ...browserArgs.filter(arg => !COMMON_BROWSER_ARGS.includes(arg))];
    const browser = await puppeteer.launch({
      headless: 'new',  // Use new headless mode for better compatibility
      args: allArgs,
      protocolTimeout: 300000  // 5 minutes for heavy pages like Work Order Details
    });

    const proc = browser.process();
    const pid = proc ? proc.pid : null;

    this.browser = browser;
    this.pid = pid;
    this.lastUsed = Date.now();
    this.createdAt = Date.now();
    this.inUse = true;
    this.urlHistory = []; // Reset history for new browser
    this.taskHistory = [];

    // Handle browser disconnection
    browser.on('disconnected', () => {
      log('[BrowserPool] Browser disconnected');
      if (this.browser === browser) {
        this.browser = null;
        this.pid = null;
        this.inUse = false;
      }
    });

    log(`[BrowserPool] New browser launched with PID: ${pid}`);
    return { browser, pid, cached: false };
  },

  // Record a URL visit
  recordUrl(url, taskId = null) {
    if (!url || url === 'about:blank') return;
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      const entry = {
        url: url.substring(0, 200), // Truncate long URLs
        domain,
        taskId,
        time: new Date().toISOString()
      };
      this.urlHistory.push(entry);
      // Keep only last 50 URLs
      if (this.urlHistory.length > 50) {
        this.urlHistory = this.urlHistory.slice(-50);
      }
    } catch (e) {
      // Invalid URL, ignore
    }
  },

  // Record task usage
  recordTask(taskId, taskType) {
    this.taskHistory.push({
      taskId,
      taskType,
      time: new Date().toISOString()
    });
    // Keep only last 20 tasks
    if (this.taskHistory.length > 20) {
      this.taskHistory = this.taskHistory.slice(-20);
    }
  },

  release(log = console.log) {
    this.inUse = false;
    this.lastUsed = Date.now();

    // Set idle timer to close browser after idle period
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(async () => {
      if (!this.inUse && this.browser) {
        log('[BrowserPool] Closing idle browser');
        try {
          await this.browser.close();
        } catch (e) {
          // Browser may already be closed
        }
        this.browser = null;
        this.pid = null;
      }
    }, this.idleTimeout);

    log('[BrowserPool] Browser released back to pool');
  },

  async close(log = console.log) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      log('[BrowserPool] Closing browser');
      try {
        await this.browser.close();
      } catch (e) {
        // Force kill if close fails
        if (this.pid) {
          try { process.kill(this.pid, 'SIGKILL'); } catch (e) {}
        }
      }
      this.browser = null;
      this.pid = null;
      this.inUse = false;
      this.urlHistory = [];
      this.taskHistory = [];
      this.createdAt = null;
    }
  },

  getStatus() {
    // Get unique domains from URL history
    const domains = [...new Set(this.urlHistory.map(h => h.domain))];
    return {
      hasInstance: !!this.browser,
      inUse: this.inUse,
      pid: this.pid,
      createdAt: this.createdAt ? new Date(this.createdAt).toISOString() : null,
      lastUsed: this.lastUsed ? new Date(this.lastUsed).toISOString() : null,
      idleSec: this.lastUsed ? Math.round((Date.now() - this.lastUsed) / 1000) : null,
      uptimeSec: this.createdAt ? Math.round((Date.now() - this.createdAt) / 1000) : null,
      urlCount: this.urlHistory.length,
      domains,
      recentUrls: this.urlHistory.slice(-10).reverse(), // Last 10 URLs, newest first
      taskCount: this.taskHistory.length,
      recentTasks: this.taskHistory.slice(-5).reverse() // Last 5 tasks
    };
  }
};

// MySQL configuration
const dbConfig = {
  host: 'fdbd:dccd:cde2:2002:4a5:6fe8:dbcb:cde0',
  port: 3306,
  user: 'oec5625254693_w',
  password: 'wzbMhIgui9Kc6JI_Td2FDbTQTmM8EiGe',
  database: 'oec_aftersale_bot',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

let dbPool = null;

// Initialize database connection and create table
async function initDatabase() {
  try {
    dbPool = mysql.createPool(dbConfig);

    // Create tasks table if not exists
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS janus_tasks (
        id VARCHAR(64) PRIMARY KEY,
        type VARCHAR(64),
        psm VARCHAR(256),
        env VARCHAR(256),
        idl_branch VARCHAR(256),
        dry_run BOOLEAN DEFAULT TRUE,
        status VARCHAR(32),
        stage VARCHAR(64),
        result TEXT,
        error TEXT,
        logs LONGTEXT,
        start_time DATETIME,
        end_time DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Add stage column if it doesn't exist (for existing tables)
    try {
      await dbPool.execute(`ALTER TABLE janus_tasks ADD COLUMN stage VARCHAR(64) AFTER status`);
    } catch (e) {
      // Column already exists, ignore
    }

    // Add api_group_id column if it doesn't exist (legacy, use metadata instead for new fields)
    try {
      await dbPool.execute(`ALTER TABLE janus_tasks ADD COLUMN api_group_id VARCHAR(64) AFTER dry_run`);
    } catch (e) {
      // Column already exists, ignore
    }

    // Add metadata JSON column for flexible attributes (no more ALTER TABLE needed)
    try {
      await dbPool.execute(`ALTER TABLE janus_tasks ADD COLUMN metadata JSON`);
    } catch (e) {
      // Column already exists, ignore
    }

    // Create screenshots table if not exists (without foreign key due to permission)
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS janus_screenshots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id VARCHAR(64) NOT NULL,
        screenshot_index INT NOT NULL,
        label VARCHAR(256),
        data LONGTEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_task_id (task_id)
      )
    `);

    // Create task type definitions table for custom task types
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS janus_task_types (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(256) NOT NULL,
        description TEXT,
        parameters JSON,
        subtasks JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    console.log('[DB] MySQL connected and tables ready');
    return true;
  } catch (error) {
    console.error('[DB] MySQL connection failed:', error.message);
    return false;
  }
}

// Save task to database
async function saveTaskToDb(taskId, task) {
  if (!dbPool) return;
  try {
    // Build metadata object for non-core fields
    const metadata = {
      api_group_id: task.api_group_id || null,
      stage: task.stage || null,
      result: task.result || null,
      name: task.name || null,
      idl_version: task.idl_version || null,
      subtasks: task.subtasks || null,
      currentIndex: task.currentIndex || 0,
      // Add any future flexible fields here
      ...(task.metadata || {})  // Preserve any existing metadata
    };

    await dbPool.execute(`
      INSERT INTO janus_tasks (id, type, psm, env, idl_branch, dry_run, api_group_id, status, stage, result, error, logs, start_time, end_time, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        psm = VALUES(psm),
        env = VALUES(env),
        idl_branch = VALUES(idl_branch),
        dry_run = VALUES(dry_run),
        api_group_id = VALUES(api_group_id),
        status = VALUES(status),
        stage = VALUES(stage),
        result = VALUES(result),
        error = VALUES(error),
        logs = VALUES(logs),
        end_time = VALUES(end_time),
        metadata = VALUES(metadata)
    `, [
      taskId,
      task.type || null,
      task.psm || null,
      task.env || null,
      task.idl_branch || null,
      task.dry_run !== undefined ? task.dry_run : null,
      task.api_group_id || null,
      task.status || null,
      task.stage || null,
      task.result || null,
      task.error || null,
      JSON.stringify(task.logs || []),
      task.startTime ? new Date(task.startTime) : null,
      task.endTime ? new Date(task.endTime) : null,
      JSON.stringify(metadata)
    ]);
  } catch (error) {
    console.error('[DB] Save task error:', error.message);
  }
}

// Helper: Convert DB row to task object (handles metadata)
function dbRowToTask(row) {
  // Parse metadata JSON
  let metadata = {};
  try {
    metadata = row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {};
  } catch (e) { /* ignore */ }

  return {
    id: row.id,
    type: row.type,
    name: metadata.name || null,
    psm: row.psm,
    env: row.env,
    idl_branch: row.idl_branch,
    idl_version: metadata.idl_version || null,
    dry_run: row.dry_run === 1 || row.dry_run === true,
    api_group_id: row.api_group_id || metadata.api_group_id || null,
    status: row.status,
    stage: row.stage || metadata.stage || null,
    result: row.result || metadata.result || null,
    error: row.error,
    logs: row.logs ? (typeof row.logs === 'string' ? JSON.parse(row.logs) : row.logs) : [],
    startTime: row.start_time ? (row.start_time instanceof Date ? row.start_time.toISOString() : row.start_time) : null,
    endTime: row.end_time ? (row.end_time instanceof Date ? row.end_time.toISOString() : row.end_time) : null,
    subtasks: metadata.subtasks || null,
    currentIndex: metadata.currentIndex || 0,
    metadata  // Include full metadata for future fields
  };
}

// Load tasks from database
async function loadTasksFromDb() {
  if (!dbPool) return [];
  try {
    const [rows] = await dbPool.execute('SELECT * FROM janus_tasks ORDER BY created_at DESC LIMIT 100');
    return rows.map(dbRowToTask);
  } catch (error) {
    console.error('[DB] Load tasks error:', error.message);
    return [];
  }
}

// Get single task from database
async function getTaskFromDb(taskId) {
  if (!dbPool) return null;
  try {
    const [rows] = await dbPool.execute('SELECT * FROM janus_tasks WHERE id = ?', [taskId]);
    if (rows.length === 0) return null;
    return dbRowToTask(rows[0]);
  } catch (error) {
    console.error('[DB] Get task error:', error.message);
    return null;
  }
}

// Selective proxy server - routes CDN through Mac proxy, others direct
let localProxyServer = null;

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
      const macPort = proxyConfig.macProxyPort || MAC_PROXY_PORT;
      const macProxyDomains = proxyConfig.macProxyDomains || [];

      // Check if this domain should go through Mac proxy
      const useMacProxy = macProxyDomains.some(d => hostname.includes(d));

      if (useMacProxy) {
        // Route through Mac proxy immediately
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
        // On DNS error, try Mac proxy as fallback
        if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') {
          console.log(`[FALLBACK] ${hostname}:${targetPort} → Mac proxy (DNS failed)`);
          connectViaMac(hostname, targetPort, clientSocket, head, macPort);
        } else {
          console.log(`[DIRECT] Error ${hostname}: ${e.message}`);
          try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch(e) {}
        }
      });
      clientSocket.on('error', () => { try { serverSocket.destroy(); } catch(e) {} });
    });

    // Helper to connect through Mac proxy
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

    server.on('error', (e) => {
      console.log(`[PROXY SERVER] ${e.message}`);
      if (e.code === 'EADDRINUSE') {
        // Port already in use - assume previous proxy is still running
        console.log(`[PROXY] Port ${LOCAL_PROXY_PORT} already in use, assuming existing proxy is working`);
        localProxyServer = { existing: true };
        resolve(localProxyServer);
      }
    });

    server.listen(LOCAL_PROXY_PORT, '127.0.0.1', () => {
      console.log(`[PROXY] Selective proxy running on port ${LOCAL_PROXY_PORT}`);
      console.log(`[PROXY] Mac proxy domains → Route through Mac (port ${proxyConfig.macProxyPort || MAC_PROXY_PORT})`);
      console.log(`[PROXY] Other traffic → Direct connection`);
      console.log(`[PROXY] Mac proxy domains: ${(proxyConfig.macProxyDomains || []).join(', ') || 'none'}`);
      localProxyServer = server;
      resolve(server);
    });
  });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Store for tasks and screenshots (in-memory cache for running tasks)
const tasks = new Map();
const screenshots = new Map();
const runningBrowsers = new Map(); // Track browser instances for running tasks: { browser, pid, startTime }

// Get browser process PID
function getBrowserPid(browser) {
  try {
    const proc = browser.process();
    return proc ? proc.pid : null;
  } catch (e) {
    return null;
  }
}

// Force kill browser by PID
function forceKillBrowser(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (e) {
    // Process might already be dead
    return false;
  }
}

/**
 * Common error handler for crawl tasks
 * Takes final screenshot, updates task status, cleans up browser
 * @param {Object} options - Error handling options
 * @param {string} options.taskId - Task ID
 * @param {Object} options.task - Task object
 * @param {Error} options.error - The error that occurred
 * @param {Object} options.browser - Puppeteer browser instance
 * @param {Function} options.log - Logging function
 * @param {Function} options.addScreenshot - Screenshot function
 */
async function handleTaskError({ taskId, task, error, browser, log, addScreenshot }) {
  log(`ERROR: ${error.message}`);

  // Take final screenshot for debugging
  if (browser) {
    try {
      const pages = await browser.pages();
      if (pages.length > 0) {
        const currentPage = pages[pages.length - 1];
        const currentUrl = currentPage.url();
        log(`Final URL: ${currentUrl}`);

        // Get page content preview for debugging
        try {
          const preview = await currentPage.evaluate(() => {
            return document.body.innerText.substring(0, 500).replace(/\s+/g, ' ');
          });
          log(`Page preview: ${preview.substring(0, 200)}...`);
        } catch (e) { /* ignore */ }

        await addScreenshot(currentPage, 'error_final');
      }
    } catch (ssErr) {
      log(`Could not capture error screenshot: ${ssErr.message}`);
    }
  }

  // Update task status
  task.status = 'error';
  task.error = error.message;
  task.endTime = new Date().toISOString();
  await saveTaskToDb(taskId, task);

  // Cleanup browser
  if (browser) {
    const browserInfo = runningBrowsers.get(taskId);
    try {
      await browser.close();
      log('Browser closed');
    } catch (e) {
      if (browserInfo && browserInfo.pid) {
        forceKillBrowser(browserInfo.pid);
      }
    }
    runningBrowsers.delete(taskId);
  }
}

// Clean up orphaned Chrome processes (safety net)
// Only kills MAIN browser processes that are not tracked, not child processes
async function cleanupOrphanedBrowsers() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    // Find only MAIN Chrome processes (those with --remote-debugging-port, which are the parent browser processes)
    // Child processes (renderer, gpu, utility) don't have this flag
    exec(`ps aux | grep puppeteer_dev_chrome_profile | grep "remote-debugging-port" | grep -v grep | awk '{print $2}'`, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(0);
        return;
      }

      const pids = stdout.trim().split('\n').filter(p => p);
      const knownPids = new Set();

      // Get PIDs we're tracking
      for (const [taskId, info] of runningBrowsers) {
        if (info.pid) knownPids.add(String(info.pid));
      }

      // Also include browser pool's PID
      if (browserPool.pid) {
        knownPids.add(String(browserPool.pid));
      }

      // Kill any MAIN Chrome processes we're not tracking
      let killed = 0;
      for (const pid of pids) {
        if (!knownPids.has(pid)) {
          try {
            process.kill(parseInt(pid), 'SIGKILL');
            console.log(`[CLEANUP] Killed orphaned Chrome main process: ${pid}`);
            killed++;
          } catch (e) {
            // Process might already be dead
          }
        }
      }
      resolve(killed);
    });
  });
}

// Run cleanup every 5 minutes (only when no tasks are running)
setInterval(() => {
  // Skip cleanup if any tasks are running
  const hasRunningTasks = [...tasks.values()].some(t => t.status === 'running');
  if (hasRunningTasks) {
    console.log('[CLEANUP] Skipping cleanup - tasks are running');
    return;
  }
  // Skip cleanup if browser pool is in use
  if (browserPool.inUse) {
    console.log('[CLEANUP] Skipping cleanup - browser pool in use');
    return;
  }
  cleanupOrphanedBrowsers().then(count => {
    if (count > 0) {
      console.log(`[CLEANUP] Cleaned up ${count} orphaned browser processes`);
    }
  });
}, 5 * 60 * 1000);

// Save screenshot to database
async function saveScreenshotToDb(taskId, index, label, data) {
  if (!dbPool) return;
  try {
    await dbPool.execute(`
      INSERT INTO janus_screenshots (task_id, screenshot_index, label, data, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `, [taskId, index, label, data]);
  } catch (error) {
    console.error('[DB] Save screenshot error:', error.message);
  }
}

// Load screenshots from database
async function loadScreenshotsFromDb(taskId) {
  if (!dbPool) return [];
  try {
    const [rows] = await dbPool.execute(
      'SELECT screenshot_index, label, data, created_at FROM janus_screenshots WHERE task_id = ? ORDER BY screenshot_index',
      [taskId]
    );
    return rows.map(row => ({
      label: row.label,
      data: row.data,
      time: row.created_at ? row.created_at.toISOString() : null
    }));
  } catch (error) {
    console.error('[DB] Load screenshots error:', error.message);
    return [];
  }
}

// Delete screenshots from database
async function deleteScreenshotsFromDb(taskId) {
  if (!dbPool) return;
  try {
    await dbPool.execute('DELETE FROM janus_screenshots WHERE task_id = ?', [taskId]);
  } catch (error) {
    console.error('[DB] Delete screenshots error:', error.message);
  }
}

// Cookie management
const COOKIE_FILE = path.join(__dirname, 'cookies.json');

function loadCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveCookies(cookies) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

function convertToPuppeteerCookies(rawCookies) {
  return rawCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'unspecified' ? 'Lax' : c.sameSite)
  }));
}

// API: Get cookies
app.get('/api/cookies', (req, res) => {
  const cookies = loadCookies();
  res.json({ count: cookies.length, cookies });
});

// API: Upload cookies (with optional merge)
app.post('/api/cookies', (req, res) => {
  try {
    const newCookies = req.body;
    const merge = req.query.merge === 'true';

    if (!Array.isArray(newCookies)) {
      return res.status(400).json({ error: 'Cookies must be an array' });
    }

    let finalCookies;
    if (merge) {
      // Merge: update existing cookies by name+domain, add new ones
      const existingCookies = loadCookies();
      const cookieMap = new Map();

      // Add existing cookies to map
      existingCookies.forEach(c => {
        const key = `${c.name}|${c.domain}`;
        cookieMap.set(key, c);
      });

      // Merge/overwrite with new cookies
      newCookies.forEach(c => {
        const key = `${c.name}|${c.domain}`;
        cookieMap.set(key, c);
      });

      finalCookies = Array.from(cookieMap.values());
    } else {
      finalCookies = newCookies;
    }

    saveCookies(finalCookies);
    res.json({ success: true, count: finalCookies.length, merged: merge });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy configuration (in-memory, will reset on restart)
let proxyConfig = {
  // Domains that must go through Mac proxy (devbox can't access directly)
  macProxyDomains: [
    'cdn-tos.bytedance.net',
    'cdn-tos-cn.bytedance.net',
    'cdn-tos-sg.byteintl.net',
    'cdn-tos-va.byteintl.net',
    'lf3-short.ibytedapm.com',
    'office-cdn.bytedance.net',
    'sso.bytedance.com',
    'larksuitecdn.com',
    'feishu.cn',
    'bits.bytedance.net',  // Work order iframe
    'oncall2-online.gf.bytedance.net'  // Oncall chat iframe
  ],
  macProxyPort: 9999,
  proxyEnabled: true  // Mac proxy enabled by default
};

// Initialize Janus task runner with dependencies
const runJanusTask = createJanusTaskRunner({
  screenshots,
  runningBrowsers,
  proxyConfig,
  LOCAL_PROXY_PORT,
  saveScreenshotToDb,
  saveTaskToDb,
  createSelectiveProxy,
  getBrowserPid,
  forceKillBrowser,
  loadCookies,
  convertToPuppeteerCookies,
  handleTaskError,
  pollForCondition,
  browserPool
});

// Initialize Workorder task runner with same dependencies
const runWorkorderTask = createWorkorderTaskRunner({
  screenshots,
  runningBrowsers,
  proxyConfig,
  LOCAL_PROXY_PORT,
  saveScreenshotToDb,
  saveTaskToDb,
  createSelectiveProxy,
  getBrowserPid,
  forceKillBrowser,
  loadCookies,
  convertToPuppeteerCookies,
  handleTaskError,
  pollForCondition,
  browserPool
});

// API: Get proxy configuration
app.get('/api/proxy/config', (req, res) => {
  res.json(proxyConfig);
});

// API: Update proxy configuration
app.post('/api/proxy/config', (req, res) => {
  try {
    const { macProxyDomains, macProxyPort, proxyEnabled } = req.body;
    if (macProxyDomains) proxyConfig.macProxyDomains = macProxyDomains;
    if (macProxyPort) proxyConfig.macProxyPort = macProxyPort;
    if (typeof proxyEnabled === 'boolean') proxyConfig.proxyEnabled = proxyEnabled;
    res.json({ success: true, ...proxyConfig });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Test Mac proxy connection
// API: Get browser pool status
app.get('/api/browser/status', (req, res) => {
  res.json(browserPool.getStatus());
});

// API: Close browser pool (force close cached browser)
app.post('/api/browser/close', async (req, res) => {
  await browserPool.close(console.log);
  res.json({ success: true, message: 'Browser pool closed' });
});

app.get('/api/proxy/test', (req, res) => {
  const port = parseInt(req.query.port) || proxyConfig.macProxyPort || 9999;

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

// API: Get Mac proxy script content
app.get('/api/proxy/script', (req, res) => {
  try {
    const scriptPath = path.join(__dirname, 'mac_cdn_proxy.js');
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

// API: Get all tasks (with optional search by psm, idl_branch, status)
app.get('/api/tasks', async (req, res) => {
  try {
    const { psm, idl_branch, status } = req.query;

    // First get from database
    const dbTasks = await loadTasksFromDb();

    // Merge with in-memory tasks (for running tasks not yet saved)
    const memoryTasks = Array.from(tasks.entries()).map(([id, task]) => ({
      id,
      type: task.type,
      name: task.name,
      psm: task.psm,
      env: task.env,
      idl_branch: task.idl_branch,
      idl_version: task.idl_version,
      api_group_id: task.api_group_id,
      dry_run: task.dry_run,
      status: task.status,
      stage: task.stage,
      result: task.result,
      error: task.error,
      startTime: task.startTime,
      endTime: task.endTime,
      subtasks: task.subtasks,
      currentIndex: task.currentIndex
    }));

    // Combine and deduplicate (prefer memory for running tasks)
    const taskMap = new Map();
    dbTasks.forEach(t => taskMap.set(t.id, t));
    memoryTasks.forEach(t => taskMap.set(t.id, t)); // Memory overwrites DB for same ID

    let taskList = Array.from(taskMap.values());

    // Filter out temp subtask entries (IDs containing _sub) - they are shown under parent task
    taskList = taskList.filter(t => !t.id.includes('_sub'));

    // Apply filters
    if (psm) {
      taskList = taskList.filter(t => t.psm && t.psm.toLowerCase().includes(psm.toLowerCase()));
    }
    if (idl_branch) {
      taskList = taskList.filter(t => t.idl_branch && t.idl_branch.toLowerCase().includes(idl_branch.toLowerCase()));
    }
    if (status) {
      taskList = taskList.filter(t => t.status === status);
    }

    // Sort by start time descending
    taskList.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    res.json(taskList);
  } catch (error) {
    console.error('[API] Get tasks error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Get single task
app.get('/api/tasks/:id', async (req, res) => {
  // First check in-memory (for running tasks)
  let task = tasks.get(req.params.id);

  // If not in memory, check database
  if (!task) {
    task = await getTaskFromDb(req.params.id);
  }

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // For running chained tasks, inject real-time logs from temp subtasks
  if ((task.isChained || task.subtasks) && task.status === 'running' && task.subtasks) {
    const taskCopy = JSON.parse(JSON.stringify(task));
    for (let i = 0; i < taskCopy.subtasks.length; i++) {
      const subtask = taskCopy.subtasks[i];
      if (subtask.status === 'running') {
        // Check if there's a temp task with real-time logs
        const tempTaskId = `${req.params.id}_sub${i}`;
        const tempTask = tasks.get(tempTaskId);
        if (tempTask && tempTask.logs) {
          subtask.logs = tempTask.logs;
          subtask.stage = tempTask.stage;
        }
      }
    }
    return res.json({ id: req.params.id, ...taskCopy });
  }

  res.json({ id: req.params.id, ...task });
});

// API: Delete single task
app.delete('/api/tasks/:id', async (req, res) => {
  const taskId = req.params.id;

  try {
    // Check if task is running
    const memTask = tasks.get(taskId);
    if (memTask && memTask.status === 'running') {
      return res.status(400).json({ error: 'Cannot delete running task' });
    }

    // Delete from memory
    tasks.delete(taskId);
    screenshots.delete(taskId);

    // Delete screenshots from database first (in case CASCADE doesn't work)
    await deleteScreenshotsFromDb(taskId);

    // Delete task from database
    if (dbPool) {
      await dbPool.execute('DELETE FROM janus_tasks WHERE id = ?', [taskId]);
    }

    res.json({ success: true, deleted: taskId });
  } catch (error) {
    console.error('[API] Delete task error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Update task params
app.patch('/api/tasks/:id', async (req, res) => {
  const taskId = req.params.id;
  const updates = req.body;

  try {
    // Get task from memory or database
    let task = tasks.get(taskId);
    if (!task && dbPool) {
      task = await getTaskFromDb(taskId);
    }

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status === 'running') {
      return res.status(400).json({ error: 'Cannot update running task' });
    }

    // Update allowed fields based on task type
    if ((task.isChained || task.subtasks)) {
      // Chained task: update name, type and subtasks
      if (updates.name !== undefined) {
        task.name = updates.name;
      }
      if (updates.type !== undefined) {
        task.type = updates.type;
      }
      if (updates.subtasks !== undefined && Array.isArray(updates.subtasks)) {
        // Update subtasks - convert short type names to full type names
        task.subtasks = updates.subtasks.map(st => ({
          type: st.type === 'janus' ? 'janus_mini_update' : st.type === 'workorder' ? 'janus_workorder_execute' : st.type,
          psm: st.psm,
          env: st.env,
          idl_branch: st.idl_branch,
          idl_version: st.idl_version,
          api_group_id: st.api_group_id,
          status: 'pending',
          logs: [],
          startTime: null,
          endTime: null,
          error: null,
          result: null
        }));
        task.currentIndex = 0;
      }
    } else {
      // Non-chained task: update individual fields
      const allowedFields = ['psm', 'env', 'idl_branch', 'idl_version', 'api_group_id', 'dry_run'];
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          task[field] = updates[field];
        }
      }
    }

    // Save to memory and database
    tasks.set(taskId, task);
    await saveTaskToDb(taskId, task);

    res.json({ success: true, task });
  } catch (error) {
    console.error('[API] Update task error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Batch delete tasks
app.post('/api/tasks/batch-delete', async (req, res) => {
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  try {
    const deleted = [];
    const skipped = [];

    for (const taskId of ids) {
      // Check if task is running
      const memTask = tasks.get(taskId);
      if (memTask && memTask.status === 'running') {
        skipped.push({ id: taskId, reason: 'running' });
        continue;
      }

      // Delete from memory
      tasks.delete(taskId);
      screenshots.delete(taskId);

      // Delete screenshots from database
      await deleteScreenshotsFromDb(taskId);

      deleted.push(taskId);
    }

    // Batch delete from database
    if (dbPool && deleted.length > 0) {
      const placeholders = deleted.map(() => '?').join(',');
      await dbPool.execute(`DELETE FROM janus_tasks WHERE id IN (${placeholders})`, deleted);
    }

    res.json({
      success: true,
      deleted: deleted,
      skipped: skipped,
      deletedCount: deleted.length,
      skippedCount: skipped.length
    });
  } catch (error) {
    console.error('[API] Batch delete error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Stop a running task
app.post('/api/tasks/:id/stop', async (req, res) => {
  const taskId = req.params.id;

  try {
    const task = tasks.get(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status !== 'running') {
      return res.status(400).json({ error: 'Task is not running' });
    }

    // Close the browser if it exists
    const browserInfo = runningBrowsers.get(taskId);
    if (browserInfo) {
      try {
        await browserInfo.browser.close();
        console.log(`[${taskId}] Browser closed gracefully`);
      } catch (e) {
        console.log(`[${taskId}] Browser.close() failed: ${e.message}, trying force kill...`);
        // Fallback: force kill by PID
        if (browserInfo.pid) {
          forceKillBrowser(browserInfo.pid);
          console.log(`[${taskId}] Force killed browser PID: ${browserInfo.pid}`);
        }
      }
      runningBrowsers.delete(taskId);
    }

    // If this is a chained task, also stop any running subtasks
    if (task.isChained || task.subtasks) {
      for (let i = 0; i < (task.subtasks || []).length; i++) {
        const subtaskId = `${taskId}_sub${i}`;
        const subtask = task.subtasks[i];

        // Close subtask browser if running
        const subtaskBrowserInfo = runningBrowsers.get(subtaskId);
        if (subtaskBrowserInfo) {
          try {
            await subtaskBrowserInfo.browser.close();
            console.log(`[${subtaskId}] Subtask browser closed gracefully`);
          } catch (e) {
            if (subtaskBrowserInfo.pid) {
              forceKillBrowser(subtaskBrowserInfo.pid);
              console.log(`[${subtaskId}] Force killed subtask browser PID: ${subtaskBrowserInfo.pid}`);
            }
          }
          runningBrowsers.delete(subtaskId);
        }

        // Mark subtask as stopped if it was running or pending
        if (subtask && (subtask.status === 'running' || subtask.status === 'pending')) {
          subtask.status = 'stopped';
          subtask.error = 'Parent task stopped by user';
          subtask.endTime = new Date().toISOString();
          if (!subtask.logs) subtask.logs = [];
          subtask.logs.push(`[${new Date().toISOString()}] Stopped - parent task stopped by user`);
        }

        // Also clean up temp task if exists
        const tempTask = tasks.get(subtaskId);
        if (tempTask) {
          tempTask.status = 'stopped';
          tempTask.error = 'Parent task stopped by user';
          tasks.delete(subtaskId);
        }
      }
      console.log(`[${taskId}] Stopped all subtasks`);
    }

    // Update task status
    task.status = 'stopped';
    task.error = 'Task stopped by user';
    task.endTime = new Date().toISOString();
    task.logs.push(`[${new Date().toISOString()}] Task stopped by user`);

    // Save to database
    await saveTaskToDb(taskId, task);

    res.json({ success: true, taskId, status: 'stopped' });
  } catch (error) {
    console.error('[API] Stop task error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Force kill all browser processes (emergency cleanup)
app.post('/api/browsers/kill-all', async (req, res) => {
  try {
    let killed = 0;

    // First try to close tracked browsers gracefully
    for (const [taskId, browserInfo] of runningBrowsers) {
      try {
        await browserInfo.browser.close();
        console.log(`[KILL-ALL] Closed browser for task ${taskId}`);
      } catch (e) {
        // Fallback to force kill
        if (browserInfo.pid) {
          forceKillBrowser(browserInfo.pid);
          console.log(`[KILL-ALL] Force killed browser PID ${browserInfo.pid} for task ${taskId}`);
        }
      }
      killed++;

      // Update task status
      const task = tasks.get(taskId);
      if (task && task.status === 'running') {
        task.status = 'stopped';
        task.error = 'Browser killed by admin';
        task.endTime = new Date().toISOString();
        task.logs.push(`[${new Date().toISOString()}] Browser killed by admin`);
        await saveTaskToDb(taskId, task);
      }
    }
    runningBrowsers.clear();

    // Also run orphan cleanup
    const orphansKilled = await cleanupOrphanedBrowsers();
    killed += orphansKilled;

    res.json({ success: true, killed, message: `Killed ${killed} browser processes` });
  } catch (error) {
    console.error('[API] Kill all browsers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Restart a failed or stopped task (optionally with updated params)
app.post('/api/tasks/:id/restart', async (req, res) => {
  const taskId = req.params.id;
  const updates = req.body || {};  // Optional: update params before restart

  console.log(`[API] Restart task ${taskId} with updates:`, JSON.stringify(updates));

  try {
    // First try to get from memory, then from database
    let task = tasks.get(taskId);

    if (!task) {
      const [rows] = await dbPool.query('SELECT * FROM janus_tasks WHERE id = ?', [taskId]);
      if (rows.length > 0) {
        task = dbRowToTask(rows[0]);
      }
    }

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status === 'running') {
      return res.status(400).json({ error: 'Task is already running' });
    }

    // Apply updates before restart (if any)
    const allowedFields = ['psm', 'env', 'idl_branch', 'idl_version', 'dry_run', 'api_group_id', 'name'];
    const applied = [];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        task[field] = updates[field];
        applied.push(field);
      }
    }

    // Handle subtasks update separately to convert types
    if (updates.subtasks !== undefined && Array.isArray(updates.subtasks)) {
      task.subtasks = updates.subtasks.map(st => ({
        type: st.type === 'janus' ? 'janus_mini_update' : st.type === 'workorder' ? 'janus_workorder_execute' : st.type,
        psm: st.psm,
        env: st.env,
        idl_branch: st.idl_branch,
        idl_version: st.idl_version,
        api_group_id: st.api_group_id,
        status: 'pending',
        logs: [],
        startTime: null,
        endTime: null,
        error: null,
        result: null
      }));
      applied.push('subtasks');
    }

    if (applied.length > 0) {
      console.log(`[${taskId}] Updated before restart: ${applied.join(', ')}`);
    }
    console.log(`[${taskId}] Task after updates: type=${task.type}, api_group_id=${task.api_group_id}`);

    // Reset task state for restart
    task.status = 'running';
    task.error = null;
    task.startTime = new Date().toISOString();
    task.endTime = null;
    task.logs = task.logs || [];
    task.logs.push(`[${new Date().toISOString()}] Task restarted${applied.length > 0 ? ` (updated: ${applied.join(', ')})` : ''}`);

    // For chained tasks, reset subtask statuses
    if ((task.isChained || task.subtasks) && task.subtasks) {
      for (const subtask of task.subtasks) {
        subtask.status = 'pending';
        subtask.logs = [];
        subtask.startTime = null;
        subtask.endTime = null;
        subtask.error = null;
        subtask.result = null;
      }
      task.currentIndex = 0;
    }

    // Update in memory and clear old screenshots
    tasks.set(taskId, task);
    screenshots.set(taskId, []);

    // Delete old screenshots from database
    try {
      await dbPool.query('DELETE FROM janus_screenshots WHERE task_id = ?', [taskId]);
    } catch (e) {
      console.log(`[${taskId}] Failed to delete old screenshots: ${e.message}`);
    }

    // Clear old logs on restart
    task.logs = [`[${new Date().toISOString()}] Task restarted`];

    // Save initial state to database
    await saveTaskToDb(taskId, task);

    // Return immediately
    res.json({ taskId, status: 'restarted' });

    // Run the appropriate task type in background
    if ((task.isChained || task.subtasks)) {
      runChainedTask(taskId, task).catch(async (err) => {
        task.status = 'error';
        task.error = err.message;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
      });
    } else if (task.type === 'janus_workorder_execute') {
      runWorkorderTask(taskId, task).catch(async (err) => {
        task.status = 'error';
        task.error = err.message;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
      });
    } else {
      runJanusTask(taskId, task).catch(async (err) => {
        task.status = 'error';
        task.error = err.message;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
      });
    }

  } catch (error) {
    console.error('[API] Restart task error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Get task screenshots
app.get('/api/tasks/:id/screenshots', async (req, res) => {
  const taskId = req.params.id;

  // First check in-memory (for running tasks)
  let taskScreenshots = screenshots.get(taskId);

  // If not in memory, load from database
  if (!taskScreenshots || taskScreenshots.length === 0) {
    taskScreenshots = await loadScreenshotsFromDb(taskId);
  }

  // Return without data field to reduce response size
  res.json((taskScreenshots || []).map(ss => ({ label: ss.label, time: ss.time })));
});

// API: Get specific screenshot
app.get('/api/tasks/:id/screenshots/:index', async (req, res) => {
  const taskId = req.params.id;
  const index = parseInt(req.params.index);

  // First check in-memory
  let taskScreenshots = screenshots.get(taskId);

  // If not in memory, load from database
  if (!taskScreenshots || taskScreenshots.length === 0) {
    taskScreenshots = await loadScreenshotsFromDb(taskId);
  }

  if (!taskScreenshots || index < 0 || index >= taskScreenshots.length) {
    return res.status(404).json({ error: 'Screenshot not found' });
  }

  const ss = taskScreenshots[index];
  const img = Buffer.from(ss.data, 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': img.length
  });
  res.end(img);
});

// Built-in task type definitions
const builtInTaskTypes = {
  janus: {
    name: 'Janus Mini Update',
    internalType: 'janus_mini_update',
    params: [
      { key: 'psm', label: 'PSM', required: true },
      { key: 'env', label: 'Environment', required: true },
      { key: 'idl_branch', label: 'IDL Branch', required: true },
      { key: 'idl_version', label: 'IDL Version', required: false },
      { key: 'api_group_id', label: 'API Group ID', required: false }
    ],
    runner: 'janus'
  },
  workorder: {
    name: 'Execute Workorder',
    internalType: 'janus_workorder_execute',
    params: [
      { key: 'psm', label: 'PSM', required: true },
      { key: 'env', label: 'Environment', required: true },
      { key: 'api_group_id', label: 'API Group ID', required: true }
    ],
    runner: 'workorder'
  }
};

// API: Get built-in task types
app.get('/api/builtin-types', (req, res) => {
  const types = Object.entries(builtInTaskTypes).map(([key, def]) => ({
    id: key,
    name: def.name,
    params: def.params
  }));
  res.json(types);
});

// API: Unified task creation endpoint
app.post('/api/tasks', async (req, res) => {
  const { type, parameters = {} } = req.body;

  console.log('[API] Unified create task request:', JSON.stringify(req.body));

  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }

  try {
    // Check if it's a built-in type
    const builtIn = builtInTaskTypes[type];

    if (builtIn) {
      // Validate required parameters
      for (const param of builtIn.params) {
        if (param.required && !parameters[param.key]) {
          return res.status(400).json({ error: `Missing required parameter: ${param.key}` });
        }
      }

      const taskId = `${type}_${Date.now()}`;
      const task = {
        type: builtIn.internalType,
        psm: parameters.psm,
        env: parameters.env,
        idl_branch: parameters.idl_branch || null,
        idl_version: parameters.idl_version || null,
        api_group_id: parameters.api_group_id || null,
        dry_run: parameters.dry_run !== false,
        status: 'running',
        logs: [],
        startTime: new Date().toISOString(),
        endTime: null,
        error: null
      };

      tasks.set(taskId, task);
      screenshots.set(taskId, []);
      await saveTaskToDb(taskId, task);

      res.json({ taskId, status: 'started', type: builtIn.internalType });

      // Run appropriate task runner
      const runner = builtIn.runner === 'janus' ? runJanusTask : runWorkorderTask;
      runner(taskId, task).catch(async (err) => {
        task.status = 'error';
        task.error = err.message;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
      });

    } else {
      // Check if it's a custom type from database
      const [rows] = await dbPool.execute('SELECT * FROM janus_task_types WHERE id = ? OR name = ?', [type, type]);
      if (rows.length === 0) {
        return res.status(404).json({
          error: 'Unknown task type: ' + type,
          availableBuiltIn: Object.keys(builtInTaskTypes),
          hint: 'Use GET /api/task-types to see custom types'
        });
      }

      const taskType = rows[0];
      const typeParams = typeof taskType.parameters === 'string' ? JSON.parse(taskType.parameters) : taskType.parameters;
      const typeSubtasks = typeof taskType.subtasks === 'string' ? JSON.parse(taskType.subtasks) : taskType.subtasks;

      // Validate required parameters
      for (const param of typeParams) {
        if (param.required && !parameters[param.name]) {
          return res.status(400).json({ error: `Missing required parameter: ${param.name}` });
        }
      }

      // Build subtasks by substituting parameters
      const resolvedSubtasks = typeSubtasks.map(st => {
        const resolved = {};
        for (const [key, value] of Object.entries(st)) {
          if (typeof value === 'string' && value.includes('${')) {
            // Replace all ${param} references
            let substituted = value.replace(/\$\{(\w+)\}/g, (match, paramName) => {
              return parameters[paramName] !== undefined ? parameters[paramName] : '';
            });
            // Only include the key if it has a value after substitution
            if (substituted.trim()) {
              resolved[key] = substituted.trim();
            }
          } else {
            resolved[key] = value;
          }
        }
        return resolved;
      });

      const taskId = `chained_${Date.now()}`;
      const task = {
        type: taskType.name, // Use custom task type name as the type
        name: parameters.name || taskType.name,
        isChained: true, // Flag to indicate this is a chained task
        subtasks: resolvedSubtasks.map((st, i) => ({
          type: st.type === 'janus' ? 'janus_mini_update' : st.type === 'workorder' ? 'janus_workorder_execute' : st.type,
          psm: st.psm,
          env: st.env,
          idl_branch: st.idl_branch,
          idl_version: st.idl_version,
          api_group_id: st.api_group_id,
          index: i,
          status: 'pending',
          logs: [],
          startTime: null,
          endTime: null,
          error: null,
          result: null
        })),
        currentIndex: 0,
        status: 'running',
        logs: [`[${new Date().toISOString()}] Task created from type: ${taskType.name}`],
        startTime: new Date().toISOString(),
        endTime: null,
        error: null
      };

      tasks.set(taskId, task);
      screenshots.set(taskId, []);
      await saveTaskToDb(taskId, task);

      res.json({ taskId, status: 'started', type: 'custom', taskTypeName: taskType.name, subtaskCount: task.subtasks.length });

      runChainedTask(taskId, task).catch(async (err) => {
        task.status = 'error';
        task.error = err.message;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
      });
    }

  } catch (error) {
    console.error('[API] Create task error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Start Janus Mini task (legacy endpoint)
app.post('/api/tasks/janus', async (req, res) => {
  const { psm, env, idl_branch, dry_run = true, api_group_id, idl_version } = req.body;

  console.log('[API] Create task request body:', JSON.stringify(req.body));

  if (!psm || !env || !idl_branch) {
    return res.status(400).json({ error: 'psm, env, and idl_branch are required' });
  }

  const taskId = `janus_${Date.now()}`;
  const task = {
    type: 'janus_mini_update',
    psm,
    env,
    idl_branch,
    dry_run,
    api_group_id: api_group_id || null,  // Optional: skip list search if provided
    idl_version: idl_version || null,    // Optional: specific version for downgrade
    status: 'running',
    logs: [],
    startTime: new Date().toISOString(),
    endTime: null,
    error: null
  };

  if (api_group_id) {
    console.log(`[${taskId}] Using shortcut with api_group_id: ${api_group_id}`);
  }

  tasks.set(taskId, task);
  screenshots.set(taskId, []);

  // Save initial task to database
  await saveTaskToDb(taskId, task);

  // Return immediately, run task in background
  res.json({ taskId, status: 'started' });

  // Run the task
  runJanusTask(taskId, task).catch(async (err) => {
    task.status = 'error';
    task.error = err.message;
    task.endTime = new Date().toISOString();
    await saveTaskToDb(taskId, task);
  });
});

// API: Create Janus workorder execution task
app.post('/api/tasks/janus-workorder', async (req, res) => {
  const { psm, env, api_group_id } = req.body;

  console.log('[API] Create workorder task request body:', JSON.stringify(req.body));

  if (!psm || !env || !api_group_id) {
    return res.status(400).json({ error: 'psm, env (lane), and api_group_id are required' });
  }

  const taskId = `workorder_${Date.now()}`;
  const task = {
    type: 'janus_workorder_execute',
    psm,
    env,
    api_group_id,
    status: 'running',
    logs: [],
    startTime: new Date().toISOString(),
    endTime: null,
    error: null
  };

  tasks.set(taskId, task);
  screenshots.set(taskId, []);

  // Save initial task to database
  await saveTaskToDb(taskId, task);

  // Return immediately, run task in background
  res.json({ taskId, status: 'started' });

  // Run the task
  runWorkorderTask(taskId, task).catch(async (err) => {
    task.status = 'error';
    task.error = err.message;
    task.endTime = new Date().toISOString();
    await saveTaskToDb(taskId, task);
  });
});

// API: Create chained task (multiple tasks executed sequentially)
app.post('/api/tasks/chained', async (req, res) => {
  const { name, subtasks } = req.body;

  console.log('[API] Create chained task request body:', JSON.stringify(req.body));

  if (!subtasks || !Array.isArray(subtasks) || subtasks.length === 0) {
    return res.status(400).json({ error: 'subtasks array is required and must not be empty' });
  }

  // Validate each subtask
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i];
    if (!st.type) {
      return res.status(400).json({ error: `subtask ${i} missing type` });
    }
    if (st.type === 'janus' || st.type === 'janus_mini_update') {
      if (!st.psm || !st.env || !st.idl_branch) {
        return res.status(400).json({ error: `subtask ${i} (janus) requires psm, env, idl_branch` });
      }
    } else if (st.type === 'workorder' || st.type === 'janus_workorder_execute') {
      if (!st.psm || !st.env || !st.api_group_id) {
        return res.status(400).json({ error: `subtask ${i} (workorder) requires psm, env, api_group_id` });
      }
    } else {
      return res.status(400).json({ error: `subtask ${i} has unknown type: ${st.type}` });
    }
  }

  const taskId = `chained_${Date.now()}`;
  const task = {
    type: req.body.type || 'chained',
    isChained: true,
    name: name || `Chain of ${subtasks.length} tasks`,
    subtasks: subtasks.map((st, i) => ({
      ...st,
      index: i,
      status: 'pending',
      logs: [],
      startTime: null,
      endTime: null,
      error: null,
      result: null
    })),
    currentIndex: 0,
    status: 'running',
    logs: [],
    startTime: new Date().toISOString(),
    endTime: null,
    error: null
  };

  tasks.set(taskId, task);
  screenshots.set(taskId, []);

  // Save initial task to database
  await saveTaskToDb(taskId, task);

  // Return immediately, run task in background
  res.json({ taskId, status: 'started', subtaskCount: subtasks.length });

  // Run the chained task
  runChainedTask(taskId, task).catch(async (err) => {
    task.status = 'error';
    task.error = err.message;
    task.endTime = new Date().toISOString();
    await saveTaskToDb(taskId, task);
  });
});

// ============ Task Type Definitions API ============

// API: List all task type definitions
app.get('/api/task-types', async (req, res) => {
  try {
    if (!dbPool) {
      return res.json([]);
    }
    const [rows] = await dbPool.execute('SELECT * FROM janus_task_types ORDER BY name');
    const types = rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters) : row.parameters,
      subtasks: typeof row.subtasks === 'string' ? JSON.parse(row.subtasks) : row.subtasks,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
    res.json(types);
  } catch (error) {
    console.error('[API] Get task types error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Get single task type definition
app.get('/api/task-types/:id', async (req, res) => {
  try {
    if (!dbPool) {
      return res.status(404).json({ error: 'Task type not found' });
    }
    const [rows] = await dbPool.execute('SELECT * FROM janus_task_types WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task type not found' });
    }
    const row = rows[0];
    res.json({
      id: row.id,
      name: row.name,
      description: row.description,
      parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters) : row.parameters,
      subtasks: typeof row.subtasks === 'string' ? JSON.parse(row.subtasks) : row.subtasks,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  } catch (error) {
    console.error('[API] Get task type error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Create task type definition
app.post('/api/task-types', async (req, res) => {
  const { name, description, parameters, subtasks } = req.body;

  if (!name || !parameters || !subtasks) {
    return res.status(400).json({ error: 'name, parameters, and subtasks are required' });
  }

  const id = `tasktype_${Date.now()}`;

  try {
    await dbPool.execute(
      'INSERT INTO janus_task_types (id, name, description, parameters, subtasks) VALUES (?, ?, ?, ?, ?)',
      [id, name, description || null, JSON.stringify(parameters), JSON.stringify(subtasks)]
    );
    res.json({ id, name, status: 'created' });
  } catch (error) {
    console.error('[API] Create task type error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Update task type definition
app.patch('/api/task-types/:id', async (req, res) => {
  const { name, description, parameters, subtasks } = req.body;
  const id = req.params.id;

  try {
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (parameters !== undefined) {
      updates.push('parameters = ?');
      values.push(JSON.stringify(parameters));
    }
    if (subtasks !== undefined) {
      updates.push('subtasks = ?');
      values.push(JSON.stringify(subtasks));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await dbPool.execute(`UPDATE janus_task_types SET ${updates.join(', ')} WHERE id = ?`, values);
    res.json({ id, status: 'updated' });
  } catch (error) {
    console.error('[API] Update task type error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Delete task type definition
app.delete('/api/task-types/:id', async (req, res) => {
  try {
    await dbPool.execute('DELETE FROM janus_task_types WHERE id = ?', [req.params.id]);
    res.json({ success: true, deleted: req.params.id });
  } catch (error) {
    console.error('[API] Delete task type error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// API: Create task from task type definition
app.post('/api/task-types/:id/create-task', async (req, res) => {
  const typeId = req.params.id;
  const params = req.body;  // User-provided parameter values

  try {
    // Get the task type definition
    const [rows] = await dbPool.execute('SELECT * FROM janus_task_types WHERE id = ?', [typeId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Task type not found' });
    }

    const taskType = rows[0];
    const typeParams = typeof taskType.parameters === 'string' ? JSON.parse(taskType.parameters) : taskType.parameters;
    const typeSubtasks = typeof taskType.subtasks === 'string' ? JSON.parse(taskType.subtasks) : taskType.subtasks;

    // Validate required parameters
    for (const param of typeParams) {
      if (param.required && !params[param.name]) {
        return res.status(400).json({ error: `Missing required parameter: ${param.name}` });
      }
    }

    // Build subtasks by substituting parameters
    const resolvedSubtasks = typeSubtasks.map(st => {
      const resolved = {};
      for (const [key, value] of Object.entries(st)) {
        if (typeof value === 'string' && value.includes('${')) {
          // Replace all ${param} references
          let substituted = value.replace(/\$\{(\w+)\}/g, (match, paramName) => {
            return params[paramName] !== undefined ? params[paramName] : '';
          });
          // Only include the key if it has a value after substitution
          if (substituted.trim()) {
            resolved[key] = substituted.trim();
          }
        } else {
          resolved[key] = value;
        }
      }
      return resolved;
    });

    // Create the chained task
    const taskId = `chained_${Date.now()}`;
    const task = {
      type: 'chained',
      name: params.name || taskType.name,
      subtasks: resolvedSubtasks.map((st, i) => ({
        type: st.type === 'janus' ? 'janus_mini_update' : st.type === 'workorder' ? 'janus_workorder_execute' : st.type,
        psm: st.psm,
        env: st.env,
        idl_branch: st.idl_branch,
        idl_version: st.idl_version,
        api_group_id: st.api_group_id,
        index: i,
        status: 'pending',
        logs: [],
        startTime: null,
        endTime: null,
        error: null,
        result: null
      })),
      currentIndex: 0,
      status: 'running',
      logs: [`[${new Date().toISOString()}] Task created from type: ${taskType.name}`],
      startTime: new Date().toISOString(),
      endTime: null,
      error: null
    };

    tasks.set(taskId, task);
    screenshots.set(taskId, []);
    await saveTaskToDb(taskId, task);

    res.json({ taskId, status: 'started', subtaskCount: task.subtasks.length, taskTypeName: taskType.name });

    // Run the chained task
    runChainedTask(taskId, task).catch(async (err) => {
      task.status = 'error';
      task.error = err.message;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);
    });
  } catch (error) {
    console.error('[API] Create task from type error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Run a chained task - executes subtasks sequentially
 */
async function runChainedTask(taskId, task) {
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(`[${taskId}] ${msg}`);
    task.logs.push(line);
  };

  log(`Starting chained task: ${task.name}`);
  log(`Total subtasks: ${task.subtasks.length}`);

  for (let i = 0; i < task.subtasks.length; i++) {
    const subtask = task.subtasks[i];
    task.currentIndex = i;
    task.stage = `Running subtask ${i + 1}/${task.subtasks.length}`;
    await saveTaskToDb(taskId, task);

    log(`\n=== Subtask ${i + 1}/${task.subtasks.length}: ${subtask.type} ===`);
    log(`Parameters: ${JSON.stringify({ psm: subtask.psm, env: subtask.env, idl_branch: subtask.idl_branch, api_group_id: subtask.api_group_id })}`);

    subtask.status = 'running';
    subtask.startTime = new Date().toISOString();
    await saveTaskToDb(taskId, task);

    try {
      // Create a temporary task object for the subtask
      const tempTaskId = `${taskId}_sub${i}`;
      const tempTask = {
        type: subtask.type === 'janus' ? 'janus_mini_update' :
              subtask.type === 'workorder' ? 'janus_workorder_execute' : subtask.type,
        psm: subtask.psm,
        env: subtask.env,
        idl_branch: subtask.idl_branch,
        idl_version: subtask.idl_version,
        api_group_id: subtask.api_group_id,
        status: 'running',
        logs: [],
        startTime: new Date().toISOString(),
        endTime: null,
        error: null
      };

      // Store temporarily for screenshot access
      tasks.set(tempTaskId, tempTask);
      screenshots.set(tempTaskId, []);

      // Run the appropriate task runner
      if (tempTask.type === 'janus_mini_update') {
        await runJanusTask(tempTaskId, tempTask);
      } else if (tempTask.type === 'janus_workorder_execute') {
        await runWorkorderTask(tempTaskId, tempTask);
      }

      // Copy results back to subtask
      subtask.status = tempTask.status;
      subtask.logs = tempTask.logs;
      subtask.endTime = tempTask.endTime || new Date().toISOString();
      subtask.error = tempTask.error;
      subtask.result = tempTask.result;
      subtask.stage = tempTask.stage;

      // Copy screenshots to main task
      const subScreenshots = screenshots.get(tempTaskId) || [];
      const mainScreenshots = screenshots.get(taskId) || [];
      for (const ss of subScreenshots) {
        mainScreenshots.push({
          ...ss,
          label: `[${i + 1}] ${ss.label}`
        });
      }
      screenshots.set(taskId, mainScreenshots);

      // Clean up temp task
      tasks.delete(tempTaskId);
      screenshots.delete(tempTaskId);

      // Log subtask result
      if (subtask.status === 'completed') {
        log(`Subtask ${i + 1} completed: ${subtask.result || 'Success'}`);
      } else if (subtask.status === 'error') {
        log(`Subtask ${i + 1} failed: ${subtask.error}`);
        // Stop chain on error
        task.status = 'error';
        task.error = `Subtask ${i + 1} failed: ${subtask.error}`;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
        return;
      }

    } catch (err) {
      subtask.status = 'error';
      subtask.error = err.message;
      subtask.endTime = new Date().toISOString();
      log(`Subtask ${i + 1} exception: ${err.message}`);

      // Stop chain on error
      task.status = 'error';
      task.error = `Subtask ${i + 1} exception: ${err.message}`;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);
      return;
    }

    await saveTaskToDb(taskId, task);

    // Small delay between subtasks
    if (i < task.subtasks.length - 1) {
      log('Waiting 2 seconds before next subtask...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // All subtasks completed
  task.status = 'completed';
  task.stage = 'All subtasks completed';
  task.endTime = new Date().toISOString();
  task.result = `Completed ${task.subtasks.length} subtasks`;
  log(`\n=== Chained task completed! ===`);
  log(`Total subtasks: ${task.subtasks.length}`);
  await saveTaskToDb(taskId, task);
}

// API: Browse URL (simple)
app.post('/api/browse', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    const result = await withBrowser(async (page) => {
      const cookies = convertToPuppeteerCookies(loadCookies());
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
      }

      // Navigate and wait for domcontentloaded (120s timeout for slow pages)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

      // Wait for any redirects to complete
      await new Promise(r => setTimeout(r, 2000));

      // Try to wait for network idle, but don't fail if it times out
      try {
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 5000 });
      } catch (e) {
        // Network didn't become idle, continue anyway
      }

      // Extra wait for page to stabilize after any redirects
      await new Promise(r => setTimeout(r, 1000));

      // Get page info with error handling
      let title = 'Unknown';
      let content = '';
      let finalUrl = url;

      try {
        title = await page.title();
      } catch (e) {
        title = 'Could not get title';
      }

      try {
        finalUrl = page.url();
      } catch (e) {
        finalUrl = url;
      }

      try {
        content = await page.evaluate(() => document.body.innerText.substring(0, 5000));
      } catch (e) {
        content = 'Could not get page content';
      }

      // Take screenshot
      const screenshot = await page.screenshot({ encoding: 'base64' });

      return { title, url: finalUrl, content, screenshot };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: Run browser with proper setup (respects proxy config)
async function withBrowser(action) {
  // Use common args + task-specific args
  const browserArgs = [
    ...COMMON_BROWSER_ARGS,
    '--window-size=1600,1000',
    '--force-device-scale-factor=1',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu-compositing',
    '--enable-features=NetworkService,NetworkServiceInProcess'
  ];
  if (proxyConfig.proxyEnabled) {
    await createSelectiveProxy();
    browserArgs.push(`--proxy-server=http://127.0.0.1:${LOCAL_PROXY_PORT}`);
  }

  const browser = await puppeteer.launch({
    headless: 'new',  // Use new headless mode for better compatibility
    args: browserArgs,
    protocolTimeout: 300000  // 5 minutes for heavy pages
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    return await action(page);
  } finally {
    await browser.close();
  }
}


// Create public directory if it doesn't exist
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

// NOTE: index.html is managed separately in public/index.html
// Do NOT overwrite it here - the tabbed UI is maintained in the public folder

// Start server and selective proxy
async function startServer() {
  // Initialize database connection
  await initDatabase();

  // Start selective proxy first
  await createSelectiveProxy();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Browser Automation UI running at:`);
    console.log(`   Local:   http://localhost:${PORT}`);
    console.log(`   Network: http://0.0.0.0:${PORT}`);
    console.log(`\n⚠️  For Janus automation, ensure Mac proxy is running:`);
    console.log(`   Mac Terminal 1: node mac_cdn_proxy.js`);
    console.log(`   Mac Terminal 2: ssh -R 9999:localhost:9999 yi.cheng1@<devbox>\n`);
  });
}

startServer().catch(console.error);
// Force reload Sun 11 Jan 2026 10:07:04 PM UTC
// Trigger reload Sun 11 Jan 2026 10:08:25 PM UTC
