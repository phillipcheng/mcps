/**
 * Engine module - core browser automation components
 */

const { createBrowserPool } = require('./browser-pool');
const { createSelectiveProxy, getProxyConfig, updateProxyConfig, LOCAL_PROXY_PORT } = require('./proxy');
const { loadCookies, saveCookies, convertToPuppeteerCookies, COOKIE_FILE } = require('./cookies');
const {
  pollForCondition,
  handleTaskError,
  getBrowserPid,
  forceKillBrowser,
  cleanupOrphanedBrowsers
} = require('./utils');

module.exports = {
  // Browser pool
  createBrowserPool,

  // Proxy
  createSelectiveProxy,
  getProxyConfig,
  updateProxyConfig,
  LOCAL_PROXY_PORT,

  // Cookies
  loadCookies,
  saveCookies,
  convertToPuppeteerCookies,
  COOKIE_FILE,

  // Utils
  pollForCondition,
  handleTaskError,
  getBrowserPid,
  forceKillBrowser,
  cleanupOrphanedBrowsers
};
