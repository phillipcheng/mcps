/**
 * Quick browse route
 */

const express = require('express');
const puppeteer = require('puppeteer');
const { COMMON_BROWSER_ARGS } = require('../config');
const { loadCookies, convertToPuppeteerCookies } = require('../engine/cookies');
const { createSelectiveProxy, getProxyConfig, LOCAL_PROXY_PORT } = require('../engine/proxy');

const router = express.Router();

/**
 * Helper: Run browser with proper setup
 */
async function withBrowser(action) {
  const proxyConfig = getProxyConfig();

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
    headless: 'new',
    args: browserArgs,
    protocolTimeout: 300000
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

// POST /api/browse - Browse URL
router.post('/', async (req, res) => {
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

      // Navigate with timeout
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await new Promise(r => setTimeout(r, 2000));

      // Try to wait for network idle
      try {
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 5000 });
      } catch (e) {
        // Continue anyway
      }

      await new Promise(r => setTimeout(r, 1000));

      // Get page info
      let title = 'Unknown';
      let content = '';
      let finalUrl = url;

      try { title = await page.title(); } catch (e) { title = 'Could not get title'; }
      try { finalUrl = page.url(); } catch (e) { finalUrl = url; }
      try { content = await page.evaluate(() => document.body.innerText.substring(0, 5000)); } catch (e) { content = 'Could not get page content'; }

      const screenshot = await page.screenshot({ encoding: 'base64' });

      return { title, url: finalUrl, content, screenshot };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
