const puppeteer = require('puppeteer');

async function fetchApiDocs() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  
  const page = await browser.newPage();
  
  // Set cookies
  const cookies = [
    { name: 'bd_sso_3b6da9', value: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3Njg1ODcxNzcsImlhdCI6MTc2Nzk4MjM3NywiaXNzIjoic3NvLmJ5dGVkYW5jZS5jb20iLCJzdWIiOiJrZDFqbWw4cHYwNXRxZmM3Z2xidiIsInRlbmFudF9pZCI6ImhncTN0Y2NwM2kxc2pqbjU4emlrIn0.WCZszeQl4qdnx6p0dhLWNEKABY3zQ4GE5BoDyts8dAPQplJP1k71mdGnxdj4S0R2pEP97j2Pd7S-Wqzez_t4TjreI1-8Cgsx2jgkifBghkIMpNvLFJpMp2AY7a1y0pSdNA6K15RLhJ1D3a-H7WpXOCQQA42x4lPFJqJ_IAxzw5HVVSXlyuKsfAfx7N6jBuI_LmCXs6Qvw8E-HOoyL_vZW0HqqlcWC_vz0Z7d4uAkuvtbPAqAaRiSV0xOU2FydM9gwDrryqIq7QZVletUHWN97bu_MrttxXurIX_gLjo2awXVErzUJHEgAvU8NDTR0wwqJgTBMJrIBVPpcmDUmgvqUw', domain: '.bytedance.net' },
    { name: 'sso_session', value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3NzAzMjgzODQsInVzZXIiOnsiaWQiOiI5NzYxNjUzIiwiYXZhdGFyX3VybCI6Imh0dHBzOi8vcGFuMTYubGFya3N1aXRlY2RuLmNvbS9zdGF0aWMtcmVzb3VyY2UvdjEvdjNfMDA3MV8zOGI4MTQ1OS1hYTQ1LTQ5YjQtYjlkNy1jMDI5NGI1NmYyYmh-P2ltYWdlX3NpemU9MjQweDI0MFx1MDAyNmN1dF90eXBlPVx1MDAyNnF1YWxpdHk9XHUwMDI2Zm9ybWF0PXBuZ1x1MDAyNnN0aWNrZXJfZm9ybWF0PS53ZWJwIiwibmFtZSI6IlBoaWxsaXAgQ2hlbmciLCJlbWFpbCI6InlpLmNoZW5nMUBieXRlZGFuY2UuY29tIiwiZnVsbF9uYW1lIjoiUGhpbGxpcCBDaGVuZyIsImFsaWFzX25hbWUiOiJ5aS5jaGVuZzEiLCJ1c2VyX3R5cGUiOjEsImlzX2JvZSI6dHJ1ZSwibWFpbCI6InlpLmNoZW5nMUBieXRlZGFuY2UuY29tIn19.-BWhHra8sZB5S7xZWrN_ueDTvUPFnD8miJ2VSF9Ugrg', domain: '.bytedance.net' },
    { name: 'passport_csrf_token', value: '6d2572bb4d4353626a7e343f6ebbce53', domain: '.bytedance.net' }
  ];
  
  await page.setCookie(...cookies);
  
  const url = 'https://cloud.bytedance.net/open/explorer/api-docs/view?serviceCode=janus&version=v1&uniqueId=1629b49a0d3296740c192fa2ee1df25aabaf1092&x-resource-account=public&x-bc-region-id=bytedance';
  
  console.error('Navigating...');
  
  // Just start navigation, don't wait for full load
  page.goto(url, { timeout: 0 }).catch(() => {});
  
  // Wait 20 seconds for page to render
  await new Promise(r => setTimeout(r, 20000));
  
  console.error('URL:', page.url());
  
  // Get page content
  const content = await page.evaluate(() => {
    return document.body.innerText;
  });
  
  console.log(content);
  
  await browser.close();
}

fetchApiDocs().catch(e => console.error('Error:', e.message));
