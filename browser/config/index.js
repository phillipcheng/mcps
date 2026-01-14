/**
 * Configuration constants for the browser automation server
 */

module.exports = {
  PORT: process.env.PORT || 3456,
  MAC_PROXY_PORT: 9999,
  LOCAL_PROXY_PORT: 8888,

  // MySQL configuration
  dbConfig: {
    host: 'fdbd:dccd:cde2:2002:4a5:6fe8:dbcb:cde0',
    port: 3306,
    user: 'oec5625254693_w',
    password: 'wzbMhIgui9Kc6JI_Td2FDbTQTmM8EiGe',
    database: 'oec_aftersale_bot',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  },

  // Common browser args for stability on Linux/devbox
  COMMON_BROWSER_ARGS: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-features=IsolateOrigins,site-per-process,ServiceWorker',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--disable-default-apps',
    '--no-first-run',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--js-flags=--max-old-space-size=1024'
  ],

  // Default proxy configuration
  defaultProxyConfig: {
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
      'bits.bytedance.net',
      'oncall2-online.gf.bytedance.net'
    ],
    macProxyPort: 9999,
    proxyEnabled: true
  }
};
