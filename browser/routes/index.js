/**
 * Routes aggregator
 */

const express = require('express');
const cookieRoutes = require('./cookies');
const proxyRoutes = require('./proxy');
const browseRoutes = require('./browse');
const { createBrowserRoutes } = require('./browser');
const { createTaskRoutes } = require('./tasks');
const { createTaskTypeRoutes } = require('./task-types');

/**
 * Create all routes with injected context
 * @param {Object} ctx - Context with dependencies
 * @returns {Router} Express router
 */
function createRoutes(ctx) {
  const router = express.Router();

  // Static routes
  router.use('/api/cookies', cookieRoutes);
  router.use('/api/proxy', proxyRoutes);
  router.use('/api/browse', browseRoutes);

  // Dynamic routes with context
  router.use('/api/browser', createBrowserRoutes(ctx.browserPool));
  router.use('/api/tasks', createTaskRoutes(ctx));
  router.use('/api/task-types', createTaskTypeRoutes(ctx));

  // Legacy endpoints - redirect to unified endpoint
  router.post('/api/tasks/janus', async (req, res) => {
    const { psm, env, idl_branch, dry_run = true, api_group_id, idl_version } = req.body;

    if (!psm || !env || !idl_branch) {
      return res.status(400).json({ error: 'psm, env, and idl_branch are required' });
    }

    // Forward to unified endpoint
    req.body = {
      type: 'janus',
      parameters: { psm, env, idl_branch, dry_run, api_group_id, idl_version }
    };

    // Call the unified tasks router
    const { tasks, screenshots, taskRunners } = ctx;
    const { saveTaskToDb } = require('../database/tasks');
    const { getBuiltInTaskType } = require('../tasks');

    const builtIn = getBuiltInTaskType('janus');
    const taskId = `janus_${Date.now()}`;
    const task = {
      type: builtIn.internalType,
      psm, env, idl_branch,
      idl_version: idl_version || null,
      api_group_id: api_group_id || null,
      dry_run,
      status: 'running',
      logs: [],
      startTime: new Date().toISOString(),
      endTime: null,
      error: null
    };

    tasks.set(taskId, task);
    screenshots.set(taskId, []);
    await saveTaskToDb(taskId, task);

    res.json({ taskId, status: 'started' });

    taskRunners.runJanusTask(taskId, task).catch(async (err) => {
      task.status = 'error';
      task.error = err.message;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);
    });
  });

  router.post('/api/tasks/janus-workorder', async (req, res) => {
    const { psm, env, api_group_id } = req.body;

    if (!psm || !env || !api_group_id) {
      return res.status(400).json({ error: 'psm, env (lane), and api_group_id are required' });
    }

    const { tasks, screenshots, taskRunners } = ctx;
    const { saveTaskToDb } = require('../database/tasks');

    const taskId = `workorder_${Date.now()}`;
    const task = {
      type: 'janus_workorder_execute',
      psm, env, api_group_id,
      status: 'running',
      logs: [],
      startTime: new Date().toISOString(),
      endTime: null,
      error: null
    };

    tasks.set(taskId, task);
    screenshots.set(taskId, []);
    await saveTaskToDb(taskId, task);

    res.json({ taskId, status: 'started' });

    taskRunners.runWorkorderTask(taskId, task).catch(async (err) => {
      task.status = 'error';
      task.error = err.message;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);
    });
  });

  router.post('/api/tasks/chained', async (req, res) => {
    const { name, subtasks } = req.body;

    if (!subtasks || !Array.isArray(subtasks) || subtasks.length === 0) {
      return res.status(400).json({ error: 'subtasks array is required and must not be empty' });
    }

    const { tasks, screenshots, taskRunners } = ctx;
    const { saveTaskToDb } = require('../database/tasks');

    const taskId = `chained_${Date.now()}`;
    const task = {
      type: req.body.type || 'chained',
      isChained: true,
      name: name || `Chain of ${subtasks.length} tasks`,
      subtasks: subtasks.map((st, i) => ({
        ...st,
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
      logs: [],
      startTime: new Date().toISOString(),
      endTime: null,
      error: null
    };

    tasks.set(taskId, task);
    screenshots.set(taskId, []);
    await saveTaskToDb(taskId, task);

    res.json({ taskId, status: 'started', subtaskCount: subtasks.length });

    taskRunners.runChainedTask(taskId, task).catch(async (err) => {
      task.status = 'error';
      task.error = err.message;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);
    });
  });

  // GET /api/tasks/janus-info - Get Janus Mini version info (read-only)
  router.post('/api/tasks/janus-info', async (req, res) => {
    const { psm, env, idl_branch, api_group_id } = req.body;

    if (!psm || !env || !idl_branch) {
      return res.status(400).json({ error: 'psm, env (lane), and idl_branch are required' });
    }

    const { tasks, screenshots, taskRunners } = ctx;
    const { saveTaskToDb } = require('../database/tasks');

    const taskId = `janus_info_${Date.now()}`;
    const task = {
      type: 'get_janus_mini',
      psm,
      env,
      idl_branch,
      api_group_id: api_group_id || null,
      status: 'running',
      logs: [],
      startTime: new Date().toISOString(),
      endTime: null,
      error: null,
      metadata: {}
    };

    tasks.set(taskId, task);
    screenshots.set(taskId, []);
    await saveTaskToDb(taskId, task);

    res.json({ taskId, status: 'started' });

    taskRunners.runJanusInfoTask(taskId, task).catch(async (err) => {
      task.status = 'error';
      task.error = err.message;
      task.endTime = new Date().toISOString();
      await saveTaskToDb(taskId, task);
    });
  });

  return router;
}

module.exports = { createRoutes };
