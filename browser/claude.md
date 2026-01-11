# Browser MCP - Architecture Notes

## Project Structure

```
browser/
├── server.js           # Crawl engine: Express app, routes, common utilities
├── janus_mini.js       # Task type: Janus Mini specific logic
├── index.js            # MCP server entry point
├── mac_cdn_proxy.js    # Mac-side CDN proxy (run on Mac)
├── cookies.json        # Stored cookies for authentication
├── public/             # Static web UI files
├── tests/              # All test files
└── package.json
```

---

# Part 1: Crawl Engine (server.js)

Common framework for all crawl tasks.

## Core Components

### 1. Task Management
- `saveTaskToDb(taskId, task)` - Persist task to MySQL
- `dbRowToTask(row)` - Convert DB row to task object (handles metadata)
- `loadTasksFromDb()` / `getTaskFromDb(taskId)` - Load tasks

### 2. Browser Management
- `getBrowserPid(browser)` - Get browser process PID
- `forceKillBrowser(pid)` - Force kill browser
- `runningBrowsers` Map - Track running browser instances
- `cleanupOrphanedBrowsers()` - Safety net for leaked processes

### 3. Error Handling
```javascript
handleTaskError({ taskId, task, error, browser, log, addScreenshot })
```
- Takes final screenshot (`error_final`)
- Logs final URL and page content preview
- Updates task status to 'error'
- Cleans up browser instance

### 4. Screenshot Storage
- `screenshots` Map - In-memory cache
- `saveScreenshotToDb()` / `loadScreenshotsFromDb()` - Persistence

## Database Schema

**Core columns** (queryable):
- `id`, `type`, `psm`, `env`, `status`, `start_time`, `end_time`

**Metadata column** (JSON, flexible):
```sql
metadata JSON  -- No ALTER TABLE needed for new fields
```

**Adding new fields:**
```javascript
const metadata = {
  api_group_id: task.api_group_id,
  new_field: task.new_field,  // Just add here!
  ...(task.metadata || {})
};
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List all tasks |
| GET | `/api/tasks/:id` | Get task details |
| PATCH | `/api/tasks/:id` | Update task params |
| POST | `/api/tasks/:id/restart` | Restart with optional param updates |
| POST | `/api/tasks/:id/stop` | Stop running task |
| DELETE | `/api/tasks/:id` | Delete task |
| GET | `/api/cookies` | Get stored cookies |
| POST | `/api/cookies` | Upload cookies |

## Adding New Task Types

```javascript
// new_task.js
function createTaskRunner(ctx) {
  const {
    screenshots, runningBrowsers, saveTaskToDb,
    handleTaskError,  // Always use this for errors
    loadCookies, convertToPuppeteerCookies,
    // ... other deps
  } = ctx;

  async function runTask(taskId, task, retryCount = 0) {
    let browser = null;
    try {
      // Task-specific logic
    } catch (error) {
      await handleTaskError({ taskId, task, error, browser, log, addScreenshot });
    }
  }
  return runTask;
}
module.exports = { createTaskRunner };
```

Then in `server.js`:
```javascript
const { createTaskRunner } = require('./new_task');
const runNewTask = createTaskRunner({ ...dependencies, handleTaskError });
```

---

# Part 2: Task Types

## Janus Mini Update (janus_mini.js)

Updates IDL branch configuration in Janus Mini.

### Parameters

| Field | Required | Description |
|-------|----------|-------------|
| `psm` | Yes | PSM name (e.g., `oec.reverse.strategy`) |
| `env` | Yes | Environment/lane (e.g., `boe_feat_system_deleete`) |
| `idl_branch` | Yes | IDL branch to set |
| `idl_version` | No | Specific IDL version to set (for version downgrade) |
| `api_group_id` | No | **Shortcut**: Skip list search, go directly to IDL config |

### Flow

**Without api_group_id (slow):**
1. Open Janus Mini list page
2. Wait for table to load (up to 60s)
3. Find PSM in list → Click
4. Navigate to IDL tab
5. Find environment row
6. Update IDL branch (and version if specified)
7. Click Deployment → Release

**With api_group_id (fast):**
1. Go directly to: `/janus/.../mini/{api_group_id}/tab/IdlConfig?lane={env}`
2. Update IDL branch (and version if specified)
3. Click Deployment → Release

### API Usage

```bash
# Create new task (with shortcut)
curl -X POST http://localhost:3456/api/tasks/janus \
  -H "Content-Type: application/json" \
  -d '{
    "psm": "oec.reverse.strategy",
    "env": "boe_feat_system_deleete",
    "idl_branch": "feat/sell_rule",
    "api_group_id": "340871"
  }'

# Restart failed task with new params
curl -X POST http://localhost:3456/api/tasks/janus_xxx/restart \
  -H "Content-Type: application/json" \
  -d '{"api_group_id": "340871"}'
```

### Known api_group_id Values

| PSM | api_group_id |
|-----|--------------|
| `oec.reverse.strategy` | `340871` |

---

## Janus Workorder Execute (janus_mini.js)

Executes a pending workorder (clicks "开始发布" and "确认" buttons).

### Parameters

| Field | Required | Description |
|-------|----------|-------------|
| `psm` | Yes | PSM name (e.g., `oec.reverse.strategy`) |
| `env` | Yes | Environment/lane (e.g., `boe_feat_system_deleete`) |
| `api_group_id` | Yes | API group ID (e.g., `340871`) - used to navigate directly to release history |

### Flow

1. Go directly to: `/janus/.../mini/{api_group_id}/tab/release_history?lane={env}`
2. Find first row with "Waiting" status in the PSM subgroup
3. Click the row to open workorder details
4. Wait for bits iframe to load
5. Find and click "开始发布" (Start publish) button in iframe
6. Wait for "完成确认" stage
7. Click "确认" (Confirm) button

### API Usage

```bash
curl -X POST http://localhost:3456/api/tasks/janus-workorder \
  -H "Content-Type: application/json" \
  -d '{
    "psm": "oec.reverse.strategy",
    "env": "boe_feat_system_deleete",
    "api_group_id": "340871"
  }'
```

---

# Part 3: Proxy Setup

## Why Proxy is Needed

Devbox can access `cloud-boe.bytedance.net` directly, but **cannot access CDN/SSO domains**.

## Domains Requiring Mac Proxy

| Domain | Reason |
|--------|--------|
| `cdn-tos.bytedance.net` | CDN |
| `sso.bytedance.com` | SSO |
| `office-cdn.bytedance.net` | CDN |
| `larksuitecdn.com` | CDN |

## Setup Steps

1. **On Mac:** `node mac_cdn_proxy.js`
2. **On Mac:** `ssh -R 9999:localhost:9999 yi.cheng1@devbox`
3. **On devbox:** Enable proxy via API or UI

## How It Works

```
Browser → Selective Proxy (8888)
              ↓
    CDN/SSO? → Mac Proxy (9999 via SSH) → Internet
    Other?  → Direct connection
```

---

# Part 4: Development

## Hot Reload
```bash
npm run dev    # node --watch-path=server.js --watch-path=janus_mini.js server.js
```

## Code Organization Rules
- Keep `server.js` lean (common utilities only)
- Task-specific logic in separate modules
- All tests in `tests/` folder
- Use `handleTaskError` for all error handling
- Use `metadata` JSON column for new fields (no ALTER TABLE)
