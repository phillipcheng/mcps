/**
 * Janus Mini Update Task Runner
 *
 * This module handles the Janus Mini specific crawl/automation logic.
 * Re-exports the factory function from the original janus_mini.js for now,
 * but can be refactored to use the base-runner utilities.
 */

const puppeteer = require('puppeteer');
const { createTaskUtils, setupBrowserPage, getBrowserArgs, cleanupBrowser } = require('./base-runner');

/**
 * Create a Janus task runner with injected dependencies
 * @param {Object} ctx - Context with shared dependencies
 * @returns {Function} runJanusTask function
 */
function createJanusTaskRunner(ctx) {
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
   * Run a Janus Mini update task
   */
  async function runJanusTask(taskId, task, retryCount = 0) {
    const MAX_RETRIES = 3;
    const utils = createTaskUtils(ctx, taskId, task);
    const { log, addScreenshot, setStage, clickByText } = utils;

    let browser = null;

    try {
      await setStage('Initializing');
      log(`Task params: psm=${task.psm}, env=${task.env}, idl_branch=${task.idl_branch}, idl_version=${task.idl_version || 'max'}, api_group_id=${task.api_group_id}`);

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

      // Shortcut: if api_group_id is provided, go directly to IDL config page
      if (task.api_group_id) {
        await runDirectIdlConfig(page, task, utils, ctx, taskId);
      } else {
        await runListSearch(page, task, utils, ctx, taskId);
      }

      // Continue with IDL branch update
      await updateIdlBranch(page, task, utils, ctx, taskId);

      // Handle deployment
      await handleDeployment(page, task, utils, ctx, taskId);

      // Success
      task.status = 'completed';
      task.result = `IDL branch updated to ${task.idl_branch}`;
      task.endTime = new Date().toISOString();
      log('Task completed!');
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
        return runJanusTask(taskId, task, retryCount + 1);
      }

      // Generic error handling
      await handleTaskError({
        taskId, task, error, browser, log, addScreenshot,
        runningBrowsers, saveTaskToDb, forceKillBrowser
      });
    }
  }

  // Helper functions for different stages
  async function runDirectIdlConfig(page, task, utils, ctx, taskId) {
    const { log, addScreenshot, setStage } = utils;
    const { pollForCondition, browserPool } = ctx;

    await setStage('Opening IDL config directly');
    const directUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${task.api_group_id}/tab/IdlConfig?lane=${task.env}&x-resource-account=boe&x-bc-region-id=bytedance`;
    log(`Shortcut: Opening IDL config directly with api_group_id=${task.api_group_id}`);
    log(`URL: ${directUrl}`);

    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    browserPool.recordUrl(directUrl, taskId);

    // Poll for Edit button
    const pageLoadResult = await pollForCondition(
      async () => {
        let status = await page.evaluate(() => {
          const editIcons = document.querySelectorAll('.anticon-edit, [aria-label="edit"], span[class*="anticon-edit"]');
          const isLoading = !!document.querySelector('.ant-spin-spinning');
          return {
            ready: editIcons.length > 0 && !isLoading,
            hasEditButton: editIcons.length > 0,
            editButtonCount: editIcons.length,
            isLoading
          };
        });

        if (status.ready) return status;

        // Check iframes
        const frames = page.frames();
        for (let i = 0; i < frames.length; i++) {
          try {
            const frameStatus = await frames[i].evaluate(() => {
              const editIcons = document.querySelectorAll('.anticon-edit, [aria-label="edit"]');
              const isLoading = !!document.querySelector('.ant-spin-spinning');
              return {
                ready: editIcons.length > 0 && !isLoading,
                hasEditButton: editIcons.length > 0,
                editButtonCount: editIcons.length,
                isLoading
              };
            });
            if (frameStatus.hasEditButton) {
              return { ...frameStatus, frameIndex: i };
            }
          } catch (e) {}
        }
        return status;
      },
      { timeout: 120000, interval: 1000, description: 'PageLoad', log }
    );

    // Check login
    const pageContent = await page.evaluate(() => document.body.innerText);
    if (pageContent.includes('登录') || pageContent.includes('Login')) {
      throw new Error('Not logged in - please update cookies');
    }

    await addScreenshot(page, '1_direct_idl_config');

    // Verify lane
    await setStage('Verifying lane');
    log(`Verifying lane is set to: ${task.env}...`);
    await verifyLane(page, task, utils);
    await addScreenshot(page, '2_lane_verified');

    // Wait for form
    await setStage('Loading IDL form');
    await new Promise(r => setTimeout(r, 2000));
    await addScreenshot(page, '3_idl_form');
  }

  async function runListSearch(page, task, utils, ctx, taskId) {
    const { log, addScreenshot, setStage } = utils;
    const { browserPool, saveTaskToDb, pollForCondition } = ctx;

    await setStage('Opening Janus Mini list');
    const janusUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance`;
    log(`Step 1: Opening ${janusUrl}`);

    await page.goto(janusUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    browserPool.recordUrl(janusUrl, taskId);
    await new Promise(r => setTimeout(r, 3000));

    const pageContent = await page.evaluate(() => document.body.innerText);
    if (pageContent.includes('登录') || pageContent.includes('Login')) {
      throw new Error('Not logged in - please update cookies');
    }

    await addScreenshot(page, '1_list_view');

    // Search for PSM
    await setStage('Searching for PSM');
    log(`Searching for PSM: ${task.psm}`);

    // Find and click search input
    await page.waitForSelector('input[placeholder*="Search"], .ant-input', { timeout: 30000 });
    const searchInput = await page.$('input[placeholder*="Search"], .ant-input');
    if (searchInput) {
      await searchInput.click();
      await searchInput.type(task.psm, { delay: 50 });
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 2000));
    }

    await addScreenshot(page, '2_search_result');

    // Click on the PSM row
    await setStage('Selecting PSM');
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
    await addScreenshot(page, '3_psm_detail');
  }

  async function verifyLane(page, task, utils) {
    const { log } = utils;

    const currentLane = await page.evaluate(() => {
      const selects = document.querySelectorAll('.ant-select');
      for (const select of selects) {
        const text = select.textContent.toLowerCase();
        if (text.includes('lane') || text.includes('prod') || text.includes('boe')) {
          return select.textContent.trim();
        }
      }
      return null;
    });
    log(`Current lane display: ${currentLane}`);

    if (currentLane && !currentLane.includes(task.env)) {
      log(`Lane mismatch, selecting correct lane...`);

      await page.evaluate(() => {
        const selects = document.querySelectorAll('.ant-select-selector');
        for (const select of selects) {
          const text = select.textContent.toLowerCase();
          if (text.includes('lane') || text.includes('prod') || text.includes('boe')) {
            select.click();
            return;
          }
        }
        if (selects.length > 0) selects[0].click();
      });

      await new Promise(r => setTimeout(r, 500));

      await page.evaluate((targetEnv) => {
        const options = document.querySelectorAll('.ant-select-item, .ant-select-item-option');
        for (const option of options) {
          if (option.textContent.includes(targetEnv)) {
            option.click();
            return;
          }
        }
      }, task.env);

      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async function updateIdlBranch(page, task, utils, ctx, taskId) {
    const { log, addScreenshot, setStage } = utils;

    await setStage('Updating IDL branch');
    log(`Setting IDL branch to: ${task.idl_branch}`);

    // Click edit button
    const editClicked = await page.evaluate(() => {
      const editIcon = document.querySelector('.anticon-edit, [aria-label="edit"]');
      if (editIcon) {
        editIcon.click();
        return true;
      }
      return false;
    });

    if (!editClicked) {
      log('Edit icon not found in main page, checking frames...');
      const frames = page.frames();
      for (const frame of frames) {
        try {
          const clicked = await frame.evaluate(() => {
            const editIcon = document.querySelector('.anticon-edit, [aria-label="edit"]');
            if (editIcon) { editIcon.click(); return true; }
            return false;
          });
          if (clicked) {
            log('Edit icon clicked in iframe');
            break;
          }
        } catch (e) {}
      }
    }

    await new Promise(r => setTimeout(r, 1500));
    await addScreenshot(page, '4_edit_modal');

    // Select branch
    await setStage('Selecting branch');

    // Find and click branch dropdown
    await page.evaluate((targetBranch) => {
      const selects = document.querySelectorAll('.ant-select-selector');
      for (const select of selects) {
        if (select.textContent.includes('branch') || select.textContent.includes('feat') || select.textContent.includes('main')) {
          select.click();
          return;
        }
      }
      // Click second select (usually branch)
      if (selects.length > 1) selects[1].click();
    }, task.idl_branch);

    await new Promise(r => setTimeout(r, 500));

    // Select the branch
    const branchSelected = await page.evaluate((targetBranch) => {
      const options = document.querySelectorAll('.ant-select-item, .ant-select-item-option');
      for (const option of options) {
        if (option.textContent.includes(targetBranch)) {
          option.click();
          return true;
        }
      }
      return false;
    }, task.idl_branch);

    if (!branchSelected) {
      log(`Branch ${task.idl_branch} not found in dropdown`);
    }

    await new Promise(r => setTimeout(r, 1000));
    await addScreenshot(page, '5_branch_selected');

    // Select version - filter by branch, then select max or specific version
    await setStage('Selecting version');
    const targetVersion = task.idl_version; // null means select max for branch
    const targetBranch = task.idl_branch;
    log(`Selecting version: ${targetVersion || 'max for branch ' + targetBranch}`);

    // Wait for form to stabilize after branch selection
    await new Promise(r => setTimeout(r, 1500));

    try {
      // Find and click the version dropdown (selector with version number format)
      const versionInfo = await page.evaluate(() => {
        const selectors = document.querySelectorAll('.ant-select-selector');
        for (let i = 0; i < selectors.length; i++) {
          const text = selectors[i].textContent.trim();
          // Version format: x.x.x
          if (/^\d+\.\d+\.\d+$/.test(text)) {
            return { index: i, currentVersion: text };
          }
        }
        return { index: -1 };
      });

      log(`Version dropdown: index=${versionInfo.index}, current=${versionInfo.currentVersion || 'N/A'}`);

      if (versionInfo.index >= 0) {
        // Click to open dropdown
        const selectors = await page.$$('.ant-select-selector');
        await selectors[versionInfo.index].click();
        log('Clicked version dropdown');

        // Wait for dropdown options to load
        await new Promise(r => setTimeout(r, 1000));

        // Get all options, filter by branch, select max or specific version
        const selectResult = await page.evaluate((targetVer, branch) => {
          const optionElements = document.querySelectorAll('.rc-virtual-list-holder-inner .ant-select-item-option');

          if (optionElements.length === 0) {
            return { selected: false, reason: 'no options found', optionCount: 0 };
          }

          // Parse all options
          const allOptions = [];
          for (const opt of optionElements) {
            const text = opt.textContent;
            // Extract version (e.g., "Version:1.0.8" or just version number)
            const versionMatch = text.match(/Version[:\s]*(\d+\.\d+\.\d+)/i) || text.match(/^(\d+\.\d+\.\d+)/);
            // Extract branch (e.g., "Branch: feat/sell_rule")
            const branchMatch = text.match(/Branch[:\s]*([^\s,]+)/i);

            allOptions.push({
              element: opt,
              text: text,
              version: versionMatch ? versionMatch[1] : null,
              branch: branchMatch ? branchMatch[1] : null
            });
          }

          // Filter by branch if specified
          let filteredOptions = allOptions;
          if (branch) {
            filteredOptions = allOptions.filter(o => o.branch && o.branch.includes(branch));
            // If no match by branch name, include options without branch info
            if (filteredOptions.length === 0) {
              filteredOptions = allOptions.filter(o => o.text.includes(branch) || !o.branch);
            }
          }

          if (filteredOptions.length === 0) {
            return {
              selected: false,
              reason: `no options for branch ${branch}`,
              allBranches: [...new Set(allOptions.map(o => o.branch).filter(Boolean))],
              optionCount: allOptions.length
            };
          }

          // Sort by version descending (to get max first)
          filteredOptions.sort((a, b) => {
            if (!a.version || !b.version) return 0;
            const av = a.version.split('.').map(Number);
            const bv = b.version.split('.').map(Number);
            for (let i = 0; i < 3; i++) {
              if (av[i] !== bv[i]) return bv[i] - av[i]; // descending
            }
            return 0;
          });

          let selected = null;
          if (targetVer) {
            // Find specific version
            selected = filteredOptions.find(o => o.version === targetVer);
            if (!selected) {
              // Fallback to max
              selected = filteredOptions[0];
            }
          } else {
            // Select max (first after sorting)
            selected = filteredOptions[0];
          }

          if (selected) {
            selected.element.click();
            return {
              selected: true,
              version: selected.version,
              branch: selected.branch,
              optionCount: allOptions.length,
              filteredCount: filteredOptions.length
            };
          }

          return { selected: false, reason: 'no valid option found' };
        }, targetVersion, targetBranch);

        if (selectResult.selected) {
          log(`Version selected: ${selectResult.version} (branch: ${selectResult.branch}, ${selectResult.filteredCount}/${selectResult.optionCount} options)`);
        } else {
          log(`Version selection failed: ${selectResult.reason}, branches: ${selectResult.allBranches?.join(', ') || 'N/A'}`);
        }
      } else {
        log('Version dropdown not found');
      }
    } catch (versionError) {
      log(`Version selection error: ${versionError.message}`);
    }

    await new Promise(r => setTimeout(r, 1000));
    await addScreenshot(page, '5b_version_selected');

    // Click confirm/save button
    await setStage('Confirming changes');
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, .ant-btn');
      for (const btn of buttons) {
        const text = btn.textContent.toLowerCase();
        if (text.includes('confirm') || text.includes('确认') || text.includes('save') || text.includes('保存')) {
          btn.click();
          return;
        }
      }
    });

    await new Promise(r => setTimeout(r, 2000));
    await addScreenshot(page, '6_confirmed');
  }

  async function handleDeployment(page, task, utils, ctx, taskId) {
    const { log, addScreenshot, setStage } = utils;

    if (task.dry_run) {
      log('Dry run mode - skipping deployment');
      return;
    }

    await setStage('Initiating deployment');

    // Click Deployment button
    const deployClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, .ant-btn');
      for (const btn of buttons) {
        const text = btn.textContent;
        if (text.includes('Deployment') || text.includes('部署') || text.includes('Deploy')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (deployClicked) {
      log('Deployment button clicked');
      await new Promise(r => setTimeout(r, 3000));
      await addScreenshot(page, '7_deployment');

      // Click Release button if available
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, .ant-btn');
        for (const btn of buttons) {
          const text = btn.textContent;
          if (text.includes('Release') || text.includes('发布')) {
            btn.click();
            return;
          }
        }
      });

      await new Promise(r => setTimeout(r, 2000));
      await addScreenshot(page, '8_released');
    } else {
      log('Deployment button not found');
    }
  }

  return runJanusTask;
}

module.exports = { createJanusTaskRunner };
