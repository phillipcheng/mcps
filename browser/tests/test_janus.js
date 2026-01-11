#!/usr/bin/env node

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Test parameters - using examples from user
const PSM = process.argv[2] || 'oec.reverse.strategy';
const ENV = process.argv[3] || 'boe_feat_system_deleete';
const DRY_RUN = process.argv[4] !== 'false'; // Default to dry_run=true for safety

// Load cookies from file
function loadCookies() {
  const cookiePath = path.join(__dirname, 'cookies.json');
  if (!fs.existsSync(cookiePath)) {
    console.error('cookies.json not found! Please create it with your browser cookies.');
    process.exit(1);
  }
  const rawCookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));

  // Convert to Puppeteer format
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

console.log(`\n=== Janus Mini Update Test ===`);
console.log(`PSM: ${PSM}`);
console.log(`ENV: ${ENV}`);
console.log(`DRY_RUN: ${DRY_RUN}`);
console.log(`==============================\n`);

const logs = [];
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logs.push(line);
};

async function run() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,1000']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Load cookies before navigating
  log('Loading cookies...');
  const cookies = loadCookies();
  await page.setCookie(...cookies);
  log(`Loaded ${cookies.length} cookies`);

  // Monitor network requests for debugging
  page.on('request', request => {
    if (request.url().includes('bytedance') || request.url().includes('sso')) {
      log(`REQ: ${request.method()} ${request.url().substring(0, 100)}`);
    }
  });
  page.on('response', response => {
    if (response.url().includes('bytedance') || response.url().includes('sso')) {
      log(`RES: ${response.status()} ${response.url().substring(0, 100)}`);
    }
  });
  page.on('requestfailed', request => {
    log(`FAIL: ${request.url().substring(0, 100)} - ${request.failure()?.errorText}`);
  });

  // Helper to take screenshot
  const takeScreenshot = async (label) => {
    const filename = `screenshot_${label}.png`;
    await page.screenshot({ path: filename });
    log(`Screenshot saved: ${filename}`);
  };

  // Helper to find and click element by text
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
    await new Promise(r => setTimeout(r, 1000));
  };

  try {
    // Step 1: Open Janus Mini list
    const listUrl = "https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance";
    log(`Step 1: Opening Janus Mini list: ${listUrl}`);

    // Use domcontentloaded to avoid waiting for all network activity (SSO can cause issues)
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    log(`Initial load complete, URL: ${page.url()}`);
    await takeScreenshot("1a_initial_load");

    // Wait a bit for any redirects/JS to execute
    await new Promise(r => setTimeout(r, 5000));
    log(`After wait, URL: ${page.url()}`);
    await takeScreenshot("1b_after_wait");

    // Try waiting for network to settle with a shorter timeout
    try {
      await page.waitForNetworkIdle({ timeout: 10000 });
      log(`Network idle`);
    } catch (e) {
      log(`Network not idle after 10s, continuing anyway`);
    }
    await takeScreenshot("1_list_view");

    // Check if we got a login page
    const pageContent = await page.evaluate(() => document.body.innerText);
    const pageUrl = page.url();
    log(`Current URL: ${pageUrl}`);

    if (pageUrl.includes('login') || pageUrl.includes('sso') || pageContent.includes('登录') || pageContent.includes('Login')) {
      log(`ERROR: Redirected to login page. Authentication required.`);
      log(`Page content preview: ${pageContent.substring(0, 500)}`);
      await takeScreenshot("error_login_required");
      throw new Error('Authentication required - please login first');
    }

    // Step 2: Search and select PSM
    log(`Step 2: Searching for PSM: ${PSM}`);
    const searchSelector = 'input[placeholder*="PSM"], input[placeholder*="psm"], input[placeholder*="搜索"], input.search-input, input[type="text"]';
    try {
      await page.waitForSelector(searchSelector, { timeout: 5000 });
      const inputs = await page.$$(searchSelector);
      if (inputs.length > 0) {
        await inputs[0].type(PSM);
        await page.keyboard.press('Enter');
        log(`Typed PSM in search box`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      log(`Search input not found, trying to find PSM in table directly`);
    }
    await takeScreenshot("2_after_search");

    // Click on the PSM row in the table
    const psmClicked = await page.evaluate((psmName) => {
      const rows = Array.from(document.querySelectorAll('tr, .table-row, [class*="row"]'));
      for (const row of rows) {
        if (row.textContent.includes(psmName)) {
          const link = row.querySelector('a') || row;
          link.click();
          return { clicked: true, text: row.textContent.substring(0, 100) };
        }
      }
      const links = Array.from(document.querySelectorAll('a'));
      const target = links.find(a => a.textContent.includes(psmName) || a.href.includes(psmName));
      if (target) { target.click(); return { clicked: true, text: target.textContent }; }
      return { clicked: false };
    }, PSM);

    if (!psmClicked.clicked) {
      log(`Could not find PSM: ${PSM}`);
      log(`Page content: ${pageContent.substring(0, 1000)}`);
      throw new Error(`Could not find PSM: ${PSM}`);
    }
    log(`Selected PSM: ${PSM} (${psmClicked.text})`);
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot("3_psm_selected");

    // Step 3: Navigate to IDL Management tab with lane parameter
    log(`Step 3: Going to IDL Management tab for env: ${ENV}`);
    const currentUrl = page.url();
    const miniIdMatch = currentUrl.match(/\/mini\/(\d+)/);
    let miniId = miniIdMatch ? miniIdMatch[1] : null;

    if (!miniId) {
      miniId = await page.evaluate(() => {
        const url = window.location.href;
        const match = url.match(/\/mini\/(\d+)/);
        return match ? match[1] : null;
      });
    }

    log(`Mini ID: ${miniId}`);

    if (miniId) {
      const idlUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${miniId}/tab/IdlConfig?lane=${ENV}&x-resource-account=boe&x-bc-region-id=bytedance`;
      log(`Navigating to: ${idlUrl}`);
      await page.goto(idlUrl, { waitUntil: "networkidle0", timeout: 60000 });
    } else {
      await clickByText('button, [role="tab"], .tab', 'IDL', 'IDL Management tab');
    }
    await new Promise(r => setTimeout(r, 2000));
    await takeScreenshot("4_idl_management");

    // Step 4: Click Edit button
    log(`Step 4: Clicking Edit button`);
    await clickByText('button, .btn, [class*="button"]', '编辑', 'Edit button');
    await new Promise(r => setTimeout(r, 2000));
    await takeScreenshot("5_edit_clicked");

    // Step 5: Select latest version
    log(`Step 5: Selecting latest version`);
    const versionSelected = await page.evaluate(() => {
      const dropdowns = Array.from(document.querySelectorAll('select, [class*="select"], [class*="dropdown"]'));
      for (const dd of dropdowns) {
        if (dd.textContent.includes('version') || dd.textContent.includes('版本')) {
          dd.click();
          return 'dropdown_clicked';
        }
      }
      const options = Array.from(document.querySelectorAll('[class*="option"], li[class*="item"]'));
      if (options.length > 0) {
        options[0].click();
        return 'first_option_clicked';
      }
      return null;
    });
    log(`Version selection result: ${versionSelected}`);
    await new Promise(r => setTimeout(r, 1000));

    // Click confirm/OK button
    log(`Step 5b: Clicking Confirm button`);
    await clickByText('button, .btn', '确定', 'Confirm button');
    await takeScreenshot("6_version_selected");

    // Step 6: Wait for setup successful
    log(`Step 6: Waiting for setup to complete...`);
    let setupComplete = false;
    for (let i = 0; i < 30; i++) {
      const status = await page.evaluate(() => {
        const body = document.body.innerText;
        if (body.includes('成功') || body.includes('successful') || body.includes('Success')) {
          return 'success';
        }
        const editBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('编辑'));
        if (editBtn && !editBtn.disabled) {
          return 'edit_enabled';
        }
        return 'waiting';
      });
      if (status === 'success' || status === 'edit_enabled') {
        setupComplete = true;
        log(`Setup complete: ${status}`);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!setupComplete) {
      log('Warning: Setup completion not detected, continuing anyway');
    }
    await takeScreenshot("7_setup_complete");

    // Step 7: Refresh page
    log(`Step 7: Refreshing page`);
    await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    await takeScreenshot("8_page_refreshed");

    if (DRY_RUN) {
      log(`DRY RUN: Stopping before deployment`);
      log(`\n=== DRY RUN COMPLETE ===`);
      return;
    }

    // Step 8: Click Deployment tab
    log(`Step 8: Clicking Deployment tab`);
    await clickByText('button, [role="tab"], .tab, a', '部署', 'Deployment tab');
    await new Promise(r => setTimeout(r, 2000));
    await takeScreenshot("9_deployment_tab");

    // Step 9: Click Release button
    log(`Step 9: Clicking Release button`);
    await clickByText('button, .btn', '发布', 'Release button');
    await new Promise(r => setTimeout(r, 2000));
    await takeScreenshot("10_release_clicked");

    // Step 10: Click "开始发布" (Start Release)
    log(`Step 10: Clicking Start Release button`);
    await clickByText('button, .btn', '开始发布', 'Start Release button');
    await new Promise(r => setTimeout(r, 3000));
    await takeScreenshot("11_start_release");

    // Step 11: Wait for release to complete
    log(`Step 11: Waiting for release to complete...`);
    let releaseComplete = false;
    for (let i = 0; i < 60; i++) {
      const status = await page.evaluate(() => {
        const body = document.body.innerText;
        if (body.includes('发布成功') || body.includes('release successful') || body.includes('完成')) {
          return 'success';
        }
        if (body.includes('失败') || body.includes('failed') || body.includes('error')) {
          return 'failed';
        }
        return 'waiting';
      });

      if (status === 'success') {
        releaseComplete = true;
        log(`Release complete!`);
        break;
      }
      if (status === 'failed') {
        throw new Error('Release failed');
      }

      await page.evaluate(() => {
        const nextBtns = Array.from(document.querySelectorAll('button')).filter(b =>
          b.textContent.includes('下一步') || b.textContent.includes('继续') || b.textContent.includes('Next')
        );
        if (nextBtns.length > 0 && !nextBtns[0].disabled) {
          nextBtns[0].click();
        }
      });

      await new Promise(r => setTimeout(r, 1000));
    }

    await takeScreenshot("12_release_complete");
    log(`\n=== RELEASE ${releaseComplete ? 'COMPLETE' : 'TIMEOUT'} ===`);

  } catch (error) {
    log(`ERROR: ${error.message}`);
    await takeScreenshot("error_state");
    throw error;
  } finally {
    await browser.close();
    console.log(`\n=== Logs ===`);
    logs.forEach(l => console.log(l));
  }
}

run().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
