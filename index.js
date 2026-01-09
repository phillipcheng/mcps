#!/usr/bin/env node

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const puppeteer = require("puppeteer");

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