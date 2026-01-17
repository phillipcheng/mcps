/**
 * Task runners registry and factory
 */

const { createJanusTaskRunner } = require('./janus-runner');
const { createWorkorderTaskRunner } = require('./workorder-runner');
const { createChainedTaskRunner } = require('./chained-runner');
const { createJanusInfoRunner } = require('./janus-info-runner');
const { createReleaseMonitorRunner } = require('./release-monitor-runner');

/**
 * Built-in task type definitions
 */
const builtInTaskTypes = {
  janus: {
    name: 'Janus Mini Update',
    internalType: 'janus_mini_update',
    params: [
      { key: 'psm', label: 'PSM', required: true },
      { key: 'env', label: 'Environment', required: true },
      { key: 'idl_branch', label: 'IDL Branch', required: true },
      { key: 'idl_version', label: 'IDL Version', required: false },
      { key: 'api_group_id', label: 'API Group ID', required: false }
    ],
    runner: 'janus'
  },
  workorder: {
    name: 'Execute Workorder',
    internalType: 'janus_workorder_execute',
    params: [
      { key: 'psm', label: 'PSM', required: true },
      { key: 'env', label: 'Environment', required: true },
      { key: 'api_group_id', label: 'API Group ID', required: true }
    ],
    runner: 'workorder'
  },
  janus_info: {
    name: 'Get Janus Mini Info',
    internalType: 'get_janus_mini',
    params: [
      { key: 'psm', label: 'PSM', required: true },
      { key: 'env', label: 'Environment (Lane)', required: true },
      { key: 'idl_branch', label: 'IDL Branch', required: true },
      { key: 'api_group_id', label: 'API Group ID', required: false }
    ],
    runner: 'janus_info'
  },
  release_monitor: {
    name: 'Monitor Release Pipeline',
    internalType: 'release_monitor',
    params: [
      { key: 'task_name', label: 'Dev Task Name', required: true }
    ],
    runner: 'release_monitor'
  }
};

/**
 * Get built-in task types for API
 * @returns {Array} Task type definitions
 */
function getBuiltInTaskTypes() {
  return Object.entries(builtInTaskTypes).map(([key, def]) => ({
    id: key,
    name: def.name,
    params: def.params
  }));
}

/**
 * Get built-in task type by key
 * @param {string} key - Task type key
 * @returns {Object|null} Task type definition
 */
function getBuiltInTaskType(key) {
  return builtInTaskTypes[key] || null;
}

/**
 * Create all task runners with injected context
 * @param {Object} ctx - Context with dependencies
 * @returns {Object} Task runners
 */
function createTaskRunners(ctx) {
  const runJanusTask = createJanusTaskRunner(ctx);
  const runWorkorderTask = createWorkorderTaskRunner(ctx);
  const runJanusInfoTask = createJanusInfoRunner(ctx);
  const runReleaseMonitorTask = createReleaseMonitorRunner(ctx);
  const runChainedTask = createChainedTaskRunner(ctx, runJanusTask, runWorkorderTask);

  return {
    runJanusTask,
    runWorkorderTask,
    runJanusInfoTask,
    runReleaseMonitorTask,
    runChainedTask,

    /**
     * Run a task by type
     * @param {string} type - Task type
     * @param {string} taskId - Task ID
     * @param {Object} task - Task object
     */
    async runTask(type, taskId, task) {
      if (task.isChained || task.subtasks) {
        return runChainedTask(taskId, task);
      }

      switch (type) {
        case 'janus':
        case 'janus_mini_update':
          return runJanusTask(taskId, task);
        case 'workorder':
        case 'janus_workorder_execute':
          return runWorkorderTask(taskId, task);
        case 'janus_info':
        case 'get_janus_mini':
          return runJanusInfoTask(taskId, task);
        case 'release_monitor':
          return runReleaseMonitorTask(taskId, task);
        default:
          throw new Error(`Unknown task type: ${type}`);
      }
    }
  };
}

module.exports = {
  createJanusTaskRunner,
  createWorkorderTaskRunner,
  createChainedTaskRunner,
  createJanusInfoRunner,
  createReleaseMonitorRunner,
  createTaskRunners,
  getBuiltInTaskTypes,
  getBuiltInTaskType,
  builtInTaskTypes
};
