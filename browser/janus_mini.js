/**
 * Janus Mini Update Task Runner
 *
 * This module handles the Janus Mini specific crawl/automation logic.
 * Dependencies are injected via context object from server.js
 */

const puppeteer = require('puppeteer');

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

    const log = (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      console.log(`[${taskId}] ${msg}`);
      task.logs.push(line);
    };

    const addScreenshot = async (page, label) => {
      try {
        const data = await page.screenshot({ encoding: 'base64' });
        const taskSS = screenshots.get(taskId) || [];
        const index = taskSS.length;
        taskSS.push({ label, data, time: new Date().toISOString() });
        screenshots.set(taskId, taskSS);
        await saveScreenshotToDb(taskId, index, label, data);
        log(`Screenshot: ${label}`);
      } catch (e) {
        log(`Screenshot failed: ${e.message}`);
      }
    };

    const clickByText = async (page, selector, textPattern, description, timeout = 10000) => {
      log(`Looking for: ${description} containing "${textPattern}"`);
      await page.waitForSelector(selector, { timeout });
      const clicked = await page.evaluate((sel, pattern) => {
        const elements = Array.from(document.querySelectorAll(sel));
        const target = elements.find(el => el.textContent.includes(pattern));
        if (target) { target.click(); return true; }
        return false;
      }, selector, textPattern);
      if (!clicked) throw new Error(`Could not find ${description} with text "${textPattern}"`);
      log(`Clicked: ${description}`);
      await new Promise(r => setTimeout(r, 300));
    };

    const setStage = async (stage) => {
      task.stage = stage;
      log(`Stage: ${stage}`);
      await saveTaskToDb(taskId, task);
    };

    let browser = null;

    try {
      await setStage('Initializing');

      // Debug: log task params
      log(`Task params: psm=${task.psm}, env=${task.env}, idl_branch=${task.idl_branch}, idl_version=${task.idl_version || 'max'}, api_group_id=${task.api_group_id}`);

      // Create browser with proxy if enabled
      if (proxyConfig.proxyEnabled) {
        await createSelectiveProxy();
      }

      // Task-specific args only (common stability args handled by BrowserPool)
      const browserArgs = [
        '--window-size=1600,1000',
        '--force-device-scale-factor=1',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu-compositing',
        '--enable-features=NetworkService,NetworkServiceInProcess'
      ];

      if (proxyConfig.proxyEnabled) {
        browserArgs.push(`--proxy-server=http://127.0.0.1:${LOCAL_PROXY_PORT}`);
        log(`Using proxy: http://127.0.0.1:${LOCAL_PROXY_PORT}`);
      } else {
        log('Proxy disabled - direct connections');
      }

      // Get browser from pool (reuses existing browser if available)
      const browserResult = await browserPool.getBrowser(browserArgs, log);
      browser = browserResult.browser;
      const browserPid = browserResult.pid;
      const browserCached = browserResult.cached;

      runningBrowsers.set(taskId, { browser, pid: browserPid, startTime: Date.now() });
      log(`Browser ready (cached=${browserCached}, PID=${browserPid})`);

      // Record task in browser pool history
      browserPool.recordTask(taskId, task.type);

      const page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 1000 });
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      // Load cookies
      const rawCookies = loadCookies();
      const cookies = convertToPuppeteerCookies(rawCookies);

      log('Setting up cookies for all domains...');
      if (cookies.length > 0) {
        const domains = [...new Set(rawCookies.map(c => c.domain.replace(/^\./, '')))];
        log(`Cookie domains: ${domains.join(', ')}`);

        for (const cookie of cookies) {
          try {
            const domain = cookie.domain.replace(/^\./, '');
            const url = `https://${domain}/`;
            await page.setCookie({ ...cookie, url });

            if (domain === 'bytedance.net' && (cookie.name.includes('sso') || cookie.name.includes('bd_sso'))) {
              await page.setCookie({
                ...cookie,
                domain: '.bytedance.com',
                url: 'https://sso.bytedance.com/'
              });
              log(`Also set ${cookie.name} for bytedance.com`);
            }
          } catch (e) {
            // Ignore cookie errors
          }
        }
        log(`Loaded ${cookies.length} cookies`);
      }

      // Shortcut: if api_group_id is provided, go directly to IDL config page
      if (task.api_group_id) {
        await setStage('Opening IDL config directly');
        const directUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${task.api_group_id}/tab/IdlConfig?lane=${task.env}&x-resource-account=boe&x-bc-region-id=bytedance`;
        log(`Shortcut: Opening IDL config directly with api_group_id=${task.api_group_id}`);
        log(`URL: ${directUrl}`);

        // Use domcontentloaded for faster initial load, then poll for content
        await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        browserPool.recordUrl(directUrl, taskId);

        // Poll for Edit button to be ready (the pencil icon we click for version list)
        // Check both main page and iframes
        const pageLoadResult = await pollForCondition(
          async () => {
            // First check main page
            let status = await page.evaluate(() => {
              const editIcons = document.querySelectorAll('.anticon-edit, [aria-label="edit"], span[class*="anticon-edit"]');
              const hasEditButton = editIcons.length > 0;
              const isLoading = !!document.querySelector('.ant-spin-spinning');
              return {
                ready: hasEditButton && !isLoading,
                hasEditButton,
                editButtonCount: editIcons.length,
                isLoading,
                textLen: document.body.innerText.length,
                frameIndex: -1
              };
            });

            if (status.ready) return status;

            // Check iframes if not found in main page
            const frames = page.frames();
            for (let i = 0; i < frames.length; i++) {
              try {
                const frameStatus = await frames[i].evaluate(() => {
                  const editIcons = document.querySelectorAll('.anticon-edit, [aria-label="edit"], span[class*="anticon-edit"]');
                  const hasEditButton = editIcons.length > 0;
                  const isLoading = !!document.querySelector('.ant-spin-spinning');
                  return {
                    ready: hasEditButton && !isLoading,
                    hasEditButton,
                    editButtonCount: editIcons.length,
                    isLoading,
                    textLen: document.body.innerText.length
                  };
                });
                if (frameStatus.hasEditButton) {
                  return { ...frameStatus, frameIndex: i };
                }
              } catch (e) {
                // Frame not accessible
              }
            }

            return status;
          },
          { timeout: 120000, interval: 1000, description: 'PageLoad', log }
        );

        // Check if login required
        const pageContent = await page.evaluate(() => document.body.innerText);
        if (pageContent.includes('登录') || pageContent.includes('Login')) {
          throw new Error('Not logged in - please update cookies');
        }

        await addScreenshot(page, '1_direct_idl_config');

        // Verify lane is correct, select if needed
        await setStage('Verifying lane');
        log(`Verifying lane is set to: ${task.env}...`);

        // Check current lane and select correct one if needed
        const currentLane = await page.evaluate(() => {
          const laneSelects = document.querySelectorAll('.ant-select');
          for (const select of laneSelects) {
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

          // Click the lane dropdown
          const laneClicked = await page.evaluate((targetEnv) => {
            const selects = document.querySelectorAll('.ant-select-selector');
            for (const select of selects) {
              const text = select.textContent.toLowerCase();
              if (text.includes('lane') || text.includes('prod') || text.includes('boe')) {
                select.click();
                return true;
              }
            }
            // Click first select as fallback
            if (selects.length > 0) {
              selects[0].click();
              return true;
            }
            return false;
          }, task.env);

          if (laneClicked) {
            await new Promise(r => setTimeout(r, 500));

            // Select the correct lane option
            const laneSelected = await page.evaluate((targetEnv) => {
              const options = document.querySelectorAll('.ant-select-item, .ant-select-item-option');
              for (const option of options) {
                if (option.textContent.includes(targetEnv)) {
                  option.click();
                  return { selected: true, text: option.textContent.trim() };
                }
              }
              const available = Array.from(options).map(o => o.textContent.trim()).filter(t => t.length > 0).slice(0, 10);
              return { selected: false, available };
            }, task.env);

            if (laneSelected.selected) {
              log(`Selected lane: ${laneSelected.text}`);
              await new Promise(r => setTimeout(r, 2000));
            } else {
              log(`Lane not in dropdown, available: ${(laneSelected.available || []).join(', ')}`);
              // Close dropdown and try URL navigation
              await page.keyboard.press('Escape');
              await new Promise(r => setTimeout(r, 500));
            }
          }
        } else {
          log(`Lane appears correct`);
        }

        await addScreenshot(page, '2_lane_verified');

        // Wait for IDL config form to load
        await setStage('Loading IDL form');

        // Short initial wait
        await new Promise(r => setTimeout(r, 2000));

        // Check for iframes with logging
        const frames = page.frames();
        log(`Found ${frames.length} frames`);

        // Try to find content in main page or iframes
        let contentFrame = page;
        for (let fi = 0; fi < frames.length; fi++) {
          const frame = frames[fi];
          try {
            const frameContent = await frame.evaluate(() => document.body.innerText.substring(0, 100));
            log(`Frame[${fi}] content: ${frameContent.replace(/\s+/g, ' ').substring(0, 80)}`);
            if (frameContent.includes('lane') || frameContent.includes('branch') || frameContent.includes('IDL')) {
              contentFrame = frame;
              log(`Using frame[${fi}] as content frame`);
              break;
            }
          } catch (e) {
            log(`Frame[${fi}] not accessible: ${e.message.substring(0, 50)}`);
          }
        }

        // Wait for form elements with shorter timeout and polling
        log('Waiting for form elements...');
        try {
          await contentFrame.waitForSelector('.ant-select, .ant-btn, button, input', { timeout: 10000 });
          log('IDL config form loaded');
        } catch (e) {
          log(`Warning: waitForSelector timeout after 10s: ${e.message.substring(0, 50)}`);
        }

        await addScreenshot(page, '3_idl_form');

      } else {
        // Normal flow: Open Janus Mini list and search for PSM
        await setStage('Opening Janus Mini list');
        const janusUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance`;
        log(`Step 1: Opening ${janusUrl}`);

        await page.goto(janusUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        log('Waiting for page to stabilize...');
        await new Promise(r => setTimeout(r, 3000));

        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
        } catch (e) { /* ignore timeout */ }

        // Check if login required
        const pageContent = await page.evaluate(() => document.body.innerText);
        if (pageContent.includes('登录') || pageContent.includes('Login')) {
          throw new Error('Not logged in - please update cookies');
        }

        await addScreenshot(page, '1_list_view');

      // Step 2: Wait for list to load and find PSM
      await setStage('Finding PSM in list');
      log(`Step 2: Waiting for Janus Mini list to load...`);

      // First, try to use waitForSelector for the ant-table (more reliable)
      let tableFound = false;
      try {
        log('Waiting for .ant-table element (60s timeout)...');
        await page.waitForSelector('.ant-table', { timeout: 60000 });
        tableFound = true;
        log('Table element found via waitForSelector');
      } catch (waitErr) {
        log(`waitForSelector failed: ${waitErr.message}`);
        // Log what's on the page for debugging
        const debugInfo = await page.evaluate(() => {
          const text = document.body.innerText.substring(0, 800).replace(/\s+/g, ' ');
          const allClasses = Array.from(document.querySelectorAll('[class]'))
            .map(el => el.className)
            .filter(c => c.includes('table') || c.includes('ant-'))
            .slice(0, 10);
          return { text, allClasses };
        });
        log(`Page content: ${debugInfo.text.substring(0, 300)}...`);
        log(`Table-related classes found: ${debugInfo.allClasses.join(', ') || 'none'}`);
      }

      // Fallback: polling loop for table content
      let navRetries = 0;
      for (let i = 0; i < 60 && !tableFound; i++) {
        let pageStatus;
        try {
          pageStatus = await page.evaluate(() => {
            const pageText = document.body.innerText;

            // Check for loading spinner
            const spinner = document.querySelector('.ant-spin-spinning, .ant-spin-dot-spin');
            const isLoading = !!spinner;

            // Check for Ant Design table specifically
            const antTable = document.querySelector('.ant-table-bordered, .ant-table');
            const antTableRows = document.querySelectorAll('.ant-table-row');
            const hasTableRows = antTableRows.length > 0;

            // Check for "API grouping" column header (case insensitive)
            const hasAPIGrouping = pageText.toLowerCase().includes('api grouping');

            // Check for PSM content in table cells
            const hasPSMContent = pageText.includes('oec.') || pageText.includes('ttec.') ||
                                  pageText.includes('.strategy') || pageText.includes('.bot');

            // Check for Janus Mini header
            const hasJanusContent = pageText.includes('Janus Mini') || pageText.includes('BOE I18N');

            // Debug: get first few cell contents
            const cellTexts = Array.from(antTableRows).slice(0, 3).map(row => {
              const firstCell = row.querySelector('.ant-table-cell');
              return firstCell ? firstCell.textContent.trim().substring(0, 30) : '';
            });

            return {
              isLoading,
              hasTableRows,
              hasPSMContent,
              hasJanusContent,
              hasAPIGrouping,
              hasAntTable: !!antTable,
              rowCount: antTableRows.length,
              cellTexts,
              contentLength: pageText.length
            };
          });
        } catch (evalError) {
          if (evalError.message && evalError.message.includes('Execution context was destroyed')) {
            navRetries++;
            log(`Navigation during page check (attempt ${navRetries}), waiting for page to settle...`);
            await new Promise(r => setTimeout(r, 2000));

            try {
              await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
            } catch (e) { /* ignore */ }

            // Check if redirected to SSO/login page
            const currentUrl = page.url();
            const ssoPatterns = ['sso.bytedance.com', 'login', 'passport', 'auth', 'signin'];
            const isSSO = ssoPatterns.some(p => currentUrl.toLowerCase().includes(p));

            if (isSSO) {
              let needsLogin = false;
              let ssoDomain = '';
              try {
                const pageText = await page.evaluate(() => document.body.innerText);
                needsLogin = pageText.includes('登录') || pageText.includes('Login') || pageText.includes('Sign in');
                const urlObj = new URL(currentUrl);
                ssoDomain = urlObj.hostname;
              } catch (e) { /* ignore */ }

              if (needsLogin || isSSO) {
                log(`SSO redirect detected: ${currentUrl}`);
                const errorMsg = `Please refresh cookies for domain: ${ssoDomain || 'sso.bytedance.com'}`;
                task.status = 'error';
                task.error = errorMsg;
                task.endTime = new Date().toISOString();
                await saveTaskToDb(taskId, task);
                throw new Error(errorMsg);
              }
            }

            if (navRetries > 5) {
              log(`Too many navigation interrupts (${navRetries}), re-throwing to trigger task retry`);
              throw evalError;
            }
            log(`Internal navigation detected, retrying...`);
            continue;
          }
          throw evalError;
        }

        // Condition 1: API grouping header + PSM content
        if (pageStatus.hasAPIGrouping && pageStatus.hasPSMContent) {
          tableFound = true;
          log(`Table fully loaded after ${(i+1)*500}ms (rows=${pageStatus.rowCount})`);
          break;
        }

        // Condition 2: Ant table with rows + PSM content
        if (pageStatus.hasAntTable && pageStatus.hasTableRows && pageStatus.hasPSMContent) {
          tableFound = true;
          log(`Ant table found after ${(i+1)*500}ms (rows=${pageStatus.rowCount})`);
          break;
        }

        // Condition 3: Ant table with rows (fallback after 10s)
        if (i >= 20 && pageStatus.hasAntTable && pageStatus.rowCount > 0) {
          tableFound = true;
          log(`Ant table with ${pageStatus.rowCount} rows found after ${(i+1)*500}ms (fallback)`);
          break;
        }

        // Log every 5 seconds with more detail
        if (i % 10 === 0) {
          log(`Waiting for table... (${i * 500}ms) loading=${pageStatus.isLoading}, antTable=${pageStatus.hasAntTable}, rows=${pageStatus.rowCount}, APIGrouping=${pageStatus.hasAPIGrouping}, psm=${pageStatus.hasPSMContent}`);
          if (pageStatus.cellTexts && pageStatus.cellTexts.length > 0) {
            log(`  First cells: ${pageStatus.cellTexts.join(', ')}`);
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }

      if (!tableFound) {
        log('Warning: Table not detected after 30s, continuing anyway...');
        await addScreenshot(page, '2_table_not_found');
      }

      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 300));
      await addScreenshot(page, '2_list_loaded');

      // Step 3: Find and click PSM
      log(`Looking for PSM: ${task.psm} in the list...`);

      const pageDebug = await page.evaluate(() => {
        const pageText = document.body.innerText;
        const links = Array.from(document.querySelectorAll('a')).map(a => a.textContent.trim()).filter(t => t.length > 0 && t.length < 50).slice(0, 20);
        const tables = document.querySelectorAll('table, .ant-table, [class*="table"]');
        const rows = document.querySelectorAll('tr, .ant-table-row, [class*="row"]');
        return {
          hasOEC: pageText.includes('oec.'),
          textPreview: pageText.substring(0, 500).replace(/\s+/g, ' '),
          linksPreview: links,
          tableCount: tables.length,
          rowCount: rows.length
        };
      });
      log(`Page debug: hasOEC=${pageDebug.hasOEC}, tables=${pageDebug.tableCount}, rows=${pageDebug.rowCount}`);

      // Find PSM link - try multiple strategies
      const psmFound = await page.evaluate((targetPsm) => {
        // Strategy 1: Look for <a> tags containing PSM
        const links = Array.from(document.querySelectorAll('a'));
        const psmLink = links.find(a => a.textContent.includes(targetPsm));
        if (psmLink) {
          psmLink.click();
          return { found: true, method: 'link' };
        }

        // Strategy 2: Look in table rows and click the row or first link in row
        const rows = Array.from(document.querySelectorAll('tr, .ant-table-row'));
        for (const row of rows) {
          if (row.textContent.includes(targetPsm)) {
            // Try to click a link inside the row first
            const link = row.querySelector('a');
            if (link) {
              link.click();
              return { found: true, method: 'row-link' };
            }
            // Otherwise click the row itself
            row.click();
            return { found: true, method: 'row-click' };
          }
        }

        // Strategy 3: Look for any clickable element containing PSM
        const clickables = Array.from(document.querySelectorAll('a, button, [onclick], [role="button"], td'));
        const psmElement = clickables.find(el => el.textContent.trim() === targetPsm || el.textContent.includes(targetPsm));
        if (psmElement) {
          psmElement.click();
          return { found: true, method: 'clickable' };
        }

        return { found: false };
      }, task.psm);

      if (!psmFound.found) {
        // Log more debug info
        const debugInfo = await page.evaluate((targetPsm) => {
          const allText = document.body.innerText;
          const psmIndex = allText.indexOf(targetPsm);
          return {
            psmInText: psmIndex >= 0,
            contextAround: psmIndex >= 0 ? allText.substring(Math.max(0, psmIndex - 50), psmIndex + targetPsm.length + 50) : null
          };
        }, task.psm);
        log(`Debug: PSM in page text: ${debugInfo.psmInText}, context: ${debugInfo.contextAround}`);
        throw new Error(`PSM "${task.psm}" not found in the list`);
      }

      log(`Found PSM via ${psmFound.method}`)

      log(`Found and clicked PSM: ${task.psm}`);
      await new Promise(r => setTimeout(r, 2000));
      await addScreenshot(page, '3_psm_clicked');

      // Step 4: Navigate to IDL tab
      await setStage('Opening IDL configuration');
      log('Step 4: Looking for IDL tab...');

      // Log available tabs for debugging
      const availableTabs = await page.evaluate(() => {
        const tabs = document.querySelectorAll('.ant-tabs-tab, [role="tab"]');
        return Array.from(tabs).map(t => t.textContent.trim()).filter(t => t.length > 0 && t.length < 50);
      });
      log(`Available tabs: ${availableTabs.join(', ')}`);

      // Try multiple tab names (English and Chinese)
      const tabNames = ['Idl management', 'Idl', 'IDL', 'IdlConfig', 'IDL配置', 'IDL Config', 'IDL管理'];
      let tabClicked = false;
      for (const tabName of tabNames) {
        try {
          await clickByText(page, '.ant-tabs-tab, [role="tab"], button', tabName, 'IDL tab', 3000);
          tabClicked = true;
          log(`Clicked tab: ${tabName}`);
          break;
        } catch (e) {
          // Try next name
        }
      }

      if (!tabClicked) {
        // Try clicking by URL pattern - navigate directly with correct lane
        const currentUrl = page.url();
        if (currentUrl.includes('/tab/')) {
          let idlUrl = currentUrl.replace(/\/tab\/[^?]+/, '/tab/IdlConfig');
          // Also set the correct lane parameter
          idlUrl = idlUrl.replace(/lane=[^&]+/, `lane=${task.env}`);
          if (!idlUrl.includes('lane=')) {
            idlUrl += (idlUrl.includes('?') ? '&' : '?') + `lane=${task.env}`;
          }
          log(`Navigating directly to IDL tab: ${idlUrl}`);
          await page.goto(idlUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw new Error(`Could not find IDL tab. Available tabs: ${availableTabs.join(', ')}`);
        }
      }

      await new Promise(r => setTimeout(r, 1500));
      await addScreenshot(page, '4_idl_tab');

      // Step 5: Select lane from dropdown
      await setStage('Selecting lane');
      log(`Step 5: Looking for lane dropdown to select: ${task.env}...`);

      // Look for "Current lane" dropdown and click it
      const laneDropdownClicked = await page.evaluate(() => {
        // Find dropdown that contains "Current lane" or similar
        const dropdowns = document.querySelectorAll('.ant-select, .ant-select-selector, [class*="select"], [class*="dropdown"]');
        for (const dropdown of dropdowns) {
          const parent = dropdown.closest('.ant-select') || dropdown;
          const label = parent.previousElementSibling || parent.parentElement;
          if (label && (label.textContent.includes('lane') || label.textContent.includes('Lane') || label.textContent.includes('泳道'))) {
            dropdown.click();
            return { clicked: true, label: label.textContent.trim() };
          }
        }
        // Try clicking any select that might be the lane selector
        const selects = document.querySelectorAll('.ant-select-selector');
        if (selects.length > 0) {
          selects[0].click();
          return { clicked: true, label: 'first-select' };
        }
        return { clicked: false };
      });

      if (laneDropdownClicked.clicked) {
        log(`Clicked lane dropdown: ${laneDropdownClicked.label}`);
        await new Promise(r => setTimeout(r, 500));

        // Now select the target lane from dropdown options
        const laneSelected = await page.evaluate((targetEnv) => {
          const options = document.querySelectorAll('.ant-select-item, .ant-select-dropdown-menu-item, [class*="option"]');
          for (const option of options) {
            if (option.textContent.includes(targetEnv)) {
              option.click();
              return { selected: true, text: option.textContent.trim() };
            }
          }
          // Return available options for debugging
          const availableOpts = Array.from(options).map(o => o.textContent.trim()).filter(t => t.length > 0).slice(0, 20);
          return { selected: false, available: availableOpts };
        }, task.env);

        if (laneSelected.selected) {
          log(`Selected lane: ${laneSelected.text}`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          log(`Lane not found in dropdown. Available options: ${(laneSelected.available || []).join(', ')}`);
          // Close dropdown first
          await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 500));
          // Try URL navigation as fallback
          const currentUrl = page.url();
          if (currentUrl.includes('lane=')) {
            const correctUrl = currentUrl.replace(/lane=[^&]+/, `lane=${task.env}`);
            log(`Fallback: Navigating to correct lane URL: ${correctUrl}`);
            await page.goto(correctUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      } else {
        log('Lane dropdown not found, trying URL navigation...');
        const currentUrl = page.url();
        if (currentUrl.includes('lane=') && !currentUrl.includes(`lane=${task.env}`)) {
          const correctUrl = currentUrl.replace(/lane=[^&]+/, `lane=${task.env}`);
          log(`Navigating to correct lane URL: ${correctUrl}`);
          await page.goto(correctUrl, { waitUntil: 'networkidle2', timeout: 60000 });
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      await addScreenshot(page, '5_lane_selected');

      // Wait for page content to load
      log('Waiting for IDL config content to load...');
      try {
        await page.waitForSelector('input, .ant-input, .ant-select, .ant-form, table, .ant-table', { timeout: 15000 });
        log('IDL config content loaded');
      } catch (e) {
        log('Warning: IDL config content may not be fully loaded');
      }
      await new Promise(r => setTimeout(r, 2000));

      // At this point we should be on the IDL config page with the correct lane
      // Both paths (with/without api_group_id) converge here - we're on the IDL config page
      // and can proceed directly to updating the branch
      log('Ready to update IDL branch...');
      await addScreenshot(page, '6_ready_for_branch');

      } // End of normal flow (else block)

      // Step 6: Update IDL branch (both paths converge here)
      // Content already verified by first check, no need for redundant second check
      await setStage('Updating IDL branch');
      log(`Step 6: Setting IDL branch to: ${task.idl_branch}...`);

      let targetFrame = page;

      // Scroll to ensure content is visible
      await targetFrame.evaluate(() => {
        window.scrollTo(0, 0);
        const containers = document.querySelectorAll('[style*="overflow"], .ant-layout-content, .ant-tabs-content');
        containers.forEach(c => c.scrollTop = 0);
      });
      await new Promise(r => setTimeout(r, 1000));

      // Debug: log what's on the page/frame
      const pageElements = await targetFrame.evaluate(() => {
        const selects = document.querySelectorAll('.ant-select');
        const buttons = document.querySelectorAll('button, .ant-btn');
        const allText = document.body.innerText;
        return {
          selectCount: selects.length,
          selectTexts: Array.from(selects).map(s => s.textContent.trim().substring(0, 50)).slice(0, 10),
          buttonTexts: Array.from(buttons).map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 50).slice(0, 10),
          pageText: allText.substring(0, 500),
          url: window.location.href,
          hasCurrentLane: allText.includes('Current lane'),
          hasIdlBranch: allText.toLowerCase().includes('branch') || allText.toLowerCase().includes('idl')
        };
      });
      log(`URL: ${pageElements.url}`);
      log(`Page elements: selects=${pageElements.selectCount}, hasCurrentLane=${pageElements.hasCurrentLane}, hasIdlBranch=${pageElements.hasIdlBranch}`);
      log(`Select texts: [${pageElements.selectTexts.join(', ')}]`);
      log(`Buttons: [${pageElements.buttonTexts.join(', ')}]`);
      log(`Page text preview: ${pageElements.pageText.replace(/\s+/g, ' ').substring(0, 200)}`);

      // STEP 6a: Skip lane selection - URL already has correct lane parameter (lane=${task.env})
      // The page should load with the correct lane from the URL
      log(`Lane should be set via URL parameter: ${task.env}`);

      // Verify lane is correct by checking the displayed value
      const laneInfo = await targetFrame.evaluate(() => {
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
          const text = div.textContent;
          if (text && text.includes('Current lane')) {
            const currentValue = div.querySelector('.ant-select-selection-item');
            if (currentValue) {
              return { found: true, currentLane: currentValue.textContent.trim() };
            }
          }
        }
        return { found: false };
      });

      if (laneInfo.found) {
        log(`Current lane displayed: ${laneInfo.currentLane}`);
        if (!laneInfo.currentLane.includes(task.env)) {
          log(`WARNING: Lane mismatch - expected ${task.env}, got ${laneInfo.currentLane}. URL should have set it correctly.`);
        }
      }

      // STEP 6b: Click the small edit icon (pencil icon) to edit the IDL branch
      // This is NOT the "Edit meta information" button - it's a small pencil icon with anticon-edit class
      await setStage('Setting branch');
      log(`Looking for edit icon to set branch: ${task.idl_branch}`);

      // First, capture the current IDL version before making changes
      const currentVersionInfo = await targetFrame.evaluate(() => {
        const pageText = document.body.innerText;
        // Look for "Current idl:" followed by version info
        const currentIdlMatch = pageText.match(/Current idl[:\s]*([^\n]+)/i);
        // Also look for version pattern like "1.0.768"
        const versionMatch = pageText.match(/(\d+\.\d+\.\d+)/);
        return {
          currentIdl: currentIdlMatch ? currentIdlMatch[1].trim() : null,
          version: versionMatch ? versionMatch[1] : null,
          pagePreview: pageText.substring(0, 300).replace(/\s+/g, ' ')
        };
      });
      log(`Current version info: idl="${currentVersionInfo.currentIdl}", version="${currentVersionInfo.version}"`);

      // Click the Edit button (pencil icon) - check main page and iframes
      let editIconClicked = { clicked: false };

      // Helper function to try clicking Edit button in a frame
      const tryClickEditInFrame = async (frame) => {
        return await frame.evaluate(() => {
          const editIcons = document.querySelectorAll('.anticon-edit, [aria-label="edit"], span[class*="anticon-edit"]');
          for (const icon of editIcons) {
            const button = icon.closest('button') || icon.closest('[role="button"]') || icon;
            if (button) {
              button.click();
              return { clicked: true, type: 'edit-icon' };
            }
          }

          // Fallback: look for button with edit icon inside
          const buttons = document.querySelectorAll('button.ant-btn-icon-only, button.ant-btn-text');
          for (const btn of buttons) {
            const hasEditIcon = btn.querySelector('.anticon-edit, [aria-label="edit"]');
            if (hasEditIcon) {
              btn.click();
              return { clicked: true, type: 'button-with-edit-icon' };
            }
          }

          return { clicked: false };
        });
      };

      // Try main page first
      editIconClicked = await tryClickEditInFrame(targetFrame);

      // If not found, try all iframes
      if (!editIconClicked.clicked) {
        const frames = page.frames();
        for (let i = 0; i < frames.length; i++) {
          try {
            const result = await tryClickEditInFrame(frames[i]);
            if (result.clicked) {
              editIconClicked = { ...result, frameIndex: i };
              targetFrame = frames[i]; // Update targetFrame to the frame where Edit was found
              log(`Found Edit button in frame ${i}`);
              break;
            }
          } catch (e) {
            // Frame not accessible
          }
        }
      }

      log(`Edit icon click result: ${JSON.stringify(editIconClicked)}`);

      if (editIconClicked.clicked) {
        log(`Clicked edit icon (${editIconClicked.type})`);
        await new Promise(r => setTimeout(r, 2000)); // Wait for edit mode/modal to open
        await addScreenshot(page, '6a_edit_icon_clicked');
      } else {
        await addScreenshot(page, '6a_edit_button_not_found');
        throw new Error('Edit button not found. The IDL config section may not have loaded properly.');
      }

      // Log form elements for debugging
      const formElements = await targetFrame.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        const selects = document.querySelectorAll('.ant-select');
        const labels = document.querySelectorAll('label, .ant-form-item-label');

        return {
          inputs: Array.from(inputs).map(i => ({
            type: i.type,
            placeholder: i.placeholder,
            id: i.id,
            name: i.name,
            value: i.value.substring(0, 30)
          })).filter(i => i.type !== 'hidden').slice(0, 10),
          selects: Array.from(selects).map(s => s.textContent.trim().substring(0, 50)).slice(0, 10),
          labels: Array.from(labels).map(l => l.textContent.trim()).filter(t => t.length > 0 && t.length < 50).slice(0, 10)
        };
      });
      log(`Form elements - Inputs: ${JSON.stringify(formElements.inputs)}`);
      log(`Form elements - Selects: [${formElements.selects.join(', ')}]`);
      log(`Form elements - Labels: [${formElements.labels.join(', ')}]`);

      let branchUpdated = false;
      let selectedVersion = null; // Track the version we selected

      // After clicking edit icon, look for the branch dropdown or input
      // The dropdown should now show branch options

      // Strategy 1: Look for a select/dropdown that appeared after clicking edit icon
      if (!branchUpdated) {
        const branchSelectClicked = await targetFrame.evaluate((targetBranch) => {
          // Look for any open dropdown or newly visible select
          const dropdowns = document.querySelectorAll('.ant-select-dropdown, .ant-select-open');
          if (dropdowns.length > 0) {
            // Dropdown is open, type in search
            return { hasDropdown: true };
          }

          // Look for select elements that might be for branch
          const selects = document.querySelectorAll('.ant-select');
          for (const select of selects) {
            const selectText = select.textContent.trim().toLowerCase();
            const parent = select.closest('div');
            const parentText = parent ? parent.textContent.toLowerCase() : '';

            // Skip lane selector
            if (parentText.includes('current lane')) continue;

            // Click select that might be branch related or the version select
            if (selectText.includes('branch') || selectText.match(/^\d+\.\d+\.\d+/) || parentText.includes('version')) {
              const selector = select.querySelector('.ant-select-selector');
              if (selector) {
                selector.click();
                return { clicked: true, selectText: select.textContent.trim().substring(0, 50) };
              }
            }
          }

          return { clicked: false };
        }, task.idl_branch);

        if (branchSelectClicked.clicked || branchSelectClicked.hasDropdown) {
          log(`Branch select result: ${JSON.stringify(branchSelectClicked)}`);
          await new Promise(r => setTimeout(r, 500));

          // Type the branch name to search/filter
          await page.keyboard.type(task.idl_branch);
          log(`Typed branch name: ${task.idl_branch}`);
          await new Promise(r => setTimeout(r, 1000));

          // Try to select the option or press Enter
          // If idl_version is specified, find that exact version; otherwise find max version
          const targetVersion = task.idl_version || null;
          const optionSelected = await targetFrame.evaluate((targetBranch, targetVersion) => {
            const options = document.querySelectorAll('.ant-select-item, .ant-select-item-option');
            let matchingOptions = [];

            // Collect all options matching the branch
            for (const option of options) {
              if (option.textContent.includes(targetBranch)) {
                const optionText = option.textContent.trim();
                const versionMatch = optionText.match(/(\d+\.\d+\.\d+)/);
                matchingOptions.push({
                  element: option,
                  text: optionText,
                  version: versionMatch ? versionMatch[1] : null
                });
              }
            }

            if (matchingOptions.length === 0) {
              const available = Array.from(options).map(o => o.textContent.trim()).filter(t => t.length > 0).slice(0, 10);
              return { selected: false, available };
            }

            // If target version specified, find exact match
            if (targetVersion) {
              const exactMatch = matchingOptions.find(o => o.version === targetVersion);
              if (exactMatch) {
                exactMatch.element.click();
                return { selected: true, text: exactMatch.text, version: exactMatch.version };
              }
              // Version not found
              return { selected: false, requestedVersion: targetVersion, availableVersions: matchingOptions.map(o => o.version) };
            }

            // No target version - use max version (sort descending and take first)
            matchingOptions.sort((a, b) => {
              if (!a.version || !b.version) return 0;
              const aParts = a.version.split('.').map(Number);
              const bParts = b.version.split('.').map(Number);
              for (let i = 0; i < 3; i++) {
                if (aParts[i] !== bParts[i]) return bParts[i] - aParts[i];
              }
              return 0;
            });

            const selected = matchingOptions[0];
            selected.element.click();
            return { selected: true, text: selected.text, version: selected.version };
          }, task.idl_branch, targetVersion);

          if (optionSelected.selected) {
            log(`Selected branch option: ${optionSelected.text}`);
            selectedVersion = optionSelected.version;
            log(`Selected version: ${selectedVersion}, Current version: ${currentVersionInfo.version}`);
            branchUpdated = true;
          } else if (optionSelected.requestedVersion) {
            // Specific version was requested but not found
            throw new Error(`Version ${optionSelected.requestedVersion} not found for branch ${task.idl_branch}. Available: ${(optionSelected.availableVersions || []).join(', ')}`);
          } else {
            log(`Branch not found in options. Available: ${(optionSelected.available || []).join(', ')}`);
            await page.keyboard.press('Enter');
            log('Pressed Enter to confirm branch');
            branchUpdated = true;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // Strategy 2: Look for input with branch-related placeholder or id
      if (!branchUpdated) {
        const branchInput = await targetFrame.$('input[placeholder*="branch" i], input[id*="branch" i], input[name*="branch" i]');
        if (branchInput) {
          await branchInput.click({ clickCount: 3 });
          await branchInput.type(task.idl_branch);
          log(`Updated branch via input field: ${task.idl_branch}`);
          branchUpdated = true;
        }
      }

      if (!branchUpdated) {
        // This shouldn't happen since we throw error if Edit button not found
        // But if branch selection failed after clicking Edit, throw an error
        await addScreenshot(page, '6b_branch_not_selected');
        throw new Error('Could not select branch/version from the dropdown after clicking Edit button.');
      }

      // Check if version actually changed
      const versionChanged = selectedVersion && currentVersionInfo.version && selectedVersion !== currentVersionInfo.version;

      if (!versionChanged) {
        log(`Version not changed. Selected: ${selectedVersion}, Current: ${currentVersionInfo.version}`);
        // Version is already at the selected version, which is fine - continue to deployment
        log('Version already up to date, continuing to deployment...');
      }

      // Only check for confirmation popup if version changed
      if (versionChanged) {
        log('Version changed, checking for confirmation popup...');
        await new Promise(r => setTimeout(r, 1500));

        // Take screenshot to see what's on screen
        await addScreenshot(page, '6a_before_confirm');

        // Helper function to find and click confirmation button
        const findAndClickConfirm = async (context, contextName) => {
          return await context.evaluate(() => {
            // First, log what modals/popups are visible
            const modals = document.querySelectorAll('.ant-modal, .ant-popover, .ant-popconfirm, [class*="modal"], [class*="popover"]');
            const modalInfo = Array.from(modals).map(m => ({
              class: m.className,
              visible: m.offsetParent !== null || window.getComputedStyle(m).display !== 'none',
              text: m.textContent.substring(0, 200)
            })).filter(m => m.visible);

            // Check if there's an "ongoing work order" warning
            const pageText = document.body.textContent.toLowerCase();
            const hasWorkorderWarning = pageText.includes('ongoing') || pageText.includes('work order') ||
                                        pageText.includes('workorder') || pageText.includes('正在进行');

            // Look for confirmation modal/popup buttons - prioritize primary/danger buttons for warnings
            const confirmButtons = document.querySelectorAll('.ant-modal-confirm-btns button, .ant-modal-footer button, .ant-btn-primary, .ant-btn-danger, .ant-popconfirm button, .ant-popover button, .ant-popconfirm-buttons button');
            const allButtonsInfo = Array.from(confirmButtons).map(btn => ({
              text: btn.textContent.trim(),
              disabled: btn.disabled,
              visible: btn.offsetParent !== null,
              className: btn.className
            }));

            // For ongoing workorder warning, look for confirm/continue/proceed buttons
            const confirmKeywords = ['ok', 'confirm', '确定', '确认', 'yes', 'continue', 'proceed', '继续'];

            for (const btn of confirmButtons) {
              const text = btn.textContent.toLowerCase().trim();
              const isVisible = btn.offsetParent !== null;
              const isDisabled = btn.disabled;
              const matchesKeyword = confirmKeywords.some(kw => text.includes(kw));

              if (matchesKeyword && isVisible && !isDisabled) {
                btn.click();
                return { clicked: true, text: btn.textContent.trim(), source: 'confirmButtons', hasWorkorderWarning, allButtons: allButtonsInfo, modals: modalInfo };
              }
            }

            // Also check for any popup close/accept buttons
            const popupButtons = document.querySelectorAll('[class*="modal"] button, [class*="popup"] button, [class*="dialog"] button, [class*="popconfirm"] button, [class*="popover"] button');
            for (const btn of popupButtons) {
              const text = btn.textContent.toLowerCase().trim();
              const isVisible = btn.offsetParent !== null;
              const isDisabled = btn.disabled;
              const matchesKeyword = confirmKeywords.some(kw => text.includes(kw));

              if (matchesKeyword && isVisible && !isDisabled) {
                btn.click();
                return { clicked: true, text: btn.textContent.trim(), source: 'popupButtons', hasWorkorderWarning, allButtons: allButtonsInfo, modals: modalInfo };
              }
            }

            return { clicked: false, hasWorkorderWarning, allButtons: allButtonsInfo, modals: modalInfo };
          });
        };

        // Check for ongoing workorder warning first - this requires user intervention
        const checkForWorkorderWarning = async (context) => {
          return await context.evaluate(() => {
            const pageText = document.body.textContent.toLowerCase();
            const hasOngoingWorkorder = pageText.includes('ongoing') ||
                                        pageText.includes('work order') ||
                                        pageText.includes('workorder') ||
                                        pageText.includes('正在进行') ||
                                        pageText.includes('未完成');

            // Get modal/popup text for error message
            const modals = document.querySelectorAll('.ant-modal, .ant-popover, .ant-popconfirm, [class*="modal"], [class*="popover"]');
            const modalText = Array.from(modals)
              .filter(m => m.offsetParent !== null || window.getComputedStyle(m).display !== 'none')
              .map(m => m.textContent.trim())
              .join(' ');

            return { hasOngoingWorkorder, modalText: modalText.substring(0, 500) };
          });
        };

        // Check main page and iframe for workorder warning
        let workorderCheck = await checkForWorkorderWarning(page);
        if (!workorderCheck.hasOngoingWorkorder) {
          workorderCheck = await checkForWorkorderWarning(targetFrame);
        }

        if (workorderCheck.hasOngoingWorkorder) {
          log(`ERROR: Ongoing workorder detected - requires user intervention`);
          log(`Modal text: ${workorderCheck.modalText}`);
          await addScreenshot(page, '6_ongoing_workorder_error');
          throw new Error(`Cannot change IDL version: there is an ongoing workorder that requires user intervention. Please complete or cancel the existing workorder first.`);
        }

        // Handle normal confirmation dialogs
        let totalConfirmsClicked = 0;
        for (let confirmAttempt = 0; confirmAttempt < 5; confirmAttempt++) {
          // First check main page for confirmation dialog (modals often render at page level)
          let confirmHandled = await findAndClickConfirm(page, 'main page');
          log(`Main page confirm check: ${JSON.stringify(confirmHandled)}`);

          if (confirmHandled.clicked) {
            totalConfirmsClicked++;
            log(`Clicked confirmation button #${totalConfirmsClicked} in main page: ${confirmHandled.text}`);
            await addScreenshot(page, `6b_after_confirm_${totalConfirmsClicked}`);
            await new Promise(r => setTimeout(r, 1500)); // Wait for next popup to appear

            // Re-check for workorder warning after clicking confirm (it might appear as second popup)
            workorderCheck = await checkForWorkorderWarning(page);
            if (!workorderCheck.hasOngoingWorkorder) {
              workorderCheck = await checkForWorkorderWarning(targetFrame);
            }
            if (workorderCheck.hasOngoingWorkorder) {
              log(`ERROR: Ongoing workorder warning appeared after confirmation`);
              await addScreenshot(page, '6_ongoing_workorder_error');
              throw new Error(`Cannot change IDL version: there is an ongoing workorder that requires user intervention. Please complete or cancel the existing workorder first.`);
            }

            continue; // Check for more confirmations
          }

          // Then check iframe
          confirmHandled = await findAndClickConfirm(targetFrame, 'iframe');
          log(`Iframe confirm check: ${JSON.stringify(confirmHandled)}`);

          if (confirmHandled.clicked) {
            totalConfirmsClicked++;
            log(`Clicked confirmation button #${totalConfirmsClicked} in iframe: ${confirmHandled.text}`);
            await addScreenshot(page, `6b_after_confirm_${totalConfirmsClicked}`);
            await new Promise(r => setTimeout(r, 1500)); // Wait for next popup to appear

            // Re-check for workorder warning
            workorderCheck = await checkForWorkorderWarning(page);
            if (!workorderCheck.hasOngoingWorkorder) {
              workorderCheck = await checkForWorkorderWarning(targetFrame);
            }
            if (workorderCheck.hasOngoingWorkorder) {
              log(`ERROR: Ongoing workorder warning appeared after confirmation`);
              await addScreenshot(page, '6_ongoing_workorder_error');
              throw new Error(`Cannot change IDL version: there is an ongoing workorder that requires user intervention. Please complete or cancel the existing workorder first.`);
            }

            continue; // Check for more confirmations
          }

          // No more confirmations found
          if (totalConfirmsClicked > 0) {
            log(`All ${totalConfirmsClicked} confirmation(s) handled`);
            break;
          }

          log(`Confirmation attempt ${confirmAttempt + 1}: no confirm button found yet`);
          await new Promise(r => setTimeout(r, 500));
        }
      } else {
        log(`Version unchanged (${currentVersionInfo.version} == ${selectedVersion}), skipping confirmation check`);
      }

      if (versionChanged) {
        log(`Version changed: ${currentVersionInfo.version} -> ${selectedVersion}, waiting for notification...`);

        // Wait for "Setup successful" notification
        const setupResult = await pollForCondition(
          async () => {
            const status = await targetFrame.evaluate(() => {
              const notifications = document.querySelectorAll('.ant-notification, .ant-message, [class*="notification"], [class*="message"]');
              const notificationText = Array.from(notifications).map(n => n.textContent).join(' ');
              const hasSetupSuccess = notificationText.includes('Setup successful') ||
                                      notificationText.includes('successful') ||
                                      notificationText.includes('设置成功') ||
                                      notificationText.includes('成功');
              return {
                ready: hasSetupSuccess,
                hasSetupSuccess,
                notificationCount: notifications.length
              };
            });
            return status;
          },
          { timeout: 10000, interval: 500, description: 'SetupNotification', log }
        );

        if (setupResult.ready) {
          log('Setup successful notification detected - refreshing page');
        } else {
          log('Notification not seen, refreshing page anyway...');
        }

        await addScreenshot(page, '6_branch_updated');

        // Navigate to the correct URL with lane parameter
        log('Navigating to page with correct lane parameter...');
        const refreshUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${task.api_group_id}/tab/IdlConfig?lane=${task.env}&x-resource-account=boe&x-bc-region-id=bytedance`;
        log(`URL: ${refreshUrl}`);
        await page.goto(refreshUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        browserPool.recordUrl(refreshUrl, taskId);

        // Wait for page content to be ready using pollForCondition
        log('Waiting for page content after navigation...');
        await pollForCondition(
          async () => {
            const status = await page.evaluate((targetEnv) => {
              const pageText = document.body.innerText;
              const selects = document.querySelectorAll('.ant-select');
              const hasLaneSelector = pageText.includes('Current lane') || selects.length > 0;
              const hasDeployBtn = pageText.includes('Deployment') || pageText.includes('部署');
              const isLoading = !!document.querySelector('.ant-spin-spinning');
              return {
                ready: hasLaneSelector && hasDeployBtn && !isLoading,
                hasLaneSelector,
                hasDeployBtn,
                selectCount: selects.length,
                isLoading
              };
            }, task.env);
            return status;
          },
          { timeout: 30000, interval: 1000, description: 'AfterNavigation', log }
        );

        await addScreenshot(page, '6c_after_navigation');
      } else {
        log(`Version unchanged (${currentVersionInfo.version} == ${selectedVersion}), skipping notification wait and refresh`);
      }

      // Click "Deployment" button - wrap in try-catch since browser may have crashed
      log('Looking for Deployment button...');

      // Check if browser is still connected before proceeding
      let browserConnected = true;
      try {
        await page.evaluate(() => true);
      } catch (e) {
        browserConnected = false;
        log(`Browser disconnected before Deployment step: ${e.message.substring(0, 50)}`);
      }

      if (!browserConnected) {
        // Branch was already set, mark as partial success
        log('Branch was set successfully, but browser crashed before Deployment. Completing task.');
        task.status = 'completed';
        task.result = 'IDL branch updated (deployment step skipped due to browser crash)';
        task.end_time = new Date();
        await saveTaskToDb(taskId, task);
        return;
      }

      // Find and click Deployment button using Puppeteer's click for better reliability
      let deploymentClicked = { clicked: false };

      // First, find the button
      const deploymentBtnInfo = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, .ant-btn, [role="button"]');
        for (let i = 0; i < buttons.length; i++) {
          const btn = buttons[i];
          const text = (btn.textContent || '').trim();
          if (text.includes('Deployment') || text.includes('部署')) {
            const rect = btn.getBoundingClientRect();
            return { found: true, text, index: i, x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
          }
        }
        return { found: false };
      });

      if (deploymentBtnInfo.found) {
        log(`Found Deployment button at (${deploymentBtnInfo.x}, ${deploymentBtnInfo.y}): ${deploymentBtnInfo.text}`);

        // Use Puppeteer's click at coordinates for more reliable click
        await page.mouse.click(deploymentBtnInfo.x, deploymentBtnInfo.y);
        await new Promise(r => setTimeout(r, 500));

        // Also try JavaScript click as backup
        await page.evaluate((idx) => {
          const buttons = document.querySelectorAll('button, .ant-btn, [role="button"]');
          if (buttons[idx]) {
            buttons[idx].click();
            // Also dispatch events for React
            buttons[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        }, deploymentBtnInfo.index);

        deploymentClicked = { clicked: true, text: deploymentBtnInfo.text };

        // Wait for view to change after Deployment click
        log('Waiting for Deployment view to load...');
        await new Promise(r => setTimeout(r, 2000));

        // Check if there's an error about existing workorder
        const existingWorkorder = await page.evaluate(() => {
          const pageText = document.body.innerText;
          // Check for pending workorder error message
          if (pageText.includes('存在未完成的工单') ||
              pageText.includes('incomplete workorder') ||
              pageText.includes('pending workorder')) {
            // Look for workorder link
            const link = document.querySelector('a[href*="workorder"], a[href*="release_history"]');
            return {
              hasPendingWorkorder: true,
              message: '存在未完成的工单',
              workorderLink: link ? link.href : null
            };
          }
          return { hasPendingWorkorder: false };
        });

        if (existingWorkorder.hasPendingWorkorder) {
          log(`Existing workorder detected: ${existingWorkorder.message}`);
          await addScreenshot(page, '6e_existing_workorder');
          task.status = 'completed';
          task.result = 'Existing workorder pending - please complete the existing workorder first';
          task.end_time = new Date();
          await saveTaskToDb(taskId, task);

          // Cleanup
          if (browser) {
            try {
              const pages = await browser.pages();
              for (const p of pages) {
                if (p.url() !== 'about:blank') await p.close().catch(() => {});
              }
            } catch (e) { /* ignore */ }
            browserPool.release(log);
            runningBrowsers.delete(taskId);
          }
          return;
        }
      } else {
        deploymentClicked = { clicked: false };
      }

      if (deploymentClicked.clicked) {
        log(`Clicked Deployment button: ${deploymentClicked.text}`);
        await addScreenshot(page, '6e_deployment_clicked');

        // Wait for configuration comparison to load and Release button to be ready
        // Release button might be in main page, modal, or iframe
        log('Waiting for Release button to be ready...');
        const releaseReady = await pollForCondition(
          async () => {
            // Search in main page first
            let status = await page.evaluate(() => {
              const buttons = document.querySelectorAll('button, .ant-btn, [role="button"]');
              let releaseBtn = null;
              let hasLoading = false;
              const allButtons = [];

              for (const btn of buttons) {
                const text = (btn.textContent || '').toLowerCase().trim();
                allButtons.push(text.substring(0, 20));
                // Look for Release button with various patterns
                if (text.includes('release') || text.includes('发布') ||
                    text === 'submit' || text === '提交' ||
                    (text.includes('confirm') && !text.includes('cancel'))) {
                  releaseBtn = btn;
                  hasLoading = btn.classList.contains('ant-btn-loading') ||
                               !!btn.querySelector('.ant-btn-loading-icon') ||
                               !!btn.querySelector('.anticon-loading');
                  break;
                }
              }

              // Also check for modal with Release button
              const modal = document.querySelector('.ant-modal, .arco-modal, [class*="modal"]');
              if (modal && !releaseBtn) {
                const modalBtns = modal.querySelectorAll('button, .ant-btn');
                for (const btn of modalBtns) {
                  const text = (btn.textContent || '').toLowerCase().trim();
                  if (text.includes('release') || text.includes('发布') ||
                      text === 'ok' || text === '确定' || text === 'confirm') {
                    releaseBtn = btn;
                    hasLoading = btn.classList.contains('ant-btn-loading');
                    break;
                  }
                }
              }

              return {
                ready: releaseBtn && !hasLoading,
                hasReleaseBtn: !!releaseBtn,
                hasLoading,
                buttonText: releaseBtn ? releaseBtn.textContent.trim() : null,
                hasModal: !!modal,
                allButtons: allButtons.filter(b => b.length > 0).slice(0, 15)
              };
            });

            // If not found, search in iframes
            if (!status.hasReleaseBtn) {
              const frames = page.frames();
              for (const frame of frames) {
                if (frame === page.mainFrame()) continue;
                try {
                  const frameStatus = await frame.evaluate(() => {
                    const buttons = document.querySelectorAll('button, .ant-btn');
                    for (const btn of buttons) {
                      const text = (btn.textContent || '').toLowerCase().trim();
                      if (text.includes('release') || text.includes('发布') ||
                          text === 'submit' || text === '提交') {
                        return { hasReleaseBtn: true, inFrame: true, buttonText: btn.textContent.trim() };
                      }
                    }
                    return { hasReleaseBtn: false };
                  });
                  if (frameStatus.hasReleaseBtn) {
                    status = { ...status, ...frameStatus, ready: true };
                    break;
                  }
                } catch (e) { /* frame might not be accessible */ }
              }
            }

            return status;
          },
          { timeout: 30000, interval: 1000, description: 'ReleaseButtonReady', log }
        );

        await addScreenshot(page, '6f_config_comparison');

        if (releaseReady.ready) {
          log(`Release button ready (inFrame=${releaseReady.inFrame || false}), clicking...`);

          // Click the Release button - check if it's in iframe or main page
          let releaseClicked = { clicked: false };

          if (releaseReady.inFrame) {
            // Button is in iframe, find and click it
            const frames = page.frames();
            for (const frame of frames) {
              if (frame === page.mainFrame()) continue;
              try {
                releaseClicked = await frame.evaluate(() => {
                  const buttons = document.querySelectorAll('button, .ant-btn');
                  for (const btn of buttons) {
                    const text = (btn.textContent || '').toLowerCase().trim();
                    if (text.includes('release') || text.includes('发布') ||
                        text === 'submit' || text === '提交') {
                      btn.click();
                      return { clicked: true, text: btn.textContent.trim(), inFrame: true };
                    }
                  }
                  return { clicked: false };
                });
                if (releaseClicked.clicked) break;
              } catch (e) { /* ignore */ }
            }
          } else {
            // Button is in main page or modal
            releaseClicked = await page.evaluate(() => {
              // Check modal first
              const modal = document.querySelector('.ant-modal, .arco-modal, [class*="modal"]');
              const container = modal || document;
              const buttons = container.querySelectorAll('button, .ant-btn');
              for (const btn of buttons) {
                const text = (btn.textContent || '').toLowerCase().trim();
                if (text.includes('release') || text.includes('发布') ||
                    text === 'submit' || text === '提交' || text === 'ok' || text === '确定' ||
                    (text.includes('confirm') && !text.includes('cancel'))) {
                  btn.click();
                  return { clicked: true, text: btn.textContent.trim() };
                }
              }
              return { clicked: false };
            });
          }

          if (releaseClicked.clicked) {
            log(`Clicked Release button: ${releaseClicked.text}`);
            await new Promise(r => setTimeout(r, 2000));
            await addScreenshot(page, '6g_release_clicked');

            // Verify Release was successful by waiting for workorder page/modal to appear
            log('Verifying Release was successful...');
            const releaseVerified = await pollForCondition(
              async () => {
                const status = await page.evaluate(() => {
                  const pageText = document.body.innerText;
                  // Check for indicators that workorder was created/opened
                  const hasWorkorder = pageText.includes('工单详情') ||
                                       pageText.includes('Work Order') ||
                                       pageText.includes('开始发布') ||
                                       pageText.includes('完成确认') ||
                                       pageText.includes('Waiting') ||
                                       pageText.includes('上线阶段');
                  const hasModal = !!document.querySelector('.ant-modal, .arco-modal, [class*="modal"]');
                  const urlChanged = window.location.href.includes('release_history') ||
                                     window.location.href.includes('workorder');
                  return {
                    ready: hasWorkorder || hasModal || urlChanged,
                    hasWorkorder,
                    hasModal,
                    urlChanged,
                    url: window.location.href.substring(0, 100)
                  };
                });
                return status;
              },
              { timeout: 15000, interval: 1000, description: 'ReleaseVerify', log }
            );

            await addScreenshot(page, '6h_release_verified');

            if (releaseVerified.ready) {
              log(`Release verified: workorder=${releaseVerified.hasWorkorder}, modal=${releaseVerified.hasModal}, urlChanged=${releaseVerified.urlChanged}`);
              log('Release successful - workorder created');
            } else {
              log('Warning: Could not verify Release success, but button was clicked');
            }
          } else {
            log('Warning: Could not click Release button');
          }
        } else {
          log(`Warning: Release button not ready after timeout. hasBtn=${releaseReady.hasReleaseBtn}, loading=${releaseReady.hasLoading}`);

          // Try harder - look for any button that might be Release
          log('Trying alternative Release button search...');
          const altReleaseClicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, .ant-btn, [role="button"]');
            const debugInfo = [];
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim().toLowerCase();
              debugInfo.push(text.substring(0, 30));
              // Look for various Release button patterns
              if (text.includes('release') || text.includes('发布') ||
                  text.includes('publish') || text.includes('submit') ||
                  text.includes('confirm') || text.includes('确认')) {
                // Skip if it's a cancel/close button
                if (text.includes('cancel') || text.includes('取消') || text.includes('close')) continue;
                btn.click();
                return { clicked: true, text: btn.textContent.trim() };
              }
            }
            return { clicked: false, buttons: debugInfo.slice(0, 20) };
          });

          if (altReleaseClicked.clicked) {
            log(`Clicked alternative Release button: ${altReleaseClicked.text}`);
            await new Promise(r => setTimeout(r, 2000));
            await addScreenshot(page, '6g_alt_release_clicked');
          } else {
            log(`Available buttons: ${JSON.stringify(altReleaseClicked.buttons)}`);
            throw new Error('Release button not found - cannot complete deployment');
          }
        }
      } else {
        log('Warning: Could not find Deployment button');
        throw new Error('Deployment button not found');
      }

      // Step 8: Complete the task - Release was clicked
      await setStage('Release clicked');
      log('Step 8: Release clicked successfully');
      await addScreenshot(page, '8_final');
      task.status = 'completed';
      task.result = 'IDL branch updated and Release clicked';

      task.endTime = new Date().toISOString();
      log('Task completed successfully!');
      await saveTaskToDb(taskId, task);

      // Cleanup - close pages but release browser back to pool for reuse
      if (browser) {
        try {
          // Close all pages except the default blank page
          const pages = await browser.pages();
          for (const p of pages) {
            if (p.url() !== 'about:blank') {
              await p.close().catch(() => {});
            }
          }
          log('Pages closed, releasing browser to pool');
        } catch (e) { /* ignore */ }
        browserPool.release(log);
        runningBrowsers.delete(taskId);
      }
      return;

    } catch (error) {
      // SSO/cookie errors - don't retry, user action needed
      if (error.message && (error.message.includes('refresh cookies') || error.message.includes('Not logged in'))) {
        log(`User action required: ${error.message}`);
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
        return;
      }

      // Navigation context destroyed - retry
      if (error.message && error.message.includes('Execution context was destroyed')) {
        log(`Navigation context destroyed (retry ${retryCount + 1}/${MAX_RETRIES}): ${error.message}`);

        if (browser) {
          const browserInfo = runningBrowsers.get(taskId);
          try {
            await browser.close();
            log('Browser closed for retry');
          } catch (e) {
            if (browserInfo && browserInfo.pid) {
              forceKillBrowser(browserInfo.pid);
            }
          }
          runningBrowsers.delete(taskId);
        }

        if (retryCount < MAX_RETRIES) {
          log(`Retrying task in 2 seconds...`);
          await new Promise(r => setTimeout(r, 2000));
          return runJanusTask(taskId, task, retryCount + 1);
        } else {
          log(`Max retries (${MAX_RETRIES}) exceeded - marking as error`);
          task.status = 'error';
          task.error = `Navigation context destroyed after ${MAX_RETRIES} retries`;
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
          return;
        }
      }

      // Use common error handler (takes screenshot, updates task, cleans up browser)
      await handleTaskError({ taskId, task, error, browser, log, addScreenshot });
    }
  }

  return runJanusTask;
}

/**
 * Create a Workorder execution task runner
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
   * Run a Janus workorder execution task
   */
  async function runWorkorderTask(taskId, task, retryCount = 0) {
    const MAX_RETRIES = 3;

    const log = (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      console.log(`[${taskId}] ${msg}`);
      task.logs.push(line);
    };

    const addScreenshot = async (page, label) => {
      try {
        const data = await page.screenshot({ encoding: 'base64' });
        const taskSS = screenshots.get(taskId) || [];
        const index = taskSS.length;
        taskSS.push({ label, data, time: new Date().toISOString() });
        screenshots.set(taskId, taskSS);
        await saveScreenshotToDb(taskId, index, label, data);
        log(`Screenshot: ${label}`);
      } catch (e) {
        log(`Screenshot failed: ${e.message}`);
      }
    };

    const setStage = async (stage) => {
      task.stage = stage;
      log(`Stage: ${stage}`);
      await saveTaskToDb(taskId, task);
    };

    let browser = null;

    try {
      await setStage('Initializing');
      log(`Workorder execution: psm=${task.psm}, lane=${task.env}, api_group_id=${task.api_group_id}`);

      // Task-specific args only (common stability args handled by BrowserPool)
      const browserArgs = [
        '--disable-web-security',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1600,1000',
        '--enable-features=NetworkService,NetworkServiceInProcess'
      ];

      if (proxyConfig.proxyEnabled) {
        browserArgs.push(`--proxy-server=http://127.0.0.1:${LOCAL_PROXY_PORT}`);
        log(`Using proxy: http://127.0.0.1:${LOCAL_PROXY_PORT}`);
      } else {
        log('Proxy disabled - direct connections');
      }

      // Get browser from pool
      const browserResult = await browserPool.getBrowser(browserArgs, log);
      browser = browserResult.browser;
      const browserPid = browserResult.pid;
      const browserCached = browserResult.cached;

      runningBrowsers.set(taskId, { browser, pid: browserPid, startTime: Date.now() });
      log(`Browser ready (cached=${browserCached}, PID=${browserPid})`);

      // Record task
      browserPool.recordTask(taskId, task.type);

      let page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 1000 });
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      // Load cookies
      const rawCookies = loadCookies();
      const cookies = convertToPuppeteerCookies(rawCookies);

      log('Setting up cookies...');
      if (cookies.length > 0) {
        for (const cookie of cookies) {
          try {
            const domain = cookie.domain.replace(/^\./, '');
            const url = `https://${domain}/`;
            await page.setCookie({ ...cookie, url });
          } catch (e) {
            // Ignore cookie errors
          }
        }
        log(`Loaded ${cookies.length} cookies`);
      }

      // Navigate directly to release_history page using api_group_id
      await setStage('Opening release history');
      const releaseHistoryUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${task.api_group_id}/tab/release_history?lane=${task.env}&x-resource-account=boe&x-bc-region-id=bytedance`;
      log(`Navigating to release history: ${releaseHistoryUrl}`);
      await page.goto(releaseHistoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      browserPool.recordUrl(releaseHistoryUrl, taskId);

      // Wait for release history page to load
      log('Waiting for release history to load...');
      await pollForCondition(
        async () => {
          const status = await page.evaluate(() => {
            const pageText = document.body.innerText;
            const hasTable = !!document.querySelector('.ant-table, table');
            const hasReleaseHistory = pageText.includes('Release history') || pageText.includes('发布历史') ||
                                      pageText.includes('Unpublished') || pageText.includes('未发布') ||
                                      pageText.includes('Waiting') || pageText.includes('等待中');
            const isLoading = !!document.querySelector('.ant-spin-spinning');
            return {
              ready: hasTable && !isLoading,
              hasTable,
              hasReleaseHistory,
              isLoading
            };
          });
          return status;
        },
        { timeout: 60000, interval: 3000, description: 'ReleaseHistoryLoad', log }
      );

      await addScreenshot(page, '1_release_history');

      // Find the first "Waiting" workorder row in the PSM subgroup
      await setStage('Finding workorder');
      log(`Looking for workorder: psm=${task.psm}, status=Waiting`);

      const workorderFound = await page.evaluate((targetPsm) => {
        // On release_history page, find the subgroup matching PSM
        // Then find the first row with "Waiting" status and click it
        const pageText = document.body.innerText;

        // Look for all table rows
        const rows = document.querySelectorAll('.ant-table-row, .arco-table-tr, tr[class*="table"]');
        const debugInfo = { subgroups: [], waitingRows: [] };

        // First, try to find rows that contain both the PSM and "Waiting" status
        for (const row of rows) {
          const rowText = row.textContent || '';
          const hasPsm = rowText.includes(targetPsm);
          const isWaiting = rowText.includes('Waiting') || rowText.includes('等待中') || rowText.includes('待发布');

          if (hasPsm) {
            debugInfo.subgroups.push(rowText.substring(0, 80));
          }

          if (hasPsm && isWaiting) {
            debugInfo.waitingRows.push(rowText.substring(0, 80));

            // Click the row itself to open workorder details
            row.click();
            return {
              found: true,
              clicked: true,
              matchType: 'row-click',
              rowText: rowText.substring(0, 100)
            };
          }
        }

        // If no "Waiting" rows found, look for expandable subgroups
        const expandButtons = document.querySelectorAll('.ant-table-row-expand-icon, [class*="expand"], [aria-expanded]');
        for (const btn of expandButtons) {
          const parentRow = btn.closest('tr, .ant-table-row');
          if (parentRow && parentRow.textContent.includes(targetPsm)) {
            // Expand this subgroup
            btn.click();
            return { found: true, clicked: true, matchType: 'expand-subgroup', text: parentRow.textContent.substring(0, 80) };
          }
        }

        // Return debug info
        return {
          found: false,
          clicked: false,
          debugInfo,
          pagePreview: pageText.substring(0, 300)
        };
      }, task.psm);

      log(`Workorder search result: ${JSON.stringify(workorderFound).substring(0, 200)}`);

      if (!workorderFound.found) {
        log('Warning: Could not find workorder with "Waiting" status');
        if (workorderFound.debugInfo) {
          log(`Debug - Subgroups found: ${workorderFound.debugInfo.subgroups.length}`);
          log(`Debug - Waiting rows found: ${workorderFound.debugInfo.waitingRows.length}`);
        }
        if (workorderFound.pagePreview) {
          log(`Page preview: ${workorderFound.pagePreview.substring(0, 150)}`);
        }
        await addScreenshot(page, '2_workorder_not_found');
        task.status = 'error';
        task.error = 'No workorder with Waiting status found';
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
        browserPool.release(log);
        runningBrowsers.delete(taskId);
        return;
      }

      if (!workorderFound.clicked) {
        log('Warning: Found workorder but could not click row');
        await addScreenshot(page, '2_workorder_no_click');
        task.status = 'error';
        task.error = 'Workorder found but could not click';
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
        browserPool.release(log);
        runningBrowsers.delete(taskId);
        return;
      }

      log(`Clicked workorder: ${workorderFound.matchType}, ${workorderFound.rowText || workorderFound.text || ''}`);


      // Wait for navigation or new tab to open
      await setStage('Loading workorder details');
      log('Waiting for navigation or new tab after clicking Details...');

      // Wait a moment for navigation/new tab to occur
      await new Promise(r => setTimeout(r, 2000));

      // Check if a new tab/page was opened
      const pages = await browser.pages();
      log(`Browser has ${pages.length} pages after Details click`);

      // If a new tab was opened, switch to it
      if (pages.length > 1) {
        const newPage = pages[pages.length - 1];
        log(`Switching to new tab: ${newPage.url()}`);
        page = newPage; // Use the new page for subsequent operations
        await page.bringToFront();

        // Enable console logging from the page
        page.on('console', msg => {
          if (msg.type() === 'error') {
            log(`[Page Console Error]: ${msg.text().substring(0, 100)}`);
          }
        });

        // Wait for the new tab to finish loading
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
          log('New tab navigation completed');
        } catch (e) {
          log(`Navigation wait: ${e.message.substring(0, 50)}`);
        }

        // Set a larger viewport to help with rendering
        await page.setViewport({ width: 1920, height: 1200 });

        // Additional wait for dynamic content
        await new Promise(r => setTimeout(r, 8000));
        log(`New tab URL after wait: ${page.url()}`);

        // Log page content for debugging
        const pageInfo = await page.evaluate(() => {
          const allButtons = document.querySelectorAll('button, .arco-btn');
          const btnTexts = Array.from(allButtons).map(b => b.textContent.trim().substring(0, 30));
          return {
            url: window.location.href,
            title: document.title,
            buttonCount: allButtons.length,
            buttonTexts: btnTexts.slice(0, 15)
          };
        });
        log(`Page info: ${JSON.stringify(pageInfo)}`);

        // Click on "Work Order Details" tab to ensure we're on the right tab
        log('Looking for Work Order Details tab...');
        const tabClicked = await page.evaluate(() => {
          // Find and click the "Work Order Details" tab
          const tabs = document.querySelectorAll('.arco-tabs-tab, [role="tab"], span');
          for (const tab of tabs) {
            const text = (tab.textContent || '').trim();
            if (text.includes('Work Order Details') || text.includes('工单详情')) {
              tab.click();
              return { clicked: true, text };
            }
          }
          return { clicked: false, availableTabs: Array.from(tabs).map(t => t.textContent.trim().substring(0, 20)).slice(0, 10) };
        });
        log(`Tab click result: ${JSON.stringify(tabClicked)}`);
        await new Promise(r => setTimeout(r, 3000));

        // Scroll down to trigger lazy loading of bottom content
        log('Scrolling down to load full page content...');
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await new Promise(r => setTimeout(r, 5000));

        // Take screenshot after scroll
        await addScreenshot(page, '2a_after_scroll');

        // Wait more for iframe to load
        log('Waiting for iframe to fully load...');
        await new Promise(r => setTimeout(r, 10000));

        // Take another screenshot after wait
        await addScreenshot(page, '2b_after_wait');

        // Check buttons again after scroll
        const afterScrollInfo = await page.evaluate(() => {
          const allButtons = document.querySelectorAll('button, .arco-btn');
          const btnTexts = Array.from(allButtons).map(b => b.textContent.trim().substring(0, 30));

          // Check for iframes
          const iframes = document.querySelectorAll('iframe');
          const iframeInfo = Array.from(iframes).map(f => ({ src: f.src, id: f.id })).slice(0, 5);

          // Check page dimensions
          const bodyHeight = document.body.scrollHeight;
          const docHeight = document.documentElement.scrollHeight;

          // Look for any element containing "开始发布" anywhere in the page
          const allText = document.body.innerText;
          const hasPublishText = allText.includes('开始发布');

          return {
            buttonCount: allButtons.length,
            buttonTexts: btnTexts.slice(0, 20),
            iframes: iframeInfo,
            bodyHeight,
            docHeight,
            hasPublishTextAnywhere: hasPublishText
          };
        });
        log(`Buttons after scroll: ${JSON.stringify(afterScrollInfo)}`);
      }

      log('Waiting for workorder detail page with "开始发布" button...');

      // Check if the button is inside an iframe - retry a few times
      log('Looking for bytecycle-iframe...');
      let targetFrame = page;
      let bytecycleFrame = null;

      // Try to find the iframe up to 5 times
      for (let attempt = 0; attempt < 5; attempt++) {
        const frames = page.frames();
        log(`Attempt ${attempt + 1}: Found ${frames.length} frames`);
        frames.forEach((f, i) => {
          const url = f.url();
          if (url && url !== 'about:blank') {
            log(`  Frame ${i}: ${url.substring(0, 80)}`);
          }
        });

        bytecycleFrame = frames.find(f => f.url().includes('bits.bytedance.net') || f.url().includes('devops'));
        if (bytecycleFrame) {
          log(`Found bytecycle iframe: ${bytecycleFrame.url().substring(0, 100)}`);
          targetFrame = bytecycleFrame;
          break;
        }

        log('bytecycle iframe not found, waiting 5s and retrying...');
        await new Promise(r => setTimeout(r, 5000));
      }

      if (bytecycleFrame) {
        // Wait for iframe content to load
        await new Promise(r => setTimeout(r, 8000));

        // Take screenshot of iframe if possible
        try {
          await addScreenshot(page, '2c_with_iframe');
        } catch (e) {
          log(`Screenshot error: ${e.message.substring(0, 50)}`);
        }

        // Check iframe content
        try {
          const iframeInfo = await bytecycleFrame.evaluate(() => {
            const allButtons = document.querySelectorAll('button');
            const btnTexts = Array.from(allButtons).map(b => b.textContent.trim().substring(0, 30));
            const hasPublishText = document.body.innerText.includes('开始发布');
            return { buttonCount: allButtons.length, buttonTexts: btnTexts.slice(0, 15), hasPublishText };
          });
          log(`Iframe content: ${JSON.stringify(iframeInfo)}`);
        } catch (e) {
          log(`Iframe evaluate error: ${e.message.substring(0, 80)}`);
        }
      } else {
        log('bytecycle iframe not found after 5 attempts, using main page');
      }

      const publishBtnReady = await pollForCondition(
        async () => {
          const status = await targetFrame.evaluate(() => {
            // Support both Ant Design and Arco Design button selectors
            const buttons = document.querySelectorAll('button, .ant-btn, .arco-btn');
            let publishBtn = null;
            let isDisabled = false;
            let hasLoading = false;

            // Collect all button texts for debugging
            const allBtnTexts = [];
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim();
              if (text) allBtnTexts.push(text.substring(0, 30));

              // Check for publish button - various possible labels
              if (text.includes('开始发布') || text.includes('Start publish') ||
                  text.includes('Publish') || text.includes('发布') || text.includes('Start')) {
                publishBtn = btn;
                // Arco Design disabled: arco-btn-disabled, aria-disabled
                // Ant Design disabled: ant-btn-disabled
                isDisabled = btn.disabled ||
                             btn.classList.contains('ant-btn-disabled') ||
                             btn.classList.contains('arco-btn-disabled') ||
                             btn.getAttribute('aria-disabled') === 'true';
                // Arco Design loading: arco-btn-loading
                // Ant Design loading: ant-btn-loading
                hasLoading = btn.classList.contains('ant-btn-loading') ||
                             btn.classList.contains('arco-btn-loading') ||
                             !!btn.querySelector('.ant-btn-loading-icon') ||
                             !!btn.querySelector('.anticon-loading') ||
                             !!btn.querySelector('.arco-icon-loading');
                break;
              }
            }

            return {
              ready: publishBtn && !isDisabled && !hasLoading,
              hasPublishBtn: !!publishBtn,
              isDisabled,
              hasLoading,
              buttonText: publishBtn ? publishBtn.textContent.trim() : null,
              allButtons: allBtnTexts.slice(0, 10)
            };
          });
          return status;
        },
        { timeout: 60000, interval: 2000, description: 'PublishBtnReady', log }
      );

      await addScreenshot(page, '2_workorder_detail');

      // Check if we're already at 完成确认 stage (skip 开始发布)
      const alreadyAtConfirmStage = await targetFrame.evaluate(() => {
        const pageText = document.body.innerText;
        const hasConfirmStage = pageText.includes('完成确认');

        // Check if 完成确认 is the current/active stage
        const allElements = document.querySelectorAll('*');
        let isConfirmStageActive = false;
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          if (text === '完成确认' || text.startsWith('完成确认')) {
            const classes = el.className + ' ' + (el.parentElement?.className || '');
            if (classes.includes('active') || classes.includes('current') ||
                classes.includes('highlight') || classes.includes('processing') ||
                classes.includes('wait')) {
              isConfirmStageActive = true;
              break;
            }
          }
        }

        // Also check if there's no 开始发布 button but there is 确认 button
        const buttons = document.querySelectorAll('button, .arco-btn');
        let hasPublishBtn = false;
        let hasConfirmBtn = false;
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim();
          if (text.includes('开始发布')) hasPublishBtn = true;
          if (text === '确认' || text === 'Confirm') hasConfirmBtn = true;
        }

        return {
          isAtConfirmStage: hasConfirmStage && (isConfirmStageActive || (!hasPublishBtn && hasConfirmBtn)),
          hasConfirmStage,
          isConfirmStageActive,
          hasPublishBtn,
          hasConfirmBtn
        };
      });

      log(`Current stage check: ${JSON.stringify(alreadyAtConfirmStage)}`);

      // Determine if we need to click 开始发布 or skip to 确认
      let needToClickPublish = publishBtnReady.ready;
      let skipToConfirm = false;

      if (!publishBtnReady.ready) {
        // Check if we're already at 完成确认 stage
        if (alreadyAtConfirmStage.isAtConfirmStage) {
          log('Already at 完成确认 stage, skipping 开始发布 and going directly to 确认...');
          await addScreenshot(page, '2b_already_at_confirm');
          skipToConfirm = true;
        } else {
          log(`Warning: 开始发布 button not ready. hasBtn=${publishBtnReady.hasPublishBtn}, disabled=${publishBtnReady.isDisabled}, loading=${publishBtnReady.hasLoading}`);
          task.status = 'error';
          task.error = '开始发布 button not ready and not at 完成确认 stage';
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
          browserPool.release(log);
          runningBrowsers.delete(taskId);
          return;
        }
      }

      // If we need to click 开始发布, do it now
      if (needToClickPublish) {
        log('开始发布 button ready, clicking...');

        // Use targetFrame (which is the bytecycle iframe) instead of page
        const publishClicked = await targetFrame.evaluate(() => {
          // Support both Ant Design and Arco Design
          const buttons = document.querySelectorAll('button, .ant-btn, .arco-btn');
          const debugInfo = [];
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            debugInfo.push({ text: text.substring(0, 30), disabled: btn.disabled, visible: btn.offsetParent !== null });
            if (text.includes('开始发布') || text.includes('Start publish') ||
                text.includes('Publish') || text.includes('发布')) {
              // Don't match buttons that are too short or too generic
              if (text.length > 1 && !text.toLowerCase().startsWith('start') || text === 'Start publish') {
                try {
                  btn.click();
                  return { clicked: true, text: text, method: 'click' };
                } catch (e) {
                  // Try dispatchEvent as fallback
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  return { clicked: true, text: text, method: 'dispatch' };
                }
              }
            }
          }
          return { clicked: false, debugInfo: debugInfo.slice(0, 15) };
        });

        log(`Click result: ${JSON.stringify(publishClicked).substring(0, 300)}`);

        if (!publishClicked.clicked) {
          log('Warning: Could not click 开始发布 button');
          task.status = 'error';
          task.error = 'Could not click 开始发布 button';
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
          browserPool.release(log);
          runningBrowsers.delete(taskId);
          return;
        }

        log(`Clicked 开始发布 button: ${publishClicked.text}`);
        await new Promise(r => setTimeout(r, 3000));
        await addScreenshot(page, '3_publish_started');
      }

      // Now wait for 完成确认 stage (or we're already there if skipToConfirm)
      await setStage('Waiting for 完成确认 stage');
      log('Waiting for 完成确认 stage to be highlighted...');

      // Poll for the 完成确认 stage to be active (highlighted)
      const confirmStageReady = await pollForCondition(
        async () => {
          const status = await targetFrame.evaluate(() => {
            const pageText = document.body.innerText;
            const hasConfirmStage = pageText.includes('完成确认');

            // Check if 完成确认 node is highlighted (active stage)
            const allElements = document.querySelectorAll('*');
            let isConfirmStageActive = false;
            for (const el of allElements) {
              const text = (el.textContent || '').trim();
              if (text === '完成确认' || text.startsWith('完成确认')) {
                const classes = el.className + ' ' + (el.parentElement?.className || '');
                if (classes.includes('active') || classes.includes('current') ||
                    classes.includes('highlight') || classes.includes('processing') ||
                    classes.includes('wait')) {
                  isConfirmStageActive = true;
                  break;
                }
              }
            }

            // Look for the 确认 button
            const buttons = document.querySelectorAll('button, .arco-btn, [class*="btn"]');
            let confirmBtn = null;
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim();
              if (text === '确认' || text === 'Confirm') {
                const isVisible = btn.offsetParent !== null;
                const isDisabled = btn.disabled || btn.classList.contains('arco-btn-disabled');
                if (isVisible && !isDisabled) {
                  confirmBtn = btn;
                  break;
                }
              }
            }

            return {
              ready: hasConfirmStage && (!!confirmBtn || isConfirmStageActive),
              hasConfirmStage,
              hasConfirmBtn: !!confirmBtn,
              isConfirmStageActive,
              buttonCount: buttons.length
            };
          });
          return status;
        },
        { timeout: skipToConfirm ? 30000 : 120000, interval: 3000, description: 'ConfirmBtnReady', log }
      );

      await addScreenshot(page, '4_confirm_stage');

      if (confirmStageReady.ready || skipToConfirm) {
        log('完成确认 stage reached, looking for 确认 button...');

        // Helper function to try clicking confirm button (including "..." menu)
        const tryClickConfirm = async () => {
          // First try to find 确认 button directly
          let confirmClicked = await targetFrame.evaluate(() => {
            const buttons = document.querySelectorAll('button, .arco-btn, [class*="btn"]');
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim();
              if (text === '确认' || text === 'Confirm') {
                const isVisible = btn.offsetParent !== null;
                const isDisabled = btn.disabled || btn.classList.contains('arco-btn-disabled');
                if (isVisible && !isDisabled) {
                  btn.click();
                  return { clicked: true, text: text, method: 'direct' };
                }
              }
            }
            return { clicked: false };
          });

          // If not found directly, try to find it in "..." dropdown menu
          if (!confirmClicked.clicked) {
            log('确认 button not visible directly, looking for "..." menu...');

            // Look for and click the "..." or "more" button
            const moreClicked = await targetFrame.evaluate(() => {
              // Look for "..." button or icon button that might contain more options
              const possibleMoreButtons = document.querySelectorAll(
                'button, .arco-btn, [class*="btn"], [class*="more"], [class*="dropdown"], [class*="icon"]'
              );

              for (const btn of possibleMoreButtons) {
                const text = (btn.textContent || '').trim();
                const isVisible = btn.offsetParent !== null;

                // Match "..." or similar more options indicators
                if (isVisible && (text === '...' || text === '···' || text === '•••' ||
                    text === '更多' || text === 'More' ||
                    btn.className.includes('more') || btn.className.includes('ellipsis') ||
                    btn.className.includes('dropdown-trigger'))) {
                  btn.click();
                  return { clicked: true, text: text };
                }

                // Also check for icon-only buttons (might have aria-label or title)
                const ariaLabel = btn.getAttribute('aria-label') || '';
                const title = btn.getAttribute('title') || '';
                if (isVisible && (ariaLabel.includes('more') || ariaLabel.includes('更多') ||
                    title.includes('more') || title.includes('更多'))) {
                  btn.click();
                  return { clicked: true, text: ariaLabel || title };
                }
              }

              // Also try clicking any visible "..." text
              const allSpans = document.querySelectorAll('span, div');
              for (const span of allSpans) {
                const text = (span.textContent || '').trim();
                if ((text === '...' || text === '···' || text === '•••') && span.offsetParent !== null) {
                  span.click();
                  return { clicked: true, text: text, element: 'span' };
                }
              }

              return { clicked: false };
            });

            if (moreClicked.clicked) {
              log(`Clicked "..." menu: ${JSON.stringify(moreClicked)}`);
              await new Promise(r => setTimeout(r, 1000)); // Wait for dropdown to appear
              await addScreenshot(page, '4b_more_menu');

              // Now try to find 确认 in the dropdown
              confirmClicked = await targetFrame.evaluate(() => {
                // Look in dropdown/popover/menu that just appeared
                const dropdowns = document.querySelectorAll(
                  '.arco-dropdown, .arco-popover, .arco-menu, [class*="dropdown"], [class*="popover"], [class*="menu"], [class*="overlay"]'
                );

                // First check in dropdown containers
                for (const dropdown of dropdowns) {
                  const items = dropdown.querySelectorAll('button, .arco-btn, [class*="btn"], [class*="item"], a, span, div');
                  for (const item of items) {
                    const text = (item.textContent || '').trim();
                    if (text === '确认' || text === 'Confirm') {
                      const isVisible = item.offsetParent !== null;
                      if (isVisible) {
                        item.click();
                        return { clicked: true, text: text, method: 'dropdown' };
                      }
                    }
                  }
                }

                // Also check all visible buttons again (dropdown might have added new ones)
                const allButtons = document.querySelectorAll('button, .arco-btn, [class*="btn"], [class*="item"]');
                for (const btn of allButtons) {
                  const text = (btn.textContent || '').trim();
                  if (text === '确认' || text === 'Confirm') {
                    const isVisible = btn.offsetParent !== null;
                    const isDisabled = btn.disabled || btn.classList.contains('arco-btn-disabled');
                    if (isVisible && !isDisabled) {
                      btn.click();
                      return { clicked: true, text: text, method: 'dropdown-fallback' };
                    }
                  }
                }

                return { clicked: false };
              });
            } else {
              log('Could not find "..." menu button');
            }
          }

          return confirmClicked;
        };

        const confirmClicked = await tryClickConfirm();
        log(`Confirm click result: ${JSON.stringify(confirmClicked)}`);

        if (confirmClicked.clicked) {
          log(`Clicked 确认 button successfully (method: ${confirmClicked.method})`);
          await new Promise(r => setTimeout(r, 3000));
          await addScreenshot(page, '5_confirmed');

          await setStage('Workorder confirmed');
          task.status = 'completed';
          task.result = 'Workorder publish confirmed';
        } else {
          log('Warning: Could not click 确认 button (not found directly or in menu)');
          await addScreenshot(page, '5_confirm_failed');
          await setStage('Publish initiated (confirm pending)');
          task.status = 'completed';
          task.result = 'Workorder publish initiated, manual confirm may be needed';
        }
      } else {
        log('Warning: 完成确认 stage not reached within timeout');
        await setStage('Publish initiated');
        task.status = 'completed';
        task.result = 'Workorder publish initiated, confirm stage not reached';
      }

      task.endTime = new Date().toISOString();
      log('Task completed!');
      await saveTaskToDb(taskId, task);

      // Cleanup
      if (browser) {
        try {
          const pages = await browser.pages();
          for (const p of pages) {
            if (p.url() !== 'about:blank') {
              await p.close().catch(() => {});
            }
          }
          log('Pages closed, releasing browser to pool');
        } catch (e) { /* ignore */ }
        browserPool.release(log);
        runningBrowsers.delete(taskId);
      }
      return;

    } catch (error) {
      log(`Error: ${error.message}`);
      task.status = 'error';
      task.error = error.message;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);

      if (browser) {
        try {
          await browser.close();
        } catch (e) { /* ignore */ }
        runningBrowsers.delete(taskId);
      }
    }
  }

  return runWorkorderTask;
}

module.exports = { createJanusTaskRunner, createWorkorderTaskRunner };
