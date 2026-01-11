#!/usr/bin/env node
/**
 * Janus Crawler with Selective Proxy
 * - Routes cloud-boe.bytedance.net directly (works from devbox)
 * - Routes cdn-tos.bytedance.net through Mac proxy
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

const PSM = process.argv[2] || 'oec.reverse.strategy';
const ENV = process.argv[3] || 'boe_feat_system_deleete';
const DRY_RUN = process.argv[4] !== 'false';
const PROXY_PORT = 9999;

console.log(`\n=== Janus Mini Update (Selective Proxy) ===`);
console.log(`PSM: ${PSM}`);
console.log(`ENV: ${ENV}`);
console.log(`DRY_RUN: ${DRY_RUN}`);
console.log(`CDN Proxy: localhost:${PROXY_PORT}`);
console.log(`===========================================\n`);

// Load cookies
function loadCookies() {
  const cookiePath = path.join(__dirname, 'cookies.json');
  const rawCookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  return rawCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: c.sameSite === 'no_restriction' ? 'None' : 'Lax'
  }));
}

// Create local proxy that routes CDN traffic through Mac proxy
function createLocalProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Forward HTTP requests
      const url = new URL(req.url);
      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers
      };
      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      req.pipe(proxyReq);
    });

    server.on('connect', (req, clientSocket, head) => {
      const [hostname, port] = req.url.split(':');
      const targetPort = parseInt(port) || 443;

      // Check if this should go through Mac proxy
      // Route problematic domains through Mac
      const needsProxy =
        hostname.includes('cdn-tos') ||
        hostname.includes('sso.bytedance.com') ||
        hostname.includes('office-cdn') ||
        hostname.includes('check-3pcookie') ||
        hostname.includes('byteoversea');

      if (needsProxy) {
        console.log(`[PROXY→MAC] ${hostname}:${targetPort}`);
        // Connect through Mac proxy
        const proxySocket = net.connect(PROXY_PORT, '127.0.0.1', () => {
          proxySocket.write(`CONNECT ${hostname}:${targetPort} HTTP/1.1\r\nHost: ${hostname}\r\n\r\n`);
        });

        proxySocket.once('data', (data) => {
          const response = data.toString();
          if (response.includes('200')) {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            proxySocket.write(head);
            proxySocket.pipe(clientSocket);
            clientSocket.pipe(proxySocket);
          } else {
            console.log(`[PROXY] Mac proxy error: ${response}`);
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          }
        });

        proxySocket.on('error', (e) => {
          console.log(`[PROXY] Mac proxy connection error: ${e.message}`);
          clientSocket.end();
        });

        clientSocket.on('error', () => proxySocket.end());
        clientSocket.on('close', () => proxySocket.end());
        proxySocket.on('close', () => clientSocket.end());
      } else {
        // Direct connection
        console.log(`[DIRECT] ${hostname}:${targetPort}`);
        const serverSocket = net.connect(targetPort, hostname, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          serverSocket.write(head);
          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
        });

        serverSocket.on('error', (e) => {
          console.log(`[DIRECT] Connection error: ${e.message}`);
          clientSocket.end();
        });

        clientSocket.on('error', () => serverSocket.end());
      }
    });

    server.on('error', (e) => console.log(`[SERVER] ${e.message}`));

    server.listen(8888, '127.0.0.1', () => {
      console.log(`[LOCAL PROXY] Running on port 8888 (routes cdn-tos through Mac proxy)`);
      resolve(server);
    });
  });
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function run() {
  // Start local proxy
  const localProxy = await createLocalProxy();

  log('Launching browser...');

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--proxy-server=http://127.0.0.1:8888'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
  );

  // Load cookies
  const cookies = loadCookies();
  await page.setCookie(...cookies);
  log(`Loaded ${cookies.length} cookies`);

  const takeScreenshot = async (label) => {
    const filename = `sel_${label}.png`;
    await page.screenshot({ path: filename });
    log(`Screenshot: ${filename}`);
  };

  const clickByText = async (selector, textPattern, description, timeout = 15000) => {
    log(`Looking for: ${description}`);
    await page.waitForSelector(selector, { timeout });
    const clicked = await page.evaluate((sel, pattern) => {
      const elements = Array.from(document.querySelectorAll(sel));
      const target = elements.find(el => el.textContent.includes(pattern));
      if (target) { target.click(); return true; }
      return false;
    }, selector, textPattern);
    if (!clicked) throw new Error(`Could not find ${description}`);
    log(`Clicked: ${description}`);
    await new Promise(r => setTimeout(r, 2000));
  };

  try {
    // Step 1
    const listUrl = "https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance";
    log(`Step 1: Opening ${listUrl}`);
    await page.goto(listUrl, { waitUntil: 'networkidle0', timeout: 90000 });
    await takeScreenshot('1_list');

    const content = await page.evaluate(() => document.body.innerText);
    log(`Page content: ${content.length} chars`);
    log(`Preview: ${content.substring(0, 200)}`);

    if (content.includes('SSO') || content.includes('登录') || content.length < 500) {
      throw new Error('Not logged in or page did not load properly');
    }

    // Step 2: Search PSM
    log(`Step 2: Searching for ${PSM}`);
    await new Promise(r => setTimeout(r, 2000));

    for (const sel of ['input[placeholder*="PSM"]', 'input[placeholder*="搜索"]', 'input']) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.type(sel, PSM);
        await page.keyboard.press('Enter');
        break;
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('2_search');

    // Click PSM
    const clicked = await page.evaluate((psm) => {
      for (const el of document.querySelectorAll('a, tr, [class*="row"]')) {
        if (el.textContent.includes(psm)) {
          (el.querySelector('a') || el).click();
          return true;
        }
      }
      return false;
    }, PSM);

    if (!clicked) throw new Error(`PSM not found: ${PSM}`);
    log(`Selected PSM`);
    await new Promise(r => setTimeout(r, 4000));
    await takeScreenshot('3_psm');

    // Step 3: IDL Management
    log(`Step 3: IDL Management`);
    const miniId = page.url().match(/\/mini\/(\d+)/)?.[1];
    if (miniId) {
      await page.goto(
        `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${miniId}/tab/IdlConfig?lane=${ENV}&x-resource-account=boe&x-bc-region-id=bytedance`,
        { waitUntil: 'networkidle0', timeout: 60000 }
      );
    }
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('4_idl');

    // Step 4: Edit
    log(`Step 4: Edit`);
    await clickByText('button', '编辑', 'Edit');
    await takeScreenshot('5_edit');

    // Step 5: Version
    log(`Step 5: Select version`);
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => {
      const opts = document.querySelectorAll('[class*="option"], li');
      if (opts.length) opts[0].click();
    });
    await clickByText('button', '确定', 'Confirm');
    await takeScreenshot('6_confirm');

    // Step 6: Wait
    log(`Step 6: Waiting...`);
    for (let i = 0; i < 30; i++) {
      const s = await page.evaluate(() =>
        document.body.innerText.includes('成功') ? 'success' : 'wait'
      );
      if (s === 'success') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    await takeScreenshot('7_done');

    // Step 7: Refresh
    log(`Step 7: Refresh`);
    await page.reload({ waitUntil: 'networkidle0' });
    await takeScreenshot('8_refresh');

    if (DRY_RUN) {
      log(`=== DRY RUN COMPLETE ===`);
    } else {
      // Steps 8-11: Deploy
      log(`Step 8: Deploy`);
      await clickByText('button, [role="tab"]', '部署', 'Deploy');
      await takeScreenshot('9_deploy');

      log(`Step 9: Release`);
      await clickByText('button', '发布', 'Release');
      await takeScreenshot('10_release');

      log(`Step 10: Start`);
      await clickByText('button', '开始发布', 'Start');
      await takeScreenshot('11_start');

      log(`Step 11: Wait for complete...`);
      for (let i = 0; i < 60; i++) {
        const s = await page.evaluate(() => {
          const t = document.body.innerText;
          if (t.includes('发布成功')) return 'success';
          if (t.includes('失败')) return 'fail';
          return 'wait';
        });
        if (s === 'success') { log('SUCCESS!'); break; }
        if (s === 'fail') throw new Error('Release failed');

        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find(x =>
            x.textContent.includes('下一步') && !x.disabled
          );
          if (b) b.click();
        });
        await new Promise(r => setTimeout(r, 2000));
      }
      await takeScreenshot('12_final');
    }

  } catch (e) {
    log(`ERROR: ${e.message}`);
    await takeScreenshot('error');
    throw e;
  } finally {
    await browser.close();
    localProxy.close();
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
