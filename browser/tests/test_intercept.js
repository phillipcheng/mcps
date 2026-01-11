#!/usr/bin/env node
// Test if we can intercept CDN requests and make them work

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');

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

async function run() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  // Load cookies
  const cookies = loadCookies();
  await page.setCookie(...cookies);
  console.log(`Loaded ${cookies.length} cookies`);

  // Enable request interception
  await page.setRequestInterception(true);

  // Cache for fetched resources
  const resourceCache = new Map();

  page.on('request', async (request) => {
    const url = request.url();

    // Block cdn-tos requests that timeout
    if (url.includes('cdn-tos.bytedance.net')) {
      console.log(`[BLOCK] ${url.substring(0, 80)}...`);
      // Try to continue without this resource
      request.abort('blockedbyclient');
      return;
    }

    request.continue();
  });

  page.on('response', response => {
    const url = response.url();
    if (url.includes('bytedance')) {
      console.log(`[RES ${response.status()}] ${url.substring(0, 80)}`);
    }
  });

  page.on('requestfailed', request => {
    const url = request.url();
    if (!url.includes('cdn-tos')) { // Don't log blocked ones
      console.log(`[FAIL] ${url.substring(0, 80)} - ${request.failure()?.errorText}`);
    }
  });

  try {
    console.log('\nNavigating to Janus...');
    const listUrl = "https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance";

    await page.goto(listUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('\nWaiting 5 seconds...');
    await new Promise(r => setTimeout(r, 5000));

    // Take screenshot
    await page.screenshot({ path: 'test_intercept_1.png' });
    console.log('Screenshot saved: test_intercept_1.png');

    // Check page content
    const content = await page.evaluate(() => document.body.innerText);
    console.log('\nPage content preview:');
    console.log(content.substring(0, 500));

    // Check if any scripts loaded
    const scripts = await page.evaluate(() => {
      return Array.from(document.scripts).map(s => s.src).filter(s => s);
    });
    console.log('\nLoaded scripts:', scripts.length);

    // Check for any React app
    const hasReact = await page.evaluate(() => {
      return !!document.querySelector('#root') || !!document.querySelector('[data-reactroot]');
    });
    console.log('Has React root:', hasReact);

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'test_intercept_error.png' });
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
