/**
 * Release Monitor Task Runner
 *
 * Monitors the self-testing pipeline in bits.bytedance.net devops
 * and waits until all projects turn green.
 *
 * Page structure (based on analysis):
 * - URL: https://bits.bytedance.net/devops/201141148930/develop
 * - Task list with columns: Dev task name, Associated release ticket, Developer, Pipeline status, Project
 * - Task rows have data-dev-task-status attribute
 * - Clicking task row opens detail page
 * - Detail page has tabs including "Dev Process"
 * - Dev Process has phases: Develop, Release, Test
 * - Self Testing Pipeline is in the Develop phase
 */

const { createTaskUtils, setupBrowserPage, getBrowserArgs, cleanupBrowser } = require('./base-runner');

console.log('[release-monitor-runner] Module loaded at:', new Date().toISOString());

const BITS_DEVOPS_URL = 'https://bits.bytedance.net/devops/201141148930/develop';
const DEFAULT_POLL_INTERVAL = 30000; // 30 seconds
const DEFAULT_TIMEOUT = 1800000; // 30 minutes
const MAX_RETRIES = 3;

/**
 * Create a release monitor task runner with injected dependencies
 * @param {Object} ctx - Context with shared dependencies
 * @returns {Function} runReleaseMonitorTask function
 */
