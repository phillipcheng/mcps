#!/usr/bin/env node
/**
 * Janus Mini Crawler - Using SSH Tunnel Proxy
 *
 * Prerequisites:
 * 1. Mac: node mac_cdn_proxy.js
 * 2. Mac: ssh -R 9999:localhost:9999 yi.cheng1@devbox
 * 3. Run this script
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PSM = process.argv[2] || 'oec.reverse.strategy';
const ENV = process.argv[3] || 'boe_feat_system_deleete';
const DRY_RUN = process.argv[4] !== 'false';

console.log(`\n=== Janus Mini Update (via Proxy) ===`);
console.log(`PSM: ${PSM}`);
console.log(`ENV: ${ENV}`);
console.log(`DRY_RUN: ${DRY_RUN}`);
console.log(`Proxy: http://localhost:9999`);
console.log(`=====================================\n`);

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

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function run() {
  log('Launching browser with proxy...');

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--proxy-server=http://localhost:9999'  // Use the SSH tunnel proxy
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Load cookies
  const cookies = loadCookies();
  await page.setCookie(...cookies);
  log(`Loaded ${cookies.length} cookies`);

  // Helper functions
  const takeScreenshot = async (label) => {
    const filename = `proxy_${label}.png`;
    await page.screenshot({ path: filename });
    log(`Screenshot: ${filename}`);
  };

  const clickByText = async (selector, textPattern, description, timeout = 10000) => {
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
    await new Promise(r => setTimeout(r, 1500));
  };

  try {
    // Step 1: Open Janus Mini list
    const listUrl = "https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance";
    log(`Step 1: Opening ${listUrl}`);
    await page.goto(listUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    await takeScreenshot('1_list');

    // Check if page loaded properly
    const pageContent = await page.evaluate(() => document.body.innerText);
    log(`Page content length: ${pageContent.length}`);

    if (pageContent.length < 100) {
      log('Warning: Page seems empty, waiting more...');
      await new Promise(r => setTimeout(r, 5000));
      await takeScreenshot('1b_wait');
    }

    // Step 2: Search for PSM
    log(`Step 2: Searching for PSM: ${PSM}`);
    const searchSelectors = ['input[placeholder*="PSM"]', 'input[placeholder*="搜索"]', 'input[type="text"]'];
    for (const sel of searchSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await page.click(sel);
        await page.type(sel, PSM);
        await page.keyboard.press('Enter');
        log('Entered PSM in search');
        break;
      } catch (e) { /* try next */ }
    }
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('2_search');

    // Click PSM row
    const psmClicked = await page.evaluate((psmName) => {
      const rows = Array.from(document.querySelectorAll('tr, .table-row, [class*="row"]'));
      for (const row of rows) {
        if (row.textContent.includes(psmName)) {
          const link = row.querySelector('a') || row;
          link.click();
          return true;
        }
      }
      const links = Array.from(document.querySelectorAll('a'));
      const target = links.find(a => a.textContent.includes(psmName));
      if (target) { target.click(); return true; }
      return false;
    }, PSM);

    if (!psmClicked) throw new Error(`PSM not found: ${PSM}`);
    log(`Selected PSM: ${PSM}`);
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('3_psm');

    // Step 3: Navigate to IDL Management
    log(`Step 3: Going to IDL Management for env: ${ENV}`);
    const currentUrl = page.url();
    const miniIdMatch = currentUrl.match(/\/mini\/(\d+)/);
    const miniId = miniIdMatch ? miniIdMatch[1] : null;

    if (miniId) {
      const idlUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${miniId}/tab/IdlConfig?lane=${ENV}&x-resource-account=boe&x-bc-region-id=bytedance`;
      log(`Navigating to: ${idlUrl}`);
      await page.goto(idlUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    }
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('4_idl');

    // Step 4: Click Edit
    log('Step 4: Clicking Edit');
    await clickByText('button, .btn, [class*="button"]', '编辑', 'Edit button');
    await takeScreenshot('5_edit');

    // Step 5: Select latest version
    log('Step 5: Selecting latest version');
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('[class*="option"], li[class*="item"], .dropdown-item'));
      if (options.length > 0) options[0].click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Click confirm
    log('Step 5b: Clicking Confirm');
    await clickByText('button, .btn', '确定', 'Confirm button');
    await takeScreenshot('6_confirm');

    // Step 6: Wait for success
    log('Step 6: Waiting for setup...');
    for (let i = 0; i < 30; i++) {
      const status = await page.evaluate(() => {
        const body = document.body.innerText;
        if (body.includes('成功') || body.includes('Success')) return 'success';
        return 'waiting';
      });
      if (status === 'success') {
        log('Setup successful!');
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    await takeScreenshot('7_setup');

    // Step 7: Refresh
    log('Step 7: Refreshing page');
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('8_refresh');

    if (DRY_RUN) {
      log('=== DRY RUN COMPLETE ===');
      log('Stopped before deployment. Remove dry_run flag to continue.');
      await browser.close();
      return;
    }

    // Step 8-11: Deployment
    log('Step 8: Clicking Deployment');
    await clickByText('button, [role="tab"], .tab, a', '部署', 'Deployment tab');
    await new Promise(r => setTimeout(r, 2000));
    await takeScreenshot('9_deploy');

    log('Step 9: Clicking Release');
    await clickByText('button, .btn', '发布', 'Release button');
    await new Promise(r => setTimeout(r, 2000));
    await takeScreenshot('10_release');

    log('Step 10: Starting release');
    await clickByText('button, .btn', '开始发布', 'Start Release');
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot('11_start');

    log('Step 11: Waiting for release...');
    for (let i = 0; i < 60; i++) {
      const status = await page.evaluate(() => {
        const body = document.body.innerText;
        if (body.includes('发布成功') || body.includes('完成')) return 'success';
        if (body.includes('失败')) return 'failed';
        return 'waiting';
      });

      if (status === 'success') {
        log('Release successful!');
        break;
      }
      if (status === 'failed') throw new Error('Release failed');

      // Click next buttons
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button')).filter(b =>
          b.textContent.includes('下一步') || b.textContent.includes('继续')
        );
        if (btns.length > 0 && !btns[0].disabled) btns[0].click();
      });

      await new Promise(r => setTimeout(r, 2000));
      if (i % 10 === 0) await takeScreenshot(`11_progress_${i}`);
    }
    await takeScreenshot('12_done');
    log('=== RELEASE COMPLETE ===');

  } catch (error) {
    log(`ERROR: ${error.message}`);
    await takeScreenshot('error');
    throw error;
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
