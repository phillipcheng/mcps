#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const puppeteer = require("puppeteer");

// Backend server configuration
const BACKEND_URL = process.env.BROWSER_BACKEND_URL || "http://localhost:3456";

const server = new Server(
  {
    name: "mcp-browser",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function withBrowser(action) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // Important for some environments
  });
  try {
    const page = await browser.newPage();
    // Set a reasonable viewport and user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    return await action(page);
  } finally {
    await browser.close();
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "browse",
        description:
          "Visit a URL and return its text content. Use this to read documentation or web pages.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to visit",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "screenshot",
        description:
          "Visit a URL and return a base64 encoded screenshot. Use this to see what a page looks like.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to visit",
            },
            fullPage: {
                type: "boolean",
                description: "Whether to take a full page screenshot (default: false)"
            }
          },
          required: ["url"],
        },
      },
      {
        name: "interact",
        description: "Visit a URL, perform a sequence of actions (click, fill, wait, get_property), and return text content and/or a screenshot.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The starting URL." },
            actions: {
              type: "array",
              description: "List of actions to perform.",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["click", "fill", "wait", "get_property"], description: "The type of action." },
                  selector: { type: "string", description: "CSS selector for click/fill/wait/get_property." },
                  value: { type: "string", description: "Value to fill for 'fill' action." },
                  timeout: { type: "number", description: "Timeout in ms for 'wait' action." },
                  property: { type: "string", description: "Property to retrieve for 'get_property' action (e.g., 'width')." }
                },
                required: ["action"]
              }
            },
            screenshot: { type: "boolean", description: "Whether to return a screenshot after actions." }
          },
          required: ["url", "actions"]
        }
      },
      {
        name: "janus_mini_update",
        description: "Update Janus Mini for a PSM based on IDL branch on a specific BOE environment. This automates the full workflow: select PSM, update IDL to latest version, and deploy.",
        inputSchema: {
          type: "object",
          properties: {
            psm: { type: "string", description: "The PSM name, e.g., 'oec.reverse.strategy'" },
            idl_branch: { type: "string", description: "The IDL branch name, e.g., 'feat/sell_rule'" },
            env: { type: "string", description: "The BOE environment name, e.g., 'boe_feat_system_deleete'" },
            dry_run: { type: "boolean", description: "If true, only navigate and take screenshots without clicking deploy/release. Default: false" }
          },
          required: ["psm", "env"]
        }
      },
      {
        name: "crawl_task",
        description: "Execute a browser automation task and return results. Submits a task to the backend server, waits for completion, and returns the result. Available task types: 'janus_info' (get current and latest IDL version), 'janus_update' (update IDL version and deploy), 'workorder' (file workorder task).",
        inputSchema: {
          type: "object",
          properties: {
            task_type: {
              type: "string",
              enum: ["janus_info", "janus_update", "workorder"],
              description: "The type of task to execute"
            },
            params: {
              type: "object",
              description: "Task parameters. For janus_info: {psm, env, idl_branch, api_group_id?}. For janus_update: {psm, env, idl_branch, idl_version?, api_group_id?}. For workorder: {psm, env, idl_branch, workorder_type}.",
              properties: {
                psm: { type: "string", description: "PSM name, e.g., 'oec.reverse.strategy'" },
                env: { type: "string", description: "Environment/lane name, e.g., 'boe_feat_system_deleete'" },
                idl_branch: { type: "string", description: "IDL branch name, e.g., 'feat/sell_rule'" },
                idl_version: { type: "string", description: "Specific IDL version to use (optional, defaults to latest)" },
                api_group_id: { type: "string", description: "API group ID for direct navigation (optional)" },
                workorder_type: { type: "string", description: "Type of workorder for workorder tasks" }
              }
            },
            timeout: {
              type: "number",
              description: "Maximum wait time in seconds for task completion. Default: 120"
            }
          },
          required: ["task_type", "params"]
        }
      }
    ],
  };
});

