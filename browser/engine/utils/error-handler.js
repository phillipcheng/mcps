/**
 * Task error handling utilities
 */

/**
 * Common error handler for crawl tasks
 * Takes final screenshot, updates task status, cleans up browser
 * @param {Object} options - Error handling options
 * @param {string} options.taskId - Task ID
 * @param {Object} options.task - Task object
 * @param {Error} options.error - The error that occurred
 * @param {Object} options.browser - Puppeteer browser instance
 * @param {Function} options.log - Logging function
 * @param {Function} options.addScreenshot - Screenshot function
 * @param {Map} options.runningBrowsers - Map of running browser instances
 * @param {Function} options.saveTaskToDb - Database save function
 * @param {Function} options.forceKillBrowser - Browser kill function
 */
async function handleTaskError({
  taskId,
  task,
  error,
  browser,
  log,
  addScreenshot,
  runningBrowsers,
  saveTaskToDb,
  forceKillBrowser
}) {
  log(`ERROR: ${error.message}`);

  // Take final screenshot for debugging
  if (browser) {
    try {
      const pages = await browser.pages();
      if (pages.length > 0) {
        const currentPage = pages[pages.length - 1];
        const currentUrl = currentPage.url();
        log(`Final URL: ${currentUrl}`);

        // Get page content preview for debugging
        try {
          const preview = await currentPage.evaluate(() => {
            return document.body.innerText.substring(0, 500).replace(/\s+/g, ' ');
          });
          log(`Page preview: ${preview.substring(0, 200)}...`);
        } catch (e) { /* ignore */ }

        await addScreenshot(currentPage, 'error_final');
      }
    } catch (ssErr) {
      log(`Could not capture error screenshot: ${ssErr.message}`);
    }
  }

  // Update task status
  task.status = 'error';
  task.error = error.message;
  task.endTime = new Date().toISOString();
  await saveTaskToDb(taskId, task);

  // Cleanup browser
  if (browser) {
    const browserInfo = runningBrowsers.get(taskId);
    try {
      await browser.close();
      log('Browser closed');
    } catch (e) {
      if (browserInfo && browserInfo.pid) {
        forceKillBrowser(browserInfo.pid);
      }
    }
    runningBrowsers.delete(taskId);
  }
}

module.exports = { handleTaskError };
