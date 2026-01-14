/**
 * Polling utility for async condition checking
 */

/**
 * Poll for a condition with timeout and logging
 * @param {Function} checkFn - Async function that returns {ready: boolean, ...status}
 * @param {Object} options - {timeout, interval, description, log}
 * @returns {Object} Final check result
 */
async function pollForCondition(checkFn, options = {}) {
  const {
    timeout = 30000,
    interval = 1000,
    description = 'condition',
    log = console.log
  } = options;

  const maxAttempts = Math.ceil(timeout / interval);
  let consecutiveErrors = 0;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await checkFn();
      consecutiveErrors = 0;

      if (result.ready) {
        log(`[${description}] Ready after ${((i + 1) * interval / 1000).toFixed(1)}s: ${JSON.stringify(result).substring(0, 100)}`);
        return result;
      }

      // Log progress every 3 seconds
      if ((i * interval) % 3000 === 0) {
        log(`[${description}] ${(i * interval / 1000)}s: ${JSON.stringify(result).substring(0, 80)}`);
      }
    } catch (e) {
      consecutiveErrors++;
      log(`[${description}] Error at ${(i * interval / 1000)}s: ${e.message.substring(0, 50)}`);

      // Fail fast on fatal errors
      const fatalErrors = ['detached Frame', 'Session closed', 'Target closed', 'Browser disconnected', 'not defined'];
      if (fatalErrors.some(err => e.message.includes(err))) {
        log(`[${description}] Fatal error detected, aborting poll`);
        return { ready: false, fatalError: true, error: e.message };
      }

      // Fail after 5 consecutive errors
      if (consecutiveErrors >= 5) {
        log(`[${description}] Too many consecutive errors (${consecutiveErrors}), aborting poll`);
        return { ready: false, tooManyErrors: true, error: e.message };
      }
    }
    await new Promise(r => setTimeout(r, interval));
  }

  log(`[${description}] Timeout after ${timeout / 1000}s`);
  return { ready: false, timedOut: true };
}

module.exports = { pollForCondition };
