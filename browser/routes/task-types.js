/**
 * Task type definition routes
 */

const express = require('express');
const { getTaskTypes, getTaskType, createTaskType, updateTaskType, deleteTaskType } = require('../database/task-types');
const { saveTaskToDb } = require('../database/tasks');

const router = express.Router();

/**
 * Create task type routes with injected dependencies
 */
function createTaskTypeRoutes(ctx) {
  const { tasks, screenshots, taskRunners } = ctx;

  // GET /api/task-types - List all task types
  router.get('/', async (req, res) => {
    try {
      const types = await getTaskTypes();
      res.json(types);
    } catch (error) {
      console.error('[API] Get task types error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/task-types/:id - Get single task type
  router.get('/:id', async (req, res) => {
    try {
      const taskType = await getTaskType(req.params.id);
      if (!taskType) {
        return res.status(404).json({ error: 'Task type not found' });
      }
      res.json(taskType);
    } catch (error) {
      console.error('[API] Get task type error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/task-types - Create task type
  router.post('/', async (req, res) => {
    const { name, description, parameters, subtasks } = req.body;

    if (!name || !parameters || !subtasks) {
      return res.status(400).json({ error: 'name, parameters, and subtasks are required' });
    }

    try {
      const id = await createTaskType({ name, description, parameters, subtasks });
      res.json({ id, name, status: 'created' });
    } catch (error) {
      console.error('[API] Create task type error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // PATCH /api/task-types/:id - Update task type
  router.patch('/:id', async (req, res) => {
    const { name, description, parameters, subtasks } = req.body;
    const id = req.params.id;

    try {
      await updateTaskType(id, { name, description, parameters, subtasks });
      res.json({ id, status: 'updated' });
    } catch (error) {
      console.error('[API] Update task type error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/task-types/:id - Delete task type
  router.delete('/:id', async (req, res) => {
    try {
      await deleteTaskType(req.params.id);
      res.json({ success: true, deleted: req.params.id });
    } catch (error) {
      console.error('[API] Delete task type error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/task-types/:id/create-task - Create task from type
  router.post('/:id/create-task', async (req, res) => {
    const typeId = req.params.id;
    const params = req.body;

    try {
      const taskType = await getTaskType(typeId);
      if (!taskType) {
        return res.status(404).json({ error: 'Task type not found' });
      }

      // Validate required parameters
      for (const param of taskType.parameters) {
        if (param.required && !params[param.name]) {
          return res.status(400).json({ error: `Missing required parameter: ${param.name}` });
        }
      }

      // Build subtasks by substituting parameters
      const resolvedSubtasks = taskType.subtasks.map(st => {
        const resolved = {};
        for (const [key, value] of Object.entries(st)) {
          if (typeof value === 'string' && value.includes('${')) {
            let substituted = value.replace(/\$\{(\w+)\}/g, (match, paramName) => {
              return params[paramName] !== undefined ? params[paramName] : '';
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
        type: 'chained',
        name: params.name || taskType.name,
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

      res.json({ taskId, status: 'started', subtaskCount: task.subtasks.length, taskTypeName: taskType.name });

      // Run the chained task
      taskRunners.runChainedTask(taskId, task).catch(async (err) => {
        task.status = 'error';
        task.error = err.message;
        task.endTime = new Date().toISOString();
        await saveTaskToDb(taskId, task);
      });
    } catch (error) {
      console.error('[API] Create task from type error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createTaskTypeRoutes };
