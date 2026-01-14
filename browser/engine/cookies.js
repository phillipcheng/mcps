/**
 * Cookie management utilities
 */

const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, '..', 'cookies.json');

/**
 * Load cookies from file
 * @returns {Array} Array of cookies
 */
function loadCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

/**
 * Save cookies to file
 * @param {Array} cookies - Array of cookies to save
 */
function saveCookies(cookies) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

/**
 * Convert raw cookies to Puppeteer format
 * @param {Array} rawCookies - Raw cookies from browser extension
 * @returns {Array} Puppeteer-compatible cookies
 */
function convertToPuppeteerCookies(rawCookies) {
  return rawCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: c.sameSite === 'no_restriction' ? 'None' :
              (c.sameSite === 'unspecified' ? 'Lax' : c.sameSite)
  }));
}

module.exports = {
  loadCookies,
  saveCookies,
  convertToPuppeteerCookies,
  COOKIE_FILE
};
