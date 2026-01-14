/**
 * Browser pool for reusing browser instances
 */

const puppeteer = require('puppeteer');
const { COMMON_BROWSER_ARGS } = require('../config');

/**
 * Create a browser pool manager
 * @returns {Object} Browser pool instance
 */
function createBrowserPool() {
  return {
    browser: null,
    pid: null,
    lastUsed: null,
    createdAt: null,
    inUse: false,
    idleTimeout: 5 * 60 * 1000, // Close browser after 5 minutes idle
    maxAge: 10 * 60 * 1000, // Force new browser after 10 minutes
    idleTimer: null,
    urlHistory: [],
    taskHistory: [],

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

      // Launch new browser
      log('[BrowserPool] Launching new browser...');
      const allArgs = [...COMMON_BROWSER_ARGS, ...browserArgs.filter(arg => !COMMON_BROWSER_ARGS.includes(arg))];
      const browser = await puppeteer.launch({
        headless: 'new',
        args: allArgs,
        protocolTimeout: 300000
      });

      const proc = browser.process();
      const pid = proc ? proc.pid : null;

      this.browser = browser;
      this.pid = pid;
      this.lastUsed = Date.now();
      this.createdAt = Date.now();
      this.inUse = true;
      this.urlHistory = [];
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

    recordUrl(url, taskId = null) {
      if (!url || url === 'about:blank') return;
      try {
        const urlObj = new URL(url);
        const entry = {
          url: url.substring(0, 200),
          domain: urlObj.hostname,
          taskId,
          time: new Date().toISOString()
        };
        this.urlHistory.push(entry);
        if (this.urlHistory.length > 50) {
          this.urlHistory = this.urlHistory.slice(-50);
        }
      } catch (e) {
        // Invalid URL, ignore
      }
    },

    recordTask(taskId, taskType) {
      this.taskHistory.push({
        taskId,
        taskType,
        time: new Date().toISOString()
      });
      if (this.taskHistory.length > 20) {
        this.taskHistory = this.taskHistory.slice(-20);
      }
    },

    release(log = console.log) {
      this.inUse = false;
      this.lastUsed = Date.now();

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
        recentUrls: this.urlHistory.slice(-10).reverse(),
        taskCount: this.taskHistory.length,
        recentTasks: this.taskHistory.slice(-5).reverse()
      };
    }
  };
}

module.exports = { createBrowserPool };
