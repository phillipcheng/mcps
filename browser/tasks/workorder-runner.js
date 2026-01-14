/**
 * Workorder Execution Task Runner
 *
 * Handles executing workorders for release management
 */

const { createTaskUtils, setupBrowserPage, getBrowserArgs, cleanupBrowser } = require('./base-runner');

/**
 * Create a Workorder task runner with injected dependencies
 * @param {Object} ctx - Context with shared dependencies
 * @returns {Function} runWorkorderTask function
 */
function createWorkorderTaskRunner(ctx) {
  const {
    screenshots,
    runningBrowsers,
    proxyConfig,
    LOCAL_PROXY_PORT,
    saveScreenshotToDb,
    saveTaskToDb,
    createSelectiveProxy,
    getBrowserPid,
    forceKillBrowser,
    loadCookies,
    convertToPuppeteerCookies,
    handleTaskError,
    pollForCondition,
    browserPool
  } = ctx;

  /**
   * Run a workorder execution task
   */
  async function runWorkorderTask(taskId, task, retryCount = 0) {
    const MAX_RETRIES = 3;
    const utils = createTaskUtils(ctx, taskId, task);
    const { log, addScreenshot, setStage } = utils;

    let browser = null;

    try {
      await setStage('Initializing');
      log(`Task params: psm=${task.psm}, env=${task.env}, api_group_id=${task.api_group_id}`);

      // Setup proxy if enabled
      if (proxyConfig.proxyEnabled) {
        await createSelectiveProxy();
      }

      const browserArgs = getBrowserArgs(ctx, log);

      // Get browser from pool
      const browserResult = await browserPool.getBrowser(browserArgs, log);
      browser = browserResult.browser;
      const browserPid = browserResult.pid;
      const browserCached = browserResult.cached;

      runningBrowsers.set(taskId, { browser, pid: browserPid, startTime: Date.now() });
      log(`Browser ready (cached=${browserCached}, PID=${browserPid})`);
      browserPool.recordTask(taskId, task.type);

      const page = await setupBrowserPage(ctx, browser, taskId, log);

      // Navigate to release history page (Tickets tab)
      await setStage('Opening Tickets tab');
      const historyUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${task.api_group_id}/tab/release_history?lane=${task.env}&x-resource-account=boe&x-bc-region-id=bytedance`;
      log(`Opening: ${historyUrl}`);

      await page.goto(historyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      browserPool.recordUrl(historyUrl, taskId);

      // Wait for page to load and click Tickets tab
      await new Promise(r => setTimeout(r, 3000));

      // Click on Tickets tab
      const ticketsClicked = await page.evaluate(() => {
        const tabs = document.querySelectorAll('.ant-tabs-tab, [role="tab"]');
        for (const tab of tabs) {
          const text = tab.textContent.trim();
          if (text === 'Tickets' || text.includes('Tickets')) {
            tab.click();
            return { clicked: true, text };
          }
        }
        return { clicked: false, tabCount: tabs.length };
      });
      log(`Tickets tab click: ${JSON.stringify(ticketsClicked)}`);

      await new Promise(r => setTimeout(r, 2000));

      // Wait for table to load
      const loadResult = await pollForCondition(
        async () => {
          const status = await page.evaluate(() => {
            const isLoading = !!document.querySelector('.ant-spin-spinning');
            const hasTable = !!document.querySelector('.ant-table');
            const hasRows = document.querySelectorAll('.ant-table-row').length > 0;
            const rowCount = document.querySelectorAll('.ant-table-row').length;
            return { ready: !isLoading && hasTable && hasRows, isLoading, hasTable, hasRows, rowCount };
          });
          return status;
        },
        { timeout: 60000, interval: 1000, description: 'TicketsTab', log }
      );

      // Check login
      const pageContent = await page.evaluate(() => document.body.innerText);
      if (pageContent.includes('登录') || pageContent.includes('Login')) {
        throw new Error('Not logged in - please update cookies');
      }

      await addScreenshot(page, '1_release_history');

      // Find waiting workorder
      await setStage('Finding workorder');
      log('Looking for workorder in waiting state...');

      const workorderFound = await page.evaluate(() => {
        const rows = document.querySelectorAll('.ant-table-row');
        for (const row of rows) {
          const text = row.textContent.toLowerCase();
          if (text.includes('waiting') || text.includes('等待') || text.includes('pending')) {
            row.click();
            return true;
          }
        }
        return false;
      });

      if (!workorderFound) {
        task.status = 'completed';
        task.result = 'No waiting workorder found';
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
        log('No waiting workorder found');
        await cleanupBrowser(ctx, taskId, browser, log, true);
        return;
      }

      await new Promise(r => setTimeout(r, 3000));
      await addScreenshot(page, '2_workorder_detail');

      // Handle workorder detail and find iframe
      await setStage('Loading workorder details');
      log('Looking for workorder content in iframes...');

      let workFrame = null;
      const frames = page.frames();
      for (const frame of frames) {
        try {
          const frameUrl = frame.url();
          if (frameUrl.includes('bits.bytedance.net') || frameUrl.includes('devops')) {
            workFrame = frame;
            log(`Found workorder frame: ${frameUrl.substring(0, 100)}`);
            break;
          }
        } catch (e) {}
      }

      if (!workFrame) {
        log('No iframe found, using main page');
        workFrame = page;
      }

      // Click publish button
      await setStage('Starting publish');
      log('Looking for publish button...');

      const publishResult = await pollForCondition(
        async () => {
          const status = await workFrame.evaluate(() => {
            const buttons = document.querySelectorAll('button, .ant-btn, .arco-btn');
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim();
              if (text.includes('开始发布') || text.includes('Publish') || text.includes('Start')) {
                const isDisabled = btn.disabled ||
                  btn.classList.contains('ant-btn-disabled') ||
                  btn.classList.contains('arco-btn-disabled');
                const hasLoading = btn.classList.contains('ant-btn-loading') ||
                  btn.classList.contains('arco-btn-loading');
                return {
                  ready: !isDisabled && !hasLoading,
                  found: true,
                  isDisabled,
                  hasLoading,
                  text
                };
              }
            }
            return { ready: false, found: false };
          });
          return status;
        },
        { timeout: 60000, interval: 1000, description: 'PublishButton', log }
      );

      if (publishResult.ready) {
        await workFrame.evaluate(() => {
          const buttons = document.querySelectorAll('button, .ant-btn, .arco-btn');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text.includes('开始发布') || text.includes('Publish') || text.includes('Start')) {
              btn.click();
              return;
            }
          }
        });
        log('Publish button clicked');
        await new Promise(r => setTimeout(r, 3000));
        await addScreenshot(page, '3_publish_initiated');
      } else {
        log(`Publish button not ready: ${JSON.stringify(publishResult)}`);
      }

      // Wait for confirm stage
      await setStage('Waiting for confirm stage');
      log('Waiting for 完成确认 (confirm) stage...');

      const confirmResult = await pollForCondition(
        async () => {
          const status = await workFrame.evaluate(() => {
            const pageText = document.body.innerText;
            const hasConfirmStage = pageText.includes('完成确认') || pageText.includes('Confirm');
            const buttons = document.querySelectorAll('button, .ant-btn, .arco-btn');
            let hasConfirmButton = false;
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim();
              if (text === '确认' || text === 'Confirm') {
                hasConfirmButton = true;
                break;
              }
            }
            return {
              ready: hasConfirmStage && hasConfirmButton,
              hasConfirmStage,
              hasConfirmButton
            };
          });
          return status;
        },
        { timeout: 180000, interval: 2000, description: 'ConfirmStage', log }
      );

      if (confirmResult.ready) {
        await setStage('Confirming');
        await workFrame.evaluate(() => {
          const buttons = document.querySelectorAll('button, .ant-btn, .arco-btn');
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text === '确认' || text === 'Confirm') {
              btn.click();
              return;
            }
          }
        });
        log('Confirm button clicked');
        await new Promise(r => setTimeout(r, 2000));
        await addScreenshot(page, '4_confirmed');

        task.status = 'completed';
        task.result = 'Workorder published and confirmed';
      } else {
        log('Confirm stage not reached within timeout');
        await setStage('Publish initiated');
        task.status = 'completed';
        task.result = 'Workorder publish initiated, manual confirm may be needed';
      }

      task.endTime = new Date().toISOString();
      log('Task completed!');
      await saveTaskToDb(taskId, task);

      // Cleanup
      await cleanupBrowser(ctx, taskId, browser, log, true);

    } catch (error) {
      log(`Error: ${error.message}`);
      task.status = 'error';
      task.error = error.message;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);

      if (browser) {
        try { await browser.close(); } catch (e) {}
        runningBrowsers.delete(taskId);
      }
    }
  }

  return runWorkorderTask;
}

module.exports = { createWorkorderTaskRunner };
