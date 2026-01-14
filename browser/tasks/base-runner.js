/**
 * Base task runner utilities
 * Provides common functions for all task runners
 */

const puppeteer = require('puppeteer');

/**
 * Create common task utilities
 * @param {Object} ctx - Context with dependencies
 * @param {string} taskId - Task ID
 * @param {Object} task - Task object
 * @returns {Object} Utility functions
 */
function createTaskUtils(ctx, taskId, task) {
  const { screenshots, saveScreenshotToDb, saveTaskToDb } = ctx;

  /**
   * Log message with timestamp
   */
  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(`[${taskId}] ${msg}`);
    task.logs.push(line);
  }

  /**
   * Add screenshot to task
   */
  async function addScreenshot(page, label) {
    try {
      const data = await page.screenshot({ encoding: 'base64' });
      const taskSS = screenshots.get(taskId) || [];
      const index = taskSS.length;
      taskSS.push({ label, data, time: new Date().toISOString() });
      screenshots.set(taskId, taskSS);
      await saveScreenshotToDb(taskId, index, label, data);
      log(`Screenshot: ${label}`);
    } catch (e) {
      log(`Screenshot failed: ${e.message}`);
    }
  }

  /**
   * Set task stage and save to DB
   */
  async function setStage(stage) {
    task.stage = stage;
    log(`Stage: ${stage}`);
    await saveTaskToDb(taskId, task);
  }

  /**
   * Click element by text content
   */
  async function clickByText(page, selector, textPattern, description, timeout = 10000) {
    log(`Looking for: ${description} containing "${textPattern}"`);
    await page.waitForSelector(selector, { timeout });
    const clicked = await page.evaluate((sel, pattern) => {
      const elements = Array.from(document.querySelectorAll(sel));
      const target = elements.find(el => el.textContent.includes(pattern));
      if (target) { target.click(); return true; }
      return false;
    }, selector, textPattern);
    if (!clicked) throw new Error(`Could not find ${description} with text "${textPattern}"`);
    log(`Clicked: ${description}`);
    await new Promise(r => setTimeout(r, 300));
  }

  return { log, addScreenshot, setStage, clickByText };
}

/**
 * Setup browser with cookies and viewport
 * @param {Object} ctx - Context with dependencies
 * @param {Object} browser - Puppeteer browser instance
 * @param {string} taskId - Task ID
 * @param {Function} log - Logging function
 * @returns {Object} Page instance
 */
async function setupBrowserPage(ctx, browser, taskId, log) {
  const { loadCookies, convertToPuppeteerCookies, browserPool } = ctx;

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Load cookies
  const rawCookies = loadCookies();
  const cookies = convertToPuppeteerCookies(rawCookies);

  log('Setting up cookies for all domains...');
  if (cookies.length > 0) {
    const domains = [...new Set(rawCookies.map(c => c.domain.replace(/^\./, '')))];
    log(`Cookie domains: ${domains.join(', ')}`);

    for (const cookie of cookies) {
      try {
        const domain = cookie.domain.replace(/^\./, '');
        const url = `https://${domain}/`;
        await page.setCookie({ ...cookie, url });

        // Also set SSO cookies for bytedance.com
        if (domain === 'bytedance.net' && (cookie.name.includes('sso') || cookie.name.includes('bd_sso'))) {
          await page.setCookie({
            ...cookie,
            domain: '.bytedance.com',
            url: 'https://sso.bytedance.com/'
          });
          log(`Also set ${cookie.name} for bytedance.com`);
        }
      } catch (e) {
        // Ignore cookie errors
      }
    }
    log(`Loaded ${cookies.length} cookies`);
  }

  return page;
}

/**
 * Get browser arguments for task
 * @param {Object} ctx - Context with proxyConfig and LOCAL_PROXY_PORT
 * @param {Function} log - Logging function
 * @returns {Array} Browser arguments
 */
function getBrowserArgs(ctx, log) {
  const { proxyConfig, LOCAL_PROXY_PORT } = ctx;

  const browserArgs = [
    '--window-size=1600,1000',
    '--force-device-scale-factor=1',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu-compositing',
    '--enable-features=NetworkService,NetworkServiceInProcess'
  ];

  if (proxyConfig.proxyEnabled) {
    browserArgs.push(`--proxy-server=http://127.0.0.1:${LOCAL_PROXY_PORT}`);
    log(`Using proxy: http://127.0.0.1:${LOCAL_PROXY_PORT}`);
  } else {
    log('Proxy disabled - direct connections');
  }

  return browserArgs;
}

/**
 * Cleanup browser after task
 * @param {Object} ctx - Context with browserPool and runningBrowsers
 * @param {string} taskId - Task ID
 * @param {Object} browser - Browser instance
 * @param {Function} log - Logging function
 * @param {boolean} releaseToPool - Whether to release browser back to pool
 */
async function cleanupBrowser(ctx, taskId, browser, log, releaseToPool = true) {
  const { browserPool, runningBrowsers } = ctx;

  if (browser) {
    try {
      const pages = await browser.pages();
      for (const p of pages) {
        if (p.url() !== 'about:blank') {
          await p.close().catch(() => {});
        }
      }
      log('Pages closed');
    } catch (e) { /* ignore */ }

    if (releaseToPool) {
      browserPool.release(log);
    }
    runningBrowsers.delete(taskId);
  }
}

module.exports = {
  createTaskUtils,
  setupBrowserPage,
  getBrowserArgs,
  cleanupBrowser
};
