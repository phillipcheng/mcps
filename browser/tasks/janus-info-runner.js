/**
 * Janus Mini Info Task Runner
 *
 * Read-only task to get current and latest IDL version info for a branch.
 * Parameters: psm, env (lane), idl_branch, api_group_id (optional shortcut)
 * Output: current_version, latest_version for the specified branch
 */

const { createTaskUtils, setupBrowserPage, getBrowserArgs, cleanupBrowser } = require('./base-runner');

/**
 * Create a Janus info task runner with injected dependencies
 * @param {Object} ctx - Context with shared dependencies
 * @returns {Function} runJanusInfoTask function
 */
function createJanusInfoRunner(ctx) {
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
   * Run a Janus Mini info (read-only) task
   */
  async function runJanusInfoTask(taskId, task, retryCount = 0) {
    const MAX_RETRIES = 2;
    const utils = createTaskUtils(ctx, taskId, task);
    const { log, addScreenshot, setStage } = utils;

    let browser = null;

    try {
      await setStage('Initializing');
      log(`Task params: psm=${task.psm}, env=${task.env}, idl_branch=${task.idl_branch}, api_group_id=${task.api_group_id || 'none'}`);

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

      // Navigate to IDL config page
      await setStage('Opening IDL config page');

      let idlConfigUrl;
      if (task.api_group_id) {
        // Direct URL with api_group_id
        idlConfigUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${task.api_group_id}/tab/IdlConfig?lane=${task.env}&x-resource-account=boe&x-bc-region-id=bytedance`;
        log(`Using direct URL with api_group_id=${task.api_group_id}`);
      } else {
        // Need to search through list first
        await searchPsmInList(page, task, utils, ctx, taskId);
        idlConfigUrl = page.url();
      }

      log(`Navigating to: ${idlConfigUrl}`);
      if (task.api_group_id) {
        await page.goto(idlConfigUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        browserPool.recordUrl(idlConfigUrl, taskId);
      }

      // Wait for page to load
      await setStage('Waiting for page load');
      await pollForCondition(
        async () => {
          const status = await page.evaluate(() => {
            const editIcons = document.querySelectorAll('.anticon-edit, [aria-label="edit"]');
            const isLoading = !!document.querySelector('.ant-spin-spinning');
            return {
              ready: editIcons.length > 0 && !isLoading,
              hasEditButton: editIcons.length > 0,
              isLoading
            };
          });
          return status;
        },
        { timeout: 60000, interval: 1000, description: 'PageLoad', log }
      );

      // Check login
      const pageContent = await page.evaluate(() => document.body.innerText);
      if (pageContent.includes('登录') || pageContent.includes('Login')) {
        throw new Error('Not logged in - please update cookies');
      }

      await addScreenshot(page, '1_idl_config_page');

      // Extract version information
      await setStage('Extracting version info');
      log(`Looking for branch: ${task.idl_branch}`);

      // Click edit button to open the modal with version info
      const editClicked = await page.evaluate(() => {
        const editIcon = document.querySelector('.anticon-edit, [aria-label="edit"]');
        if (editIcon) {
          editIcon.click();
          return true;
        }
        return false;
      });

      if (!editClicked) {
        throw new Error('Could not find edit button to view version info');
      }

      await new Promise(r => setTimeout(r, 2000));
      await addScreenshot(page, '2_edit_modal_opened');

      // Extract current branch and version info from the page
      const versionInfo = await extractVersionInfo(page, task, log);

      await addScreenshot(page, '3_version_info_extracted');

      // Close the modal (click cancel or outside)
      await page.evaluate(() => {
        const cancelBtn = Array.from(document.querySelectorAll('button')).find(
          btn => btn.textContent.includes('Cancel') || btn.textContent.includes('取消')
        );
        if (cancelBtn) cancelBtn.click();
      });

      // Set result
      task.status = 'completed';
      task.result = JSON.stringify(versionInfo);
      task.endTime = new Date().toISOString();

      // Store version info in task metadata
      task.metadata = {
        ...(task.metadata || {}),
        version_info: versionInfo
      };

      log(`Version info retrieved successfully:`);
      log(`  Branch: ${versionInfo.branch}`);
      log(`  Current Version: ${versionInfo.current_version || 'N/A'}`);
      log(`  Latest Version: ${versionInfo.latest_version || 'N/A'}`);
      log(`  Available Versions: ${versionInfo.available_versions?.length || 0}`);

      await saveTaskToDb(taskId, task);

      // Cleanup
      await cleanupBrowser(ctx, taskId, browser, log, true);

    } catch (error) {
      // Handle specific errors
      if (error.message.includes('refresh cookies') || error.message.includes('Not logged in')) {
        log(`Cookie/SSO error - no retry: ${error.message}`);
        task.status = 'error';
        task.error = error.message;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);

        if (browser) {
          try { await browser.close(); } catch (e) {}
          runningBrowsers.delete(taskId);
        }
        return;
      }

      // Retry on navigation context destroyed
      if (error.message.includes('Execution context was destroyed') && retryCount < MAX_RETRIES) {
        log(`Navigation context destroyed, retrying (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
        if (browser) {
          try { await browser.close(); } catch (e) {}
          runningBrowsers.delete(taskId);
        }
        await new Promise(r => setTimeout(r, 2000));
        return runJanusInfoTask(taskId, task, retryCount + 1);
      }

      // Generic error handling
      await handleTaskError({
        taskId, task, error, browser, log, addScreenshot,
        runningBrowsers, saveTaskToDb, forceKillBrowser
      });
    }
  }

  /**
   * Search for PSM in list and navigate to detail page
   */
  async function searchPsmInList(page, task, utils, ctx, taskId) {
    const { log, addScreenshot, setStage } = utils;
    const { browserPool, pollForCondition } = ctx;

    await setStage('Searching PSM in list');
    const janusUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance`;
    log(`Opening Janus list: ${janusUrl}`);

    await page.goto(janusUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    browserPool.recordUrl(janusUrl, taskId);
    await new Promise(r => setTimeout(r, 3000));

    // Search for PSM
    log(`Searching for PSM: ${task.psm}`);
    await page.waitForSelector('input[placeholder*="Search"], .ant-input', { timeout: 30000 });
    const searchInput = await page.$('input[placeholder*="Search"], .ant-input');
    if (searchInput) {
      await searchInput.click();
      await searchInput.type(task.psm, { delay: 50 });
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 2000));
    }

    await addScreenshot(page, '0_search_result');

    // Click on PSM row
    const psmClicked = await page.evaluate((targetPsm) => {
      const rows = document.querySelectorAll('.ant-table-row, tr');
      for (const row of rows) {
        if (row.textContent.includes(targetPsm)) {
          const link = row.querySelector('a');
          if (link) { link.click(); return true; }
          row.click();
          return true;
        }
      }
      return false;
    }, task.psm);

    if (!psmClicked) {
      throw new Error(`PSM not found in list: ${task.psm}`);
    }

    await new Promise(r => setTimeout(r, 3000));

    // Navigate to IDL tab with lane
    const currentUrl = page.url();
    const miniIdMatch = currentUrl.match(/\/mini\/(\d+)/);
    if (miniIdMatch) {
      const miniId = miniIdMatch[1];
      const idlUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${miniId}/tab/IdlConfig?lane=${task.env}&x-resource-account=boe&x-bc-region-id=bytedance`;
      log(`Navigating to IDL config: ${idlUrl}`);
      await page.goto(idlUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      browserPool.recordUrl(idlUrl, taskId);

      // Store api_group_id for future use
      task.api_group_id = miniId;
      log(`Discovered api_group_id: ${miniId}`);
    }
  }

  /**
   * Extract version information from the edit modal
   * The dropdown options contain both branch and version in one string like "feat/sell_rule 1.0.768"
   * We need to:
   * 1. Click on the select dropdown
   * 2. Find all options matching our target branch
   * 3. Extract version numbers and find the max
   */
  async function extractVersionInfo(page, task, log) {
    const versionInfo = {
      psm: task.psm,
      env: task.env,
      branch: task.idl_branch,
      current_version: null,
      latest_version: null,
      available_versions: [],
      current_branch: null
    };

    // Wait for modal to fully load
    await new Promise(r => setTimeout(r, 1000));

    // Get current version displayed on page before clicking dropdown
    const currentInfo = await page.evaluate(() => {
      const pageText = document.body.innerText;
      // Look for "Current idl:" followed by version info
      const currentIdlMatch = pageText.match(/Current idl[:\s]*([^\n]+)/i);
      // Also look for version pattern like "1.0.768"
      const versionMatch = pageText.match(/(\d+\.\d+\.\d+)/);

      // Get select values with their indices
      const selects = document.querySelectorAll('.ant-select-selector');
      const selectInfo = [];
      selects.forEach((s, idx) => {
        selectInfo.push({
          index: idx,
          text: s.textContent.trim(),
          hasVersion: /\d+\.\d+\.\d+/.test(s.textContent)
        });
      });

      return {
        currentIdl: currentIdlMatch ? currentIdlMatch[1].trim() : null,
        version: versionMatch ? versionMatch[1] : null,
        selectInfo
      };
    });

    log(`Current IDL info: "${currentInfo.currentIdl}", version: "${currentInfo.version}"`);
    log(`Selects found: ${currentInfo.selectInfo.map(s => `[${s.index}]${s.text}${s.hasVersion ? '*' : ''}`).join(' | ')}`);
    versionInfo.current_version = currentInfo.version;

    // Find the select that shows a version number (like "1.0.766") - this is the branch/version dropdown
    const versionSelectIndex = currentInfo.selectInfo.findIndex(s => s.hasVersion);
    log(`Version select index: ${versionSelectIndex}`);

    if (versionSelectIndex === -1) {
      log('No version select found, cannot extract version info');
      return versionInfo;
    }

    // Click specifically on the version select to open it
    log(`Clicking version select at index ${versionSelectIndex}...`);
    await page.evaluate((idx) => {
      const selects = document.querySelectorAll('.ant-select-selector');
      if (selects[idx]) {
        selects[idx].click();
      }
    }, versionSelectIndex);

    await new Promise(r => setTimeout(r, 500));

    // Type the branch name to filter the dropdown (required for Ant Design Select)
    log(`Typing branch name to filter: ${task.idl_branch}`);
    await page.keyboard.type(task.idl_branch);
    await new Promise(r => setTimeout(r, 1500)); // Wait for filtered options to appear

    // Get all options and filter for our target branch
    const branchVersions = await page.evaluate((targetBranch) => {
      const options = document.querySelectorAll('.ant-select-item, .ant-select-item-option');
      const result = {
        allOptions: [],
        matchingOptions: []
      };

      for (const option of options) {
        const optionText = option.textContent.trim();
        if (optionText.length > 0) {
          result.allOptions.push(optionText);
        }

        // Check if this option contains our target branch
        if (optionText.includes(targetBranch)) {
          // Extract version number from the option text
          const versionMatch = optionText.match(/(\d+\.\d+\.\d+)/);
          if (versionMatch) {
            result.matchingOptions.push({
              text: optionText,
              version: versionMatch[1]
            });
          }
        }
      }

      return result;
    }, task.idl_branch);

    log(`Total options in dropdown: ${branchVersions.allOptions.length}`);
    log(`Options matching branch "${task.idl_branch}": ${branchVersions.matchingOptions.length}`);

    if (branchVersions.matchingOptions.length > 0) {
      // Sort versions descending to get max first
      branchVersions.matchingOptions.sort((a, b) => {
        const aParts = a.version.split('.').map(Number);
        const bParts = b.version.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          if (aParts[i] !== bParts[i]) return bParts[i] - aParts[i];
        }
        return 0;
      });

      // Extract just the version numbers
      versionInfo.available_versions = branchVersions.matchingOptions.map(o => o.version);
      versionInfo.latest_version = versionInfo.available_versions[0]; // Max version after sorting

      log(`Max (latest) version for ${task.idl_branch}: ${versionInfo.latest_version}`);
      log(`All versions: ${versionInfo.available_versions.join(', ')}`);
    } else {
      log(`No versions found for branch "${task.idl_branch}"`);
      log(`Available options (first 10): ${branchVersions.allOptions.slice(0, 10).join(', ')}`);
    }

    // Close dropdown
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));

    return versionInfo;
  }

  return runJanusInfoTask;
}

module.exports = { createJanusInfoRunner };
