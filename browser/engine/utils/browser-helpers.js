/**
 * Browser helper utilities
 */

const { exec } = require('child_process');

/**
 * Get browser process PID
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {number|null} Process ID or null
 */
function getBrowserPid(browser) {
  try {
    const proc = browser.process();
    return proc ? proc.pid : null;
  } catch (e) {
    return null;
  }
}

/**
 * Force kill browser by PID
 * @param {number} pid - Process ID to kill
 * @returns {boolean} Success status
 */
function forceKillBrowser(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Clean up orphaned Chrome processes
 * Only kills MAIN browser processes that are not tracked
 * @param {Map} runningBrowsers - Map of tracked browser instances
 * @param {Object} browserPool - Browser pool object
 * @returns {Promise<number>} Number of processes killed
 */
async function cleanupOrphanedBrowsers(runningBrowsers, browserPool) {
  return new Promise((resolve) => {
    exec(`ps aux | grep puppeteer_dev_chrome_profile | grep "remote-debugging-port" | grep -v grep | awk '{print $2}'`, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(0);
        return;
      }

      const pids = stdout.trim().split('\n').filter(p => p);
      const knownPids = new Set();

      // Get PIDs we're tracking
      for (const [taskId, info] of runningBrowsers) {
        if (info.pid) knownPids.add(String(info.pid));
      }

      // Also include browser pool's PID
      if (browserPool && browserPool.pid) {
        knownPids.add(String(browserPool.pid));
      }

      // Kill any MAIN Chrome processes we're not tracking
      let killed = 0;
      for (const pid of pids) {
        if (!knownPids.has(pid)) {
          try {
            process.kill(parseInt(pid), 'SIGKILL');
            console.log(`[CLEANUP] Killed orphaned Chrome main process: ${pid}`);
            killed++;
          } catch (e) {
            // Process might already be dead
          }
        }
      }
      resolve(killed);
    });
  });
}

module.exports = {
  getBrowserPid,
  forceKillBrowser,
  cleanupOrphanedBrowsers
};