function createReleaseMonitorRunner(ctx) {
  const {
    screenshots,
    runningBrowsers,
    proxyConfig,
    saveScreenshotToDb,
    saveTaskToDb,
    createSelectiveProxy,
    loadCookies,
    convertToPuppeteerCookies,
    browserPool
  } = ctx;

  /**
   * Safely evaluate on page with null checks
   */
  async function safeEvaluate(page, fn, ...args) {
    try {
      return await page.evaluate(fn, ...args);
    } catch (e) {
      // Return null on evaluation errors (page navigating, context destroyed, etc.)
      return null;
    }
  }

  /**
   * Wait for page content to load with retry
   */
  async function waitForPageContent(page, log, patterns, maxWait = 30000) {
    const startTime = Date.now();
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;

    while (Date.now() - startTime < maxWait) {
      try {
        // Wait for network to settle (Puppeteer)
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

        // Wait for body to exist
        await page.waitForSelector('body', { timeout: 5000 }).catch(() => {});

        const found = await safeEvaluate(page, (pats) => {
          if (!document || !document.body) return false;
          const text = (document.body.innerText || '').toLowerCase();
          return pats.some(p => text.includes(p.toLowerCase()));
        }, patterns);

        if (found) return true;
        consecutiveErrors = 0; // Reset on successful evaluation

        // Check for page error
        const hasError = await safeEvaluate(page, () => {
          if (!document || !document.body) return false;
          const text = document.body.innerText || '';
          return text.includes('Page error') || text.includes('Resource loading error');
        });

        if (hasError) {
          log('Page error detected, reloading...');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
        }
      } catch (e) {
        // Page might be navigating, wait and retry
        consecutiveErrors++;
        const errMsg = (e.message || '').slice(0, 50);
        if (log) log(`waitForPageContent (${consecutiveErrors}/${maxConsecutiveErrors}): ${errMsg}`);

        // If too many consecutive errors, let the outer handler deal with it
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw e;
        }

        // Wait longer between retries on errors
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  /**
   * Run a release monitor task
   */
  async function runReleaseMonitorTask(taskId, task, retryCount = 0) {
    const utils = createTaskUtils(ctx, taskId, task);
    const { log, addScreenshot, setStage } = utils;

    let browser = null;

    try {
      console.log(`[release_monitor] Starting task ${taskId}, retry=${retryCount}`);
      await setStage('Initializing');
      log(`Task params: task_name=${task.task_name}${retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''}`);

      if (!task.task_name) {
        throw new Error('task_name parameter is required');
      }

      // Create browser with proxy if enabled
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

      // Step 1: Navigate to devops page
      await setStage('Opening DevOps');
      log(`Opening: ${BITS_DEVOPS_URL}`);

      // Navigate with retry on navigation errors
      let navSuccess = false;
      for (let navAttempt = 0; navAttempt < 5 && !navSuccess; navAttempt++) {
        try {
          if (navAttempt > 0) {
            log(`Navigation retry ${navAttempt}...`);
            await new Promise(r => setTimeout(r, 3000));
          }
          await page.goto(BITS_DEVOPS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
          navSuccess = true;
        } catch (e) {
          log(`Navigation attempt ${navAttempt + 1} warning: ${e.message.slice(0, 80)}`);
          // Wait for any redirects/SSO to complete
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      // Wait for page to fully stabilize after navigation
      log('Waiting for page to stabilize...');
      await new Promise(r => setTimeout(r, 5000));

      // Wait for page to load with content - need to wait for actual task data, not just skeleton
      log('[DEBUG-V2] Waiting for task list - looking for Dev task header...');
      let pageLoaded = await waitForPageContent(page, log, ['Dev task'], 30000);
      log(`Header wait result: ${pageLoaded}`);

      if (!pageLoaded) {
        await addScreenshot(page, 'page-load-failed');
        throw new Error('Failed to load DevOps page - header not found');
      }

      // Wait additional time for task list data to load (skeleton -> actual data)
      // Look for task name or status indicators (Executing, Completed, Closed)
      log(`Waiting for task data to load (looking for: ${task.task_name}, Executing, Completed)...`);
      pageLoaded = await waitForPageContent(page, log, [task.task_name, 'Executing', 'Completed', 'Closed'], 30000);
      log(`Task data wait result: ${pageLoaded}`);

      if (!pageLoaded) {
        // Take screenshot to see current state
        await addScreenshot(page, 'task-data-not-loaded');
        log('Task data not loaded yet, trying to scroll or wait more...');
        // Wait a bit more and retry
        await new Promise(r => setTimeout(r, 5000));
      }

      await addScreenshot(page, 'devops-list');

      // Step 2: Find and click on the task
      await setStage('Finding Task');
      log(`Looking for task: "${task.task_name}"`);

      // Click on the task row
      const taskClicked = await safeEvaluate(page, (taskName) => {
        // Find elements containing the task name
        const allElements = Array.from(document.querySelectorAll('*'));

        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text.toLowerCase().includes(taskName.toLowerCase()) &&
              text.length < 300 &&
              el.offsetParent !== null) {

            // Find the parent row with data-dev-task-status or row class
            let rowElement = el;
            let parent = el.parentElement;
            for (let i = 0; i < 15 && parent; i++) {
              if (parent.getAttribute('data-dev-task-status') ||
                  (parent.className && (
                    parent.className.includes('row') ||
                    parent.className.includes('Row') ||
                    parent.className.includes('item') ||
                    parent.className.includes('Item')
                  ))) {
                rowElement = parent;
                break;
              }
              parent = parent.parentElement;
            }

            // Click the row
            rowElement.click();
            return { clicked: true, text: text.slice(0, 100), rowClass: rowElement.className };
          }
        }

        return { clicked: false };
      }, task.task_name);

      log(`Task click result: ${JSON.stringify(taskClicked)}`);

      if (!taskClicked.clicked) {
        await addScreenshot(page, 'task-not-found');
        throw new Error(`Task not found: ${task.task_name}`);
      }

      // Wait for navigation to task detail
      await new Promise(r => setTimeout(r, 5000));
      await addScreenshot(page, 'task-detail');

      // Check if we're on a detail page
      const currentUrl = page.url();
      log(`Current URL: ${currentUrl}`);

      // Step 3: Navigate to Dev Process tab
      await setStage('Opening Dev Process');
      log('Looking for Dev Process tab...');

      const devProcessClicked = await safeEvaluate(page, () => {
        const patterns = ['dev process', 'devprocess', '研发流程'];
        const elements = document.querySelectorAll('[role="tab"], [class*="tab"], [class*="Tab"], a, button, span, div');

        for (const el of elements) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (el.offsetParent !== null && text.length < 50) {
            for (const pattern of patterns) {
              if (text === pattern || text.includes(pattern)) {
                el.click();
                return { clicked: true, text: el.textContent.trim() };
              }
            }
          }
        }
        return { clicked: false };
      });

      log(`Dev Process click: ${JSON.stringify(devProcessClicked)}`);
      await new Promise(r => setTimeout(r, 3000));
      await addScreenshot(page, 'dev-process-tab');

      // Step 4: Click on "Self testing pipeline" tab
      await setStage('Finding Self Testing');
      log('Looking for Self testing pipeline tab...');

      // Click on "Self testing pipeline" tab - it's an arco-volc3-tabs-header-title element
      const selfTestClicked = await safeEvaluate(page, () => {
        // Look for tab elements with "Self testing pipeline" text
        // The tab has class like "arco-volc3-tabs-header-title"
        const tabSelectors = [
          '[class*="tabs-header-title"]',
          '[class*="tab-title"]',
          '[role="tab"]',
          '.arco-tabs-header-title',
          'div[class*="tab"]'
        ];

        for (const selector of tabSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text === 'self testing pipeline' || text.includes('self testing pipeline')) {
              el.click();
              return { clicked: true, text: el.textContent.trim(), selector };
            }
          }
        }

        // Fallback: search all elements
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text === 'Self testing pipeline' && el.offsetParent !== null) {
            el.click();
            return { clicked: true, text, method: 'fallback' };
          }
        }

        return { clicked: false };
      });

      log(`Self Testing Pipeline tab click: ${JSON.stringify(selfTestClicked)}`);
      await new Promise(r => setTimeout(r, 3000));
      await addScreenshot(page, 'self-testing-pipeline');

      // Step 5: Click on ttec.aftersale.bot to see its status
      await setStage('Checking Pipeline Item');
      log('Looking for ttec.aftersale.bot...');

      const pipelineItemClicked = await safeEvaluate(page, () => {
        const patterns = ['ttec.aftersale.bot', 'aftersale.bot', 'aftersale_bot'];
        const elements = document.querySelectorAll('*');

        for (const el of elements) {
          const text = (el.textContent || '').trim();
          if (el.offsetParent !== null && text.length < 100) {
            for (const pattern of patterns) {
              if (text.toLowerCase().includes(pattern.toLowerCase())) {
                el.click();
                return { clicked: true, text: text.slice(0, 50) };
              }
            }
          }
        }
        return { clicked: false };
      });

      log(`Pipeline item click: ${JSON.stringify(pipelineItemClicked)}`);
      await new Promise(r => setTimeout(r, 2000));
      await addScreenshot(page, 'pipeline-item-detail');

      // Step 6: Monitor pipeline status
      await setStage('Monitoring Pipeline');
      log('Starting pipeline monitoring...');

      const startTime = Date.now();
      const timeout = task.timeout || DEFAULT_TIMEOUT;
      const pollInterval = task.poll_interval || DEFAULT_POLL_INTERVAL;
      let iteration = 0;
      let finalStatus = null;

      while (Date.now() - startTime < timeout) {
        iteration++;

        // Check pipeline status using data attributes from the page
        // Key: data-rt-deploy-stage-project-status="SUCCEEDED" for status
        // Key: data-pipeline-project-name for item names
        const status = await safeEvaluate(page, () => {
          const result = {
            allGreen: false,
            hasFailure: false,
            greenCount: 0,
            failedCount: 0,
            runningCount: 0,
            totalCount: 0,
            items: [],
            failedItems: [],
            pipelineItems: []
          };

          // Method 1: Look for elements with data-rt-deploy-stage-project-status attribute
          const statusElements = document.querySelectorAll('[data-rt-deploy-stage-project-status]');
          for (const el of statusElements) {
            const statusAttr = el.getAttribute('data-rt-deploy-stage-project-status');
            const nameEl = el.closest('[data-pipeline-project-name]');
            const name = nameEl ? nameEl.getAttribute('data-pipeline-project-name') : (el.textContent || '').trim().slice(0, 50);

            let itemStatus = 'unknown';
            if (statusAttr === 'SUCCEEDED' || statusAttr === 'SUCCESS') {
              itemStatus = 'green';
              result.greenCount++;
            } else if (statusAttr === 'FAILED' || statusAttr === 'ERROR') {
              itemStatus = 'red';
              result.failedCount++;
              result.failedItems.push(name);
            } else if (statusAttr === 'RUNNING' || statusAttr === 'PENDING') {
              itemStatus = 'yellow';
              result.runningCount++;
            }

            if (!result.pipelineItems.find(i => i.name === name)) {
              result.pipelineItems.push({ name, status: itemStatus, statusAttr });
            }
          }

          // Method 2: Look for pipeline project elements with data-pipeline-project-name
          const projectElements = document.querySelectorAll('[data-pipeline-project-name]');
          for (const el of projectElements) {
            const name = el.getAttribute('data-pipeline-project-name');
            if (result.pipelineItems.find(i => i.name === name)) continue;

            // Check for status in child elements or nearby
            const html = el.outerHTML || '';
            let itemStatus = 'unknown';

            if (html.includes('SUCCEEDED') || html.includes('success') || html.includes('green')) {
              itemStatus = 'green';
              result.greenCount++;
            } else if (html.includes('FAILED') || html.includes('fail') || html.includes('error')) {
              itemStatus = 'red';
              result.failedCount++;
              result.failedItems.push(name);
            } else if (html.includes('RUNNING') || html.includes('pending')) {
              itemStatus = 'yellow';
              result.runningCount++;
            }

            result.pipelineItems.push({ name, status: itemStatus });
          }

          // Method 3: Find PSM items and check their status icons
          // Focus on PSM names (ttec.aftersale.bot, ttec.common.tags)
          const psmPatterns = ['ttec.aftersale.bot', 'ttec.common.tags'];
          const debugInfo = [];
          const pageText = document.body.innerText || '';

          // Look for elements containing PSM names using multiple strategies
          for (const psm of psmPatterns) {
            if (result.pipelineItems.find(i => i.name === psm)) continue;

            let found = false;
            let isGreen = false;
            let isFailed = false;
            let foundMethod = '';

            // Strategy 1: Look for elements that contain the PSM text
            const allElements = document.querySelectorAll('div, span, td, li, p');
            for (const el of allElements) {
              const text = (el.textContent || '').trim();
              // Check if this element contains the PSM name (flexible match)
              if (text.includes(psm) && text.length < psm.length + 30) {
                found = true;
                foundMethod = 'contains';

                // Check for status indicators in this element and its parents
                let container = el;
                for (let i = 0; i < 6 && container; i++) {
                  const html = container.outerHTML || '';
                  const bgColor = window.getComputedStyle(container).backgroundColor || '';

                  // Check for green indicators
                  // Green background colors (like in the screenshot cards)
                  if (bgColor.includes('232, 247, 237') || bgColor.includes('230, 255, 230') ||
                      bgColor.includes('237, 255, 237') || bgColor.includes('240, 255, 240')) {
                    isGreen = true;
                  }
                  // Check for SVG icons with green colors
                  if (html.includes('#00B365') || html.includes('#52c41a') ||
                      html.includes('#00b365') || html.includes('rgb(0, 179, 101)') ||
                      html.includes('rgb(82, 196, 26)') || html.includes('CheckCircleFill') ||
                      html.includes('check-circle') || html.includes('icon-success')) {
                    isGreen = true;
                  }

                  // Check for red indicators
                  if (bgColor.includes('255, 232, 232') || bgColor.includes('255, 230, 230')) {
                    isFailed = true;
                  }
                  if (html.includes('#F53F3F') || html.includes('#ff4d4f') ||
                      html.includes('rgb(245, 63, 63)') || html.includes('CloseCircleFill') ||
                      html.includes('close-circle') || html.includes('icon-error')) {
                    isFailed = true;
                  }

                  if (isGreen || isFailed) break;
                  container = container.parentElement;
                }

                if (isGreen || isFailed) break;
              }
            }

            // Strategy 2: Check if PSM appears on page and look for overall status
            if (!found && pageText.includes(psm)) {
              found = true;
              foundMethod = 'pageText';
              // Without being able to find the exact element, check page patterns
              // Look for success indicators near the PSM name in the page text
              const psmIndex = pageText.indexOf(psm);
              const nearbyText = pageText.substring(Math.max(0, psmIndex - 50), psmIndex + psm.length + 50);
              if (nearbyText.includes('✓') || nearbyText.includes('✔') ||
                  nearbyText.toLowerCase().includes('success') ||
                  nearbyText.toLowerCase().includes('succeeded')) {
                isGreen = true;
              }
              if (nearbyText.includes('✗') || nearbyText.includes('✘') ||
                  nearbyText.toLowerCase().includes('fail') ||
                  nearbyText.toLowerCase().includes('error')) {
                isFailed = true;
              }
            }

            debugInfo.push({
              psm,
              found,
              method: foundMethod,
              isGreen,
              isFailed
            });

            const itemStatus = isFailed ? 'red' : (isGreen ? 'green' : 'unknown');
            result.pipelineItems.push({ name: psm, status: itemStatus });
          }

          result.debugInfo = debugInfo;

          // Filter to only include the specific PSMs we care about
          const targetPsms = ['ttec.aftersale.bot', 'ttec.common.tags'];
          const psmItems = result.pipelineItems.filter(i => targetPsms.includes(i.name));
          result.pipelineItems = psmItems;

          // Recalculate counts based on PSM items only
          result.greenCount = psmItems.filter(i => i.status === 'green').length;
          result.failedCount = psmItems.filter(i => i.status === 'red').length;
          result.runningCount = psmItems.filter(i => i.status === 'yellow').length;
          result.failedItems = psmItems.filter(i => i.status === 'red').map(i => i.name);
          result.totalCount = psmItems.length;

          // Get overall page text for additional checks
          const bodyText = document.body.innerText || '';
          const hasQualifiedFailed = bodyText.includes('Qualified detection failed');
          const hasBlockingIssue = bodyText.includes('[Blocking]');

          // Count unknown items (not yet determined)
          const unknownCount = psmItems.filter(i => i.status === 'unknown').length;
          result.unknownCount = unknownCount;

          // Logic (based on PSMs only):
          // - All PSMs green (no red, no unknown, no running) = SUCCESS, complete
          // - Any PSM definitively red = ERROR, complete
          // - Otherwise (has unknown/running) = keep waiting
          result.allGreen = result.totalCount > 0 &&
                           result.greenCount === result.totalCount &&
                           result.failedCount === 0 &&
                           result.runningCount === 0 &&
                           unknownCount === 0;

          result.hasFailure = result.failedCount > 0; // Only true failures, not unknown

          // If we have unknown PSMs, we're still waiting
          result.stillWaiting = unknownCount > 0 || result.runningCount > 0;

          result.summary = `PSMs: ${result.greenCount}/${result.totalCount} green, ${result.failedCount} failed, ${unknownCount} unknown`;
          if (result.runningCount > 0) result.summary += `, ${result.runningCount} running`;
          if (hasQualifiedFailed) result.summary += ' (page shows Qualified detection failed)';
          if (hasBlockingIssue) result.summary += ' (page has blocking issues)';

          return result;
        });

        if (!status) {
          log(`[Poll ${iteration}] Page evaluation failed, retrying...`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        log(`[Poll ${iteration}] ${status.summary}`);
        if (status.debugInfo && status.debugInfo.length > 0) {
          log(`[Poll ${iteration}] Debug: ${JSON.stringify(status.debugInfo)}`);
        }
        if (status.pipelineItems && status.pipelineItems.length > 0) {
          log(`[Poll ${iteration}] Items: ${JSON.stringify(status.pipelineItems)}`);
        }
        finalStatus = status;

        if (status.allGreen) {
          await addScreenshot(page, 'pipeline-all-green');
          log('All pipeline items are GREEN!');
          break;
        }

        // Check for failures - exit immediately when any item is red
        if (status.hasFailure) {
          await addScreenshot(page, 'pipeline-has-failures');
          log(`Pipeline has failures: ${status.failedItems.join(', ')}`);
          break;
        }

        // Continue waiting if there are unknown items (neither all green nor any red)
        if (status.stillWaiting) {
          log(`Still waiting - ${status.unknownCount} unknown, ${status.runningCount || 0} running`);
        }

        // Save progress
        task.result = {
          iteration,
          elapsed: Math.round((Date.now() - startTime) / 1000),
          ...status
        };
        await saveTaskToDb(taskId, task);

        // Take periodic screenshots
        if (iteration % 5 === 0) {
          await addScreenshot(page, `pipeline-status-${iteration}`);
        }

        // Wait before next poll
        log(`Waiting ${pollInterval / 1000}s...`);
        await new Promise(r => setTimeout(r, pollInterval));

        // Soft refresh - click on the page to trigger any updates, don't reload
        // Reloading can cause navigation issues
        try {
          // Just wait - the page should auto-refresh or we can click a refresh button if available
          await safeEvaluate(page, () => {
            // Try to find and click a refresh button if present
            const refreshBtn = document.querySelector('[class*="refresh"], [class*="Refresh"], button[title*="refresh"]');
            if (refreshBtn) refreshBtn.click();
          });
        } catch (e) {
          // Ignore refresh errors
        }
      }

      // Final result
      if (finalStatus && finalStatus.allGreen) {
        task.status = 'completed';
        task.result = {
          success: true,
          message: 'All pipeline items are green',
          duration: Math.round((Date.now() - startTime) / 1000),
          ...finalStatus
        };
        log('Task completed - all green!');
      } else if (finalStatus && finalStatus.hasFailure) {
        task.status = 'error';
        task.result = {
          success: false,
          message: `Pipeline has failures: ${finalStatus.failedItems.join(', ')}`,
          duration: Math.round((Date.now() - startTime) / 1000),
          ...finalStatus
        };
        log(`Task error - pipeline failures: ${finalStatus.failedItems.join(', ')}`);
      } else {
        task.status = 'completed';
        task.result = {
          success: false,
          message: finalStatus ? `Timeout: ${finalStatus.summary}` : 'Monitoring timed out',
          duration: Math.round((Date.now() - startTime) / 1000),
          ...(finalStatus || {})
        };
        log(`Task completed - ${finalStatus ? finalStatus.summary : 'timeout'}`);
      }

      task.endTime = new Date().toISOString();
      await addScreenshot(page, 'final-status');
      await saveTaskToDb(taskId, task);

      // Cleanup
      await cleanupBrowser(ctx, taskId, browser, log, true);

    } catch (error) {
      const errMsg = error.message || String(error);
      console.log(`[release_monitor] Error in task ${taskId}: ${errMsg}`);
      log(`Error: ${errMsg}`);

      // Retry on navigation context destroyed or similar transient errors
      const isTransientError = errMsg.includes('Execution context') ||
                               errMsg.includes('context was destroyed') ||
                               errMsg.includes('Session closed') ||
                               errMsg.includes('Target closed') ||
                               errMsg.includes('Protocol error');

      log(`Retry check: isTransient=${isTransientError}, retryCount=${retryCount}, MAX_RETRIES=${MAX_RETRIES}`);

      if (isTransientError && retryCount < MAX_RETRIES) {
        log(`Transient error, retrying (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
        if (browser) {
          try { await browser.close(); } catch (e) {}
          runningBrowsers.delete(taskId);
        }
        await new Promise(r => setTimeout(r, 3000));
        return runReleaseMonitorTask(taskId, task, retryCount + 1);
      }

      task.status = 'error';
      task.error = errMsg;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);

      if (browser) {
        await cleanupBrowser(ctx, taskId, browser, log, false);
      }
      throw error;
    }
  }

  return runReleaseMonitorTask;
}

module.exports = { createReleaseMonitorRunner };
