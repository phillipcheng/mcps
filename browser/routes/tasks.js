/**
 * Task management routes
 */

const express = require('express');
const { loadTasksFromDb, getTaskFromDb, saveTaskToDb, deleteTaskFromDb, batchDeleteTasksFromDb, dbRowToTask } = require('../database/tasks');
const { loadScreenshotsFromDb, deleteScreenshotsFromDb } = require('../database/screenshots');
const { findTaskType } = require('../database/task-types');
const { getBuiltInTaskType, getBuiltInTaskTypes } = require('../tasks');
const { forceKillBrowser } = require('../engine/utils');
const { getPool } = require('../database');

const router = express.Router();

/**
 * Create task routes with injected dependencies
 */
function createTaskRoutes(ctx) {
  const { tasks, screenshots, runningBrowsers, taskRunners, browserPool } = ctx;

  // GET /api/builtin-types - Get built-in task types
  router.get('/builtin-types', (req, res) => {
    res.json(getBuiltInTaskTypes());
  });

  // GET /api/tasks - Get all tasks
  router.get('/', async (req, res) => {
    try {
      const { psm, idl_branch, status } = req.query;
      const dbTasks = await loadTasksFromDb();

      // Merge with in-memory tasks
      const memoryTasks = Array.from(tasks.entries()).map(([id, task]) => ({
        id,
        type: task.type,
        name: task.name,
        psm: task.psm,
        env: task.env,
        idl_branch: task.idl_branch,
        idl_version: task.idl_version,
        api_group_id: task.api_group_id,
        dry_run: task.dry_run,
        status: task.status,
        stage: task.stage,
        result: task.result,
        error: task.error,
        startTime: task.startTime,
        endTime: task.endTime,
        subtasks: task.subtasks,
        currentIndex: task.currentIndex
      }));

      const taskMap = new Map();
      dbTasks.forEach(t => taskMap.set(t.id, t));
      memoryTasks.forEach(t => taskMap.set(t.id, t));

      let taskList = Array.from(taskMap.values());
      taskList = taskList.filter(t => !t.id.includes('_sub'));

      if (psm) taskList = taskList.filter(t => t.psm && t.psm.toLowerCase().includes(psm.toLowerCase()));
      if (idl_branch) taskList = taskList.filter(t => t.idl_branch && t.idl_branch.toLowerCase().includes(idl_branch.toLowerCase()));
      if (status) taskList = taskList.filter(t => t.status === status);

      taskList.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
      res.json(taskList);
    } catch (error) {
      console.error('[API] Get tasks error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/tasks/:id - Get single task
  router.get('/:id', async (req, res) => {
    let task = tasks.get(req.params.id);
    if (!task) task = await getTaskFromDb(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Inject real-time logs for running chained tasks
    if ((task.isChained || task.subtasks) && task.status === 'running' && task.subtasks) {
      const taskCopy = JSON.parse(JSON.stringify(task));
      for (let i = 0; i < taskCopy.subtasks.length; i++) {
        const subtask = taskCopy.subtasks[i];
        if (subtask.status === 'running') {
          const tempTaskId = `${req.params.id}_sub${i}`;
          const tempTask = tasks.get(tempTaskId);
          if (tempTask && tempTask.logs) {
            subtask.logs = tempTask.logs;
            subtask.stage = tempTask.stage;
          }
        }
      }
      return res.json({ id: req.params.id, ...taskCopy });
    }

    res.json({ id: req.params.id, ...task });
  });

  // POST /api/tasks - Create task (unified endpoint)
  router.post('/', async (req, res) => {
    const { type, parameters = {} } = req.body;
    if (!type) return res.status(400).json({ error: 'type is required' });

    try {
      const builtIn = getBuiltInTaskType(type);

      if (builtIn) {
        // Validate required parameters
        for (const param of builtIn.params) {
          if (param.required && !parameters[param.key]) {
            return res.status(400).json({ error: `Missing required parameter: ${param.key}` });
          }
        }

        const taskId = `${type}_${Date.now()}`;
        const task = {
          type: builtIn.internalType,
          psm: parameters.psm,
          env: parameters.env,
          idl_branch: parameters.idl_branch || null,
          idl_version: parameters.idl_version || null,
          api_group_id: parameters.api_group_id || null,
          dry_run: parameters.dry_run !== false,
          status: 'running',
          logs: [],
          startTime: new Date().toISOString(),
          endTime: null,
          error: null
        };

        tasks.set(taskId, task);
        screenshots.set(taskId, []);
        await saveTaskToDb(taskId, task);

        res.json({ taskId, status: 'started', type: builtIn.internalType });

        // Run task
        taskRunners.runTask(builtIn.internalType, taskId, task).catch(async (err) => {
          task.status = 'error';
          task.error = err.message;
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
        });

      } else {
        // Check for custom task type
        const taskType = await findTaskType(type);
        if (!taskType) {
          return res.status(404).json({
            error: 'Unknown task type: ' + type,
            availableBuiltIn: getBuiltInTaskTypes().map(t => t.id)
          });
        }

        // Create chained task from custom type
        const resolvedSubtasks = taskType.subtasks.map(st => {
          const resolved = {};
          for (const [key, value] of Object.entries(st)) {
            if (typeof value === 'string' && value.includes('${')) {
              let substituted = value.replace(/\$\{(\w+)\}/g, (match, paramName) => {
                return parameters[paramName] !== undefined ? parameters[paramName] : '';
              });
              if (substituted.trim()) resolved[key] = substituted.trim();
            } else {
              resolved[key] = value;
            }
          }
          return resolved;
        });

        const taskId = `chained_${Date.now()}`;
        const task = {
          type: taskType.name,
          name: parameters.name || taskType.name,
          isChained: true,
          subtasks: resolvedSubtasks.map((st, i) => ({
            type: st.type === 'janus' ? 'janus_mini_update' : st.type === 'workorder' ? 'janus_workorder_execute' : st.type,
            psm: st.psm,
            env: st.env,
            idl_branch: st.idl_branch,
            idl_version: st.idl_version,
            api_group_id: st.api_group_id,
            index: i,
            status: 'pending',
            logs: [],
            startTime: null,
            endTime: null,
            error: null,
            result: null
          })),
          currentIndex: 0,
          status: 'running',
          logs: [`[${new Date().toISOString()}] Task created from type: ${taskType.name}`],
          startTime: new Date().toISOString(),
          endTime: null,
          error: null
        };

        tasks.set(taskId, task);
        screenshots.set(taskId, []);
        await saveTaskToDb(taskId, task);

        res.json({ taskId, status: 'started', type: 'custom', taskTypeName: taskType.name });

        taskRunners.runChainedTask(taskId, task).catch(async (err) => {
          task.status = 'error';
          task.error = err.message;
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
        });
      }

    } catch (error) {
      console.error('[API] Create task error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // PATCH /api/tasks/:id - Update task
  router.patch('/:id', async (req, res) => {
    const taskId = req.params.id;
    const updates = req.body;

    try {
      let task = tasks.get(taskId);
      if (!task) task = await getTaskFromDb(taskId);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (task.status === 'running') return res.status(400).json({ error: 'Cannot update running task' });

      if (task.isChained || task.subtasks) {
        if (updates.name !== undefined) task.name = updates.name;
        if (updates.type !== undefined) task.type = updates.type;
        if (updates.subtasks !== undefined && Array.isArray(updates.subtasks)) {
          task.subtasks = updates.subtasks.map(st => ({
            type: st.type === 'janus' ? 'janus_mini_update' : st.type === 'workorder' ? 'janus_workorder_execute' : st.type,
            psm: st.psm,
            env: st.env,
            idl_branch: st.idl_branch,
            idl_version: st.idl_version,
            api_group_id: st.api_group_id,
            status: 'pending',
            logs: [],
            startTime: null,
            endTime: null,
            error: null,
            result: null
          }));
          task.currentIndex = 0;
        }
      } else {
        const allowedFields = ['psm', 'env', 'idl_branch', 'idl_version', 'api_group_id', 'dry_run'];
        for (const field of allowedFields) {
          if (updates[field] !== undefined) task[field] = updates[field];
        }
      }

      tasks.set(taskId, task);
      await saveTaskToDb(taskId, task);
      res.json({ success: true, task });
    } catch (error) {
      console.error('[API] Update task error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/tasks/:id - Delete task
  router.delete('/:id', async (req, res) => {
    const taskId = req.params.id;

    try {
      const memTask = tasks.get(taskId);
      if (memTask && memTask.status === 'running') {
        return res.status(400).json({ error: 'Cannot delete running task' });
      }

      tasks.delete(taskId);
      screenshots.delete(taskId);
      await deleteScreenshotsFromDb(taskId);
      await deleteTaskFromDb(taskId);

      res.json({ success: true, deleted: taskId });
    } catch (error) {
      console.error('[API] Delete task error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/tasks/batch-delete - Batch delete tasks
  router.post('/batch-delete', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }

    try {
      const deleted = [];
      const skipped = [];

      for (const taskId of ids) {
        const memTask = tasks.get(taskId);
        if (memTask && memTask.status === 'running') {
          skipped.push({ id: taskId, reason: 'running' });
          continue;
        }

        tasks.delete(taskId);
        screenshots.delete(taskId);
        await deleteScreenshotsFromDb(taskId);
        deleted.push(taskId);
      }

      await batchDeleteTasksFromDb(deleted);

      res.json({
        success: true,
        deleted,
        skipped,
        deletedCount: deleted.length,
        skippedCount: skipped.length
      });
    } catch (error) {
      console.error('[API] Batch delete error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/tasks/:id/stop - Stop running task
  router.post('/:id/stop', async (req, res) => {
    const taskId = req.params.id;

    try {
      const task = tasks.get(taskId);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (task.status !== 'running') return res.status(400).json({ error: 'Task is not running' });

      const browserInfo = runningBrowsers.get(taskId);
      if (browserInfo) {
        try {
          await browserInfo.browser.close();
        } catch (e) {
          if (browserInfo.pid) forceKillBrowser(browserInfo.pid);
        }
        runningBrowsers.delete(taskId);
      }

      // Stop subtasks if chained
      if (task.isChained || task.subtasks) {
        for (let i = 0; i < (task.subtasks || []).length; i++) {
          const subtaskId = `${taskId}_sub${i}`;
          const subtask = task.subtasks[i];

          const subtaskBrowserInfo = runningBrowsers.get(subtaskId);
          if (subtaskBrowserInfo) {
            try { await subtaskBrowserInfo.browser.close(); } catch (e) {
              if (subtaskBrowserInfo.pid) forceKillBrowser(subtaskBrowserInfo.pid);
            }
            runningBrowsers.delete(subtaskId);
          }

          if (subtask && (subtask.status === 'running' || subtask.status === 'pending')) {
            subtask.status = 'stopped';
            subtask.error = 'Parent task stopped by user';
            subtask.endTime = new Date().toISOString();
          }

          const tempTask = tasks.get(subtaskId);
          if (tempTask) {
            tempTask.status = 'stopped';
            tasks.delete(subtaskId);
          }
        }
      }

      task.status = 'stopped';
      task.error = 'Task stopped by user';
      task.endTime = new Date().toISOString();
      task.logs.push(`[${new Date().toISOString()}] Task stopped by user`);
      await saveTaskToDb(taskId, task);

      res.json({ success: true, taskId, status: 'stopped' });
    } catch (error) {
      console.error('[API] Stop task error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/tasks/:id/restart - Restart task
  router.post('/:id/restart', async (req, res) => {
    const taskId = req.params.id;
    const updates = req.body || {};

    try {
      let task = tasks.get(taskId);
      if (!task) {
        const dbPool = getPool();
        if (dbPool) {
          const [rows] = await dbPool.query('SELECT * FROM janus_tasks WHERE id = ?', [taskId]);
          if (rows.length > 0) task = dbRowToTask(rows[0]);
        }
      }

      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (task.status === 'running') return res.status(400).json({ error: 'Task is already running' });

      // Apply updates
      const allowedFields = ['psm', 'env', 'idl_branch', 'idl_version', 'dry_run', 'api_group_id', 'name'];
      for (const field of allowedFields) {
        if (updates[field] !== undefined) task[field] = updates[field];
      }

      if (updates.subtasks !== undefined && Array.isArray(updates.subtasks)) {
        task.subtasks = updates.subtasks.map(st => ({
          type: st.type === 'janus' ? 'janus_mini_update' : st.type === 'workorder' ? 'janus_workorder_execute' : st.type,
          psm: st.psm,
          env: st.env,
          idl_branch: st.idl_branch,
          idl_version: st.idl_version,
          api_group_id: st.api_group_id,
          status: 'pending',
          logs: [],
          startTime: null,
          endTime: null,
          error: null,
          result: null
        }));
      }

      // Reset task state
      task.status = 'running';
      task.error = null;
      task.startTime = new Date().toISOString();
      task.endTime = null;
      task.logs = [`[${new Date().toISOString()}] Task restarted`];

      if ((task.isChained || task.subtasks) && task.subtasks) {
        for (const subtask of task.subtasks) {
          subtask.status = 'pending';
          subtask.logs = [];
          subtask.startTime = null;
          subtask.endTime = null;
          subtask.error = null;
          subtask.result = null;
        }
        task.currentIndex = 0;
      }

      tasks.set(taskId, task);
      screenshots.set(taskId, []);
      await deleteScreenshotsFromDb(taskId);
      await saveTaskToDb(taskId, task);

      res.json({ taskId, status: 'restarted' });

      // Run task
      if (task.isChained || task.subtasks) {
        taskRunners.runChainedTask(taskId, task).catch(async (err) => {
          task.status = 'error';
          task.error = err.message;
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
        });
      } else if (task.type === 'janus_workorder_execute') {
        taskRunners.runWorkorderTask(taskId, task).catch(async (err) => {
          task.status = 'error';
          task.error = err.message;
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
        });
      } else {
        taskRunners.runJanusTask(taskId, task).catch(async (err) => {
          task.status = 'error';
          task.error = err.message;
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
        });
      }

    } catch (error) {
      console.error('[API] Restart task error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/tasks/:id/screenshots - Get task screenshots
  router.get('/:id/screenshots', async (req, res) => {
    const taskId = req.params.id;
    let taskScreenshots = screenshots.get(taskId);
    if (!taskScreenshots || taskScreenshots.length === 0) {
      taskScreenshots = await loadScreenshotsFromDb(taskId);
    }
    res.json((taskScreenshots || []).map(ss => ({ label: ss.label, time: ss.time })));
  });

  // GET /api/tasks/:id/screenshots/:index - Get specific screenshot
  router.get('/:id/screenshots/:index', async (req, res) => {
    const taskId = req.params.id;
    const index = parseInt(req.params.index);

    let taskScreenshots = screenshots.get(taskId);
    if (!taskScreenshots || taskScreenshots.length === 0) {
      taskScreenshots = await loadScreenshotsFromDb(taskId);
    }

    if (!taskScreenshots || index < 0 || index >= taskScreenshots.length) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    const ss = taskScreenshots[index];
    const img = Buffer.from(ss.data, 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': img.length
    });
    res.end(img);
  });

  // POST /api/browsers/kill-all - Kill all browsers
  router.post('/browsers/kill-all', async (req, res) => {
    try {
      let killed = 0;

      for (const [taskId, browserInfo] of runningBrowsers) {
        try {
          await browserInfo.browser.close();
        } catch (e) {
          if (browserInfo.pid) forceKillBrowser(browserInfo.pid);
        }
        killed++;

        const task = tasks.get(taskId);
        if (task && task.status === 'running') {
          task.status = 'stopped';
          task.error = 'Browser killed by admin';
          task.endTime = new Date().toISOString();
          await saveTaskToDb(taskId, task);
        }
      }
      runningBrowsers.clear();

      res.json({ success: true, killed, message: `Killed ${killed} browser processes` });
    } catch (error) {
      console.error('[API] Kill all browsers error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createTaskRoutes };
