const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const URL = 'https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance';
const LOCAL_PROXY_PORT = 8888;
const MAC_PROXY_PORT = 9999;

// Domains that must go through Mac proxy (devbox can't access)
const MAC_PROXY_DOMAINS = [
  'cdn-tos.bytedance.net',
  'cdn-tos-cn.bytedance.net',
  'cdn-tos-sg.byteintl.net',
  'cdn-tos-va.byteintl.net',
  'lf3-short.ibytedapm.com',
  'office-cdn.bytedance.net',
  'larksuitecdn.com',
  'feishu.cn',
  'sso.bytedance.com'  // SSO not accessible from devbox!
];

// Track failed domains
const failedDomains = new Set();

// Create selective proxy
function createSelectiveProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(400);
      res.end('Use CONNECT for HTTPS');
    });

    server.on('connect', (req, clientSocket, head) => {
      const [hostname, port] = req.url.split(':');
      const targetPort = parseInt(port) || 443;

      const useMacProxy = MAC_PROXY_DOMAINS.some(d => hostname.includes(d));
      if (useMacProxy) {
        console.log(`[MAC] ${hostname}:${targetPort}`);
        connectViaMac(hostname, targetPort, clientSocket, head);
        return;
      }

      const serverSocket = net.connect(targetPort, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        serverSocket.write(head);
        serverSocket.pipe(clientSocket).on('error', () => {});
        clientSocket.pipe(serverSocket).on('error', () => {});
      });

      serverSocket.on('error', (e) => {
        console.log(`[FAIL] ${hostname} - ${e.code}`);
        failedDomains.add(hostname);
        try { clientSocket.end(); } catch(e) {}
      });
      clientSocket.on('error', () => {
        try { serverSocket.destroy(); } catch(e) {}
      });
    });

    function connectViaMac(hostname, targetPort, clientSocket, head) {
      const macSocket = net.connect(MAC_PROXY_PORT, '127.0.0.1', () => {
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
            failedDomains.add(hostname);
            try { clientSocket.end(); macSocket.end(); } catch(e) {}
          }
        }
      });

      macSocket.on('error', (e) => {
        console.log(`[MAC ERR] ${hostname} - ${e.message}`);
        failedDomains.add(hostname);
        try { clientSocket.end(); } catch(e) {}
      });

      clientSocket.on('error', () => {
        try { macSocket.destroy(); } catch(e) {}
      });
    }

    server.listen(LOCAL_PROXY_PORT, '127.0.0.1', () => {
      console.log(`Selective proxy on ${LOCAL_PROXY_PORT}`);
      resolve(server);
    });
  });
}

function loadCookies() {
  const cookiePath = path.join(__dirname, 'cookies.json');
  if (fs.existsSync(cookiePath)) {
    return JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  }
  return [];
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
    sameSite: c.sameSite === 'no_restriction' ? 'None' : 'Lax'
  }));
}

async function main() {
  const proxyServer = await createSelectiveProxy();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1600,1000',
      '--proxy-server=http://127.0.0.1:8888'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Capture console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Load cookies - navigate to each domain first to establish context
  const rawCookies = loadCookies();
  const cookies = convertToPuppeteerCookies(rawCookies);

  // Get unique domains
  const domains = [...new Set(rawCookies.map(c => c.domain.replace(/^\./, '')))];
  console.log('Cookie domains:', domains.join(', '));

  // Pre-navigate to establish cookie context for key domains
  const keyDomains = ['bytedance.net', 'bytedance.com', 'sso.bytedance.com', 'cloud-boe.bytedance.net'];
  for (const domain of keyDomains) {
    try {
      await page.goto(`https://${domain}/`, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    } catch (e) {}
  }

  // Now set all cookies
  for (const cookie of cookies) {
    try {
      const domain = cookie.domain.replace(/^\./, '');
      const url = `https://${domain}/`;
      await page.setCookie({ ...cookie, url });
    } catch (e) {}
  }

  // Also set cookies for the target domain specifically
  for (const cookie of cookies) {
    try {
      if (cookie.domain.includes('bytedance')) {
        await page.setCookie({ ...cookie, url: URL });
      }
    } catch (e) {}
  }

  console.log(`\nNavigating to: ${URL}\n`);

  try {
    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('Page loaded, waiting for content...');

    // Wait for content to appear - try multiple selectors
    const contentSelectors = [
      '.ant-table',
      '[class*="list"]',
      '[class*="table"]',
      '[class*="content"]',
      'main',
      '#root > div > div'
    ];

    let foundContent = false;
    for (const selector of contentSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        console.log(`Found content with selector: ${selector}`);
        foundContent = true;
        break;
      } catch (e) {}
    }

    if (!foundContent) {
      console.log('No content selector found, waiting 15 seconds...');
      await new Promise(r => setTimeout(r, 15000));
    } else {
      await new Promise(r => setTimeout(r, 3000));
    }

    // Take screenshot
    await page.screenshot({ path: 'test_screenshot.png', fullPage: false });
    console.log('Screenshot saved');

    // Get page info
    const title = await page.title();
    const url = page.url();
    console.log(`\nTitle: ${title}`);
    console.log(`URL: ${url}`);

    // Get page content
    const bodyText = await page.evaluate(() => {
      return document.body ? document.body.innerText.substring(0, 1000) : '';
    });
    console.log(`\nContent preview:\n${bodyText.substring(0, 500)}`);

    // Show console errors
    if (consoleErrors.length > 0) {
      console.log(`\nConsole errors (${consoleErrors.length}):`);
      consoleErrors.slice(0, 5).forEach(e => console.log(`  - ${e.substring(0, 100)}`));
    }

  } catch (e) {
    console.error('Error:', e.message);
  }

  await browser.close();
  proxyServer.close();

  // Show failed domains
  if (failedDomains.size > 0) {
    console.log(`\nFailed domains (add to MAC_PROXY_DOMAINS?):`);
    failedDomains.forEach(d => console.log(`  - ${d}`));
  }

  console.log('\nDone.');
}

main().catch(console.error);