async function performActions(page, actions) {
  for (const item of actions) {
    try {
      if (item.action === 'click') {
        if (!item.selector) throw new Error("Selector required for click");
        await page.waitForSelector(item.selector, { timeout: 5000 });
        await page.click(item.selector);
      } else if (item.action === 'fill') {
        if (!item.selector || item.value === undefined) throw new Error("Selector and value required for fill");
        await page.waitForSelector(item.selector, { timeout: 5000 });
        await page.type(item.selector, item.value);
      } else if (item.action === 'wait') {
        if (item.selector) {
          await page.waitForSelector(item.selector, { timeout: item.timeout || 5000 });
        } else if (item.timeout) {
          await new Promise(r => setTimeout(r, item.timeout));
        }
      } else if (item.action === 'get_property') {
        if (!item.selector || !item.property) throw new Error("Selector and property required for get_property");
        await page.waitForSelector(item.selector, { timeout: 5000 });
        const result = await page.evaluate((selector, property) => {
          const element = document.querySelector(selector);
          if (element) {
            let value;
            if (property === 'width') {
              value = element.offsetWidth; // Use offsetWidth for rendered width
            } else {
              value = element[property];
            }
            return {
              value: value,
              text: element.innerText,
              tagName: element.tagName,
              className: element.className
            };
          }
          return null;
        }, item.selector, item.property);
        // Store the result directly on the page object for retrieval later.
        page._lastResult = result;
      } else if (item.action === 'debug_element') {
        if (!item.selector) throw new Error("Selector required for debug_element");
        await page.waitForSelector(item.selector, { timeout: 5000 });
        const result = await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          if (!el) return { error: "Not found" };
          
          const rect = el.getBoundingClientRect();
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          const topEl = document.elementFromPoint(cx, cy);
          
          const computed = window.getComputedStyle(el);
          
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
            elementFromPoint: topEl ? { tagName: topEl.tagName, className: topEl.className, id: topEl.id, innerText: topEl.innerText.substring(0, 50) } : null,
            styles: {
                display: computed.display,
                visibility: computed.visibility,
                opacity: computed.opacity,
                zIndex: computed.zIndex,
                position: computed.position,
                backgroundColor: computed.backgroundColor
            },
            is_covered: topEl !== el && !el.contains(topEl)
          };
        }, item.selector);
        page._lastResult = result;
      }
    } catch (e) {
      throw new Error(`Action failed: ${item.action} on ${item.selector || 'timer'}: ${e.message}`);
    }
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "browse") {
    const { url } = args;
    try {
      const content = await withBrowser(async (page) => {
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        const text = await page.evaluate(() => document.body.innerText);
        const title = await page.title();
        return `Title: ${title}\n\nURL: ${url}\n\nContent:\n${text}`;
      });

      return { content: [{ type: "text", text: content }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }

  if (name === "screenshot") {
    const { url, fullPage = false } = args;
    try {
      const base64Image = await withBrowser(async (page) => {
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        return await page.screenshot({ encoding: "base64", fullPage });
      });
      return { content: [{ type: "image", data: base64Image, mimeType: "image/png" }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }

  if (name === "interact") {
    const { url, actions, screenshot } = args;
    try {
      const result = await withBrowser(async (page) => {
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        await performActions(page, actions);

        const text = await page.evaluate(() => document.body.innerText);
        const title = await page.title();
        let base64Image = null;
        if (screenshot) {
          base64Image = await page.screenshot({ encoding: "base64" });
        }
        return { text: `Title: ${title}\n\nURL: ${url}\n\nContent:\n${text}`, image: base64Image, actionResult: page._lastResult };
      });

      const content = [{ type: "text", text: result.text }];
      if (result.image) {
        content.push({ type: "image", data: result.image, mimeType: "image/png" });
      }
      if (result.actionResult !== undefined) {
        content.push({ type: "text", text: `ActionResult: ${JSON.stringify(result.actionResult)}` });
      }
      return { content };
    } catch (error) {
       return { content: [{ type: "text", text: `Error interacting: ${error.message}` }], isError: true };
    }
  }

  if (name === "janus_mini_update") {
    const { psm, idl_branch, env, dry_run = false } = args;
    const logs = [];
    const screenshots = [];

    const log = (msg) => {
      console.error(`[Janus] ${msg}`);
      logs.push(`[${new Date().toISOString()}] ${msg}`);
    };

    try {
      const result = await withBrowser(async (page) => {
        // Helper to take screenshot and add to collection
        const takeScreenshot = async (label) => {
          const img = await page.screenshot({ encoding: "base64" });
          screenshots.push({ label, data: img });
          log(`Screenshot: ${label}`);
        };

        // Helper to wait and retry click
        const safeClick = async (selector, description, timeout = 10000) => {
          log(`Waiting for: ${description} (${selector})`);
          await page.waitForSelector(selector, { timeout });
          await page.click(selector);
          log(`Clicked: ${description}`);
          await new Promise(r => setTimeout(r, 1000));
        };

        // Helper to find and click element by text
        const clickByText = async (selector, textPattern, description, timeout = 10000) => {
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
          await new Promise(r => setTimeout(r, 1000));
        };

        // Step 1: Open Janus Mini list
        const listUrl = "https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/list/1?x-resource-account=boe&x-bc-region-id=bytedance";
        log(`Step 1: Opening Janus Mini list: ${listUrl}`);
        await page.goto(listUrl, { waitUntil: "networkidle0", timeout: 60000 });
        await takeScreenshot("1_list_view");

        // Step 2: Search and select PSM
        log(`Step 2: Searching for PSM: ${psm}`);
        // Look for search input and type PSM
        const searchSelector = 'input[placeholder*="PSM"], input[placeholder*="psm"], input[placeholder*="搜索"], input.search-input';
        try {
          await page.waitForSelector(searchSelector, { timeout: 5000 });
          await page.type(searchSelector, psm);
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          log(`Search input not found, trying to find PSM in table directly`);
        }

        // Click on the PSM row in the table
        const psmClicked = await page.evaluate((psmName) => {
          // Try to find PSM in table rows
          const rows = Array.from(document.querySelectorAll('tr, .table-row, [class*="row"]'));
          for (const row of rows) {
            if (row.textContent.includes(psmName)) {
              const link = row.querySelector('a') || row;
              link.click();
              return true;
            }
          }
          // Also try clicking any link containing the PSM
          const links = Array.from(document.querySelectorAll('a'));
          const target = links.find(a => a.textContent.includes(psmName) || a.href.includes(psmName));
          if (target) { target.click(); return true; }
          return false;
        }, psm);

        if (!psmClicked) {
          throw new Error(`Could not find PSM: ${psm}`);
        }
        log(`Selected PSM: ${psm}`);
        await new Promise(r => setTimeout(r, 3000));
        await takeScreenshot("2_psm_selected");

        // Step 3: Navigate to IDL Management tab with lane parameter
        log(`Step 3: Going to IDL Management tab for env: ${env}`);
        // Get current URL to extract the mini ID
        const currentUrl = page.url();
        const miniIdMatch = currentUrl.match(/\/mini\/(\d+)/);
        let miniId = miniIdMatch ? miniIdMatch[1] : null;

        if (!miniId) {
          // Try to get from page content
          miniId = await page.evaluate(() => {
            const url = window.location.href;
            const match = url.match(/\/mini\/(\d+)/);
            return match ? match[1] : null;
          });
        }

        if (miniId) {
          const idlUrl = `https://cloud-boe.bytedance.net/janus/boe-i18n/proxy/mini/${miniId}/tab/IdlConfig?lane=${env}&x-resource-account=boe&x-bc-region-id=bytedance`;
          log(`Navigating to: ${idlUrl}`);
          await page.goto(idlUrl, { waitUntil: "networkidle0", timeout: 60000 });
        } else {
          // Try clicking the tab directly
          await clickByText('button, [role="tab"], .tab', 'IDL', 'IDL Management tab');
        }
        await new Promise(r => setTimeout(r, 2000));
        await takeScreenshot("3_idl_management");

        // Step 4: Click Edit button
        log(`Step 4: Clicking Edit button`);
        await clickByText('button, .btn, [class*="button"]', '编辑', 'Edit button');
        await new Promise(r => setTimeout(r, 2000));
        await takeScreenshot("4_edit_clicked");

        // Step 5: Select latest version
        log(`Step 5: Selecting latest version`);
        // Look for version dropdown or selector
        const versionSelected = await page.evaluate(() => {
          // Try to find and click version dropdown
          const dropdowns = Array.from(document.querySelectorAll('select, [class*="select"], [class*="dropdown"]'));
          for (const dd of dropdowns) {
            if (dd.textContent.includes('version') || dd.textContent.includes('版本')) {
              dd.click();
              return 'dropdown_clicked';
            }
          }
          // Try selecting first option if there's a list
          const options = Array.from(document.querySelectorAll('[class*="option"], li[class*="item"]'));
          if (options.length > 0) {
            options[0].click();
            return 'first_option_clicked';
          }
          return null;
        });
        log(`Version selection result: ${versionSelected}`);
        await new Promise(r => setTimeout(r, 1000));

        // Click confirm/OK button
        log(`Step 5b: Clicking Confirm button`);
        await clickByText('button, .btn', '确定', 'Confirm button');
        await takeScreenshot("5_version_selected");

        // Step 6: Wait for setup successful
        log(`Step 6: Waiting for setup to complete...`);
        let setupComplete = false;
        for (let i = 0; i < 30; i++) { // Wait up to 30 seconds
          const status = await page.evaluate(() => {
            const body = document.body.innerText;
            if (body.includes('成功') || body.includes('successful') || body.includes('Success')) {
              return 'success';
            }
            // Check if edit button is clickable again
            const editBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('编辑'));
            if (editBtn && !editBtn.disabled) {
              return 'edit_enabled';
            }
            return 'waiting';
          });
          if (status === 'success' || status === 'edit_enabled') {
            setupComplete = true;
            log(`Setup complete: ${status}`);
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        if (!setupComplete) {
          log('Warning: Setup completion not detected, continuing anyway');
        }
        await takeScreenshot("6_setup_complete");

        // Step 7: Refresh page
        log(`Step 7: Refreshing page`);
        await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        await takeScreenshot("7_page_refreshed");

        if (dry_run) {
          log(`DRY RUN: Stopping before deployment`);
          return { logs, screenshots, status: 'dry_run_complete' };
        }

        // Step 8: Click Deployment tab
        log(`Step 8: Clicking Deployment tab`);
        await clickByText('button, [role="tab"], .tab, a', '部署', 'Deployment tab');
        await new Promise(r => setTimeout(r, 2000));
        await takeScreenshot("8_deployment_tab");

        // Step 9: Click Release button
        log(`Step 9: Clicking Release button`);
        await clickByText('button, .btn', '发布', 'Release button');
        await new Promise(r => setTimeout(r, 2000));
        await takeScreenshot("9_release_clicked");

        // Step 10: Click "开始发布" (Start Release)
        log(`Step 10: Clicking Start Release button`);
        await clickByText('button, .btn', '开始发布', 'Start Release button');
        await new Promise(r => setTimeout(r, 3000));
        await takeScreenshot("10_start_release");

        // Step 11: Wait for release to complete
        log(`Step 11: Waiting for release to complete...`);
        let releaseComplete = false;
        for (let i = 0; i < 60; i++) { // Wait up to 60 seconds
          const status = await page.evaluate(() => {
            const body = document.body.innerText;
            if (body.includes('发布成功') || body.includes('release successful') || body.includes('完成')) {
              return 'success';
            }
            if (body.includes('失败') || body.includes('failed') || body.includes('error')) {
              return 'failed';
            }
            // Check for any progress indicator
            const progress = document.querySelector('[class*="progress"], [class*="loading"]');
            if (progress) return 'in_progress';
            return 'waiting';
          });

          if (status === 'success') {
            releaseComplete = true;
            log(`Release complete!`);
            break;
          }
          if (status === 'failed') {
            throw new Error('Release failed');
          }

          // Click any "next" or "continue" buttons if present
          await page.evaluate(() => {
            const nextBtns = Array.from(document.querySelectorAll('button')).filter(b =>
              b.textContent.includes('下一步') || b.textContent.includes('继续') || b.textContent.includes('Next')
            );
            if (nextBtns.length > 0 && !nextBtns[0].disabled) {
              nextBtns[0].click();
            }
          });

          await new Promise(r => setTimeout(r, 1000));
        }

        await takeScreenshot("11_release_complete");

        return {
          logs,
          screenshots,
          status: releaseComplete ? 'success' : 'timeout',
          message: releaseComplete ? 'Janus Mini update completed successfully' : 'Release may still be in progress'
        };
      });

      // Build response content
      const content = [{
        type: "text",
        text: `Janus Mini Update Result:\n\nPSM: ${psm}\nEnvironment: ${env}\nIDL Branch: ${idl_branch || 'latest'}\nStatus: ${result.status}\n${result.message || ''}\n\nLogs:\n${result.logs.join('\n')}`
      }];

      // Add screenshots
      for (const ss of result.screenshots) {
        content.push({ type: "text", text: `\n--- Screenshot: ${ss.label} ---` });
        content.push({ type: "image", data: ss.data, mimeType: "image/png" });
      }

      return { content };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error in Janus Mini update:\n\nPSM: ${psm}\nEnvironment: ${env}\nError: ${error.message}\n\nLogs:\n${logs.join('\n')}`
        }],
        isError: true
      };
    }
  }

  if (name === "crawl_task") {
    const { task_type, params, timeout = 120 } = args;
    const logs = [];
    const log = (msg) => {
      console.error(`[CrawlTask] ${msg}`);
      logs.push(`[${new Date().toISOString()}] ${msg}`);
    };

    try {
      // Map task_type to API endpoint
      const endpointMap = {
        'janus_info': '/api/tasks/janus-info',
        'janus_update': '/api/tasks/janus',
        'workorder': '/api/tasks/workorder'
      };

      const endpoint = endpointMap[task_type];
      if (!endpoint) {
        throw new Error(`Unknown task type: ${task_type}. Available: ${Object.keys(endpointMap).join(', ')}`);
      }

      // Submit task
      log(`Submitting ${task_type} task to ${BACKEND_URL}${endpoint}`);
      log(`Parameters: ${JSON.stringify(params)}`);

      const submitRes = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });

      if (!submitRes.ok) {
        const errorText = await submitRes.text();
        throw new Error(`Failed to submit task: ${submitRes.status} ${errorText}`);
      }

      const submitData = await submitRes.json();
      const taskId = submitData.taskId;
      log(`Task submitted with ID: ${taskId}`);

      // Poll for completion
      const startTime = Date.now();
      const timeoutMs = timeout * 1000;
      let taskResult = null;

      while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, 2000)); // Poll every 2 seconds

        const statusRes = await fetch(`${BACKEND_URL}/api/tasks/${taskId}`);
        if (!statusRes.ok) {
          log(`Warning: Failed to fetch task status: ${statusRes.status}`);
          continue;
        }

        const task = await statusRes.json();
        log(`Task status: ${task.status}, stage: ${task.stage || 'N/A'}`);

        if (task.status === 'completed') {
          taskResult = task;
          log(`Task completed successfully`);
          break;
        } else if (task.status === 'error' || task.status === 'failed') {
          throw new Error(`Task failed: ${task.error || 'Unknown error'}`);
        }
      }

      if (!taskResult) {
        throw new Error(`Task timed out after ${timeout} seconds`);
      }

      // Build response
      let resultData = {};
      if (taskResult.result) {
        try {
          resultData = JSON.parse(taskResult.result);
        } catch (e) {
          resultData = { raw: taskResult.result };
        }
      }
      if (taskResult.metadata?.version_info) {
        resultData.version_info = taskResult.metadata.version_info;
      }

      const content = [{
        type: "text",
        text: `Task Result (${task_type}):\n\nTask ID: ${taskId}\nStatus: ${taskResult.status}\nDuration: ${Math.round((new Date(taskResult.endTime) - new Date(taskResult.startTime)) / 1000)}s\n\nResult:\n${JSON.stringify(resultData, null, 2)}\n\nLogs:\n${logs.join('\n')}`
      }];

      // Optionally include task logs
      if (taskResult.logs && taskResult.logs.length > 0) {
        content.push({
          type: "text",
          text: `\n--- Task Execution Logs ---\n${taskResult.logs.slice(-20).join('\n')}`
        });
      }

      return { content };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error executing crawl_task:\n\nTask Type: ${task_type}\nParams: ${JSON.stringify(params)}\nError: ${error.message}\n\nLogs:\n${logs.join('\n')}`
        }],
        isError: true
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Browser Server running on stdio");
}

run().catch((error) => {
  console.error("Fatal error in MCP Browser Server:", error);
  process.exit(1);
});