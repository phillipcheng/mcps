/**
 * Task database operations
 */

const { getPool } = require('./index');

/**
 * Convert DB row to task object (handles metadata)
 * @param {Object} row - Database row
 * @returns {Object} Task object
 */
function dbRowToTask(row) {
  let metadata = {};
  try {
    metadata = row.metadata ?
      (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {};
  } catch (e) { /* ignore */ }

  return {
    id: row.id,
    type: row.type,
    name: metadata.name || null,
    psm: row.psm,
    env: row.env,
    idl_branch: row.idl_branch,
    idl_version: metadata.idl_version || null,
    dry_run: row.dry_run === 1 || row.dry_run === true,
    api_group_id: row.api_group_id || metadata.api_group_id || null,
    status: row.status,
    stage: row.stage || metadata.stage || null,
    result: row.result || metadata.result || null,
    error: row.error,
    logs: row.logs ? (typeof row.logs === 'string' ? JSON.parse(row.logs) : row.logs) : [],
    startTime: row.start_time ?
      (row.start_time instanceof Date ? row.start_time.toISOString() : row.start_time) : null,
    endTime: row.end_time ?
      (row.end_time instanceof Date ? row.end_time.toISOString() : row.end_time) : null,
    subtasks: metadata.subtasks || null,
    currentIndex: metadata.currentIndex || 0,
    isChained: metadata.isChained || (metadata.subtasks ? true : false),
    metadata
  };
}

/**
 * Save task to database
 * @param {string} taskId - Task ID
 * @param {Object} task - Task object
 */
async function saveTaskToDb(taskId, task) {
  const dbPool = getPool();
  if (!dbPool) return;

  try {
    const metadata = {
      api_group_id: task.api_group_id || null,
      stage: task.stage || null,
      result: task.result || null,
      name: task.name || null,
      idl_version: task.idl_version || null,
      subtasks: task.subtasks || null,
      currentIndex: task.currentIndex || 0,
      isChained: task.isChained || false,
      ...(task.metadata || {})
    };

    await dbPool.execute(`
      INSERT INTO janus_tasks (id, type, psm, env, idl_branch, dry_run, api_group_id, status, stage, result, error, logs, start_time, end_time, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        psm = VALUES(psm),
        env = VALUES(env),
        idl_branch = VALUES(idl_branch),
        dry_run = VALUES(dry_run),
        api_group_id = VALUES(api_group_id),
        status = VALUES(status),
        stage = VALUES(stage),
        result = VALUES(result),
        error = VALUES(error),
        logs = VALUES(logs),
        end_time = VALUES(end_time),
        metadata = VALUES(metadata)
    `, [
      taskId,
      task.type || null,
      task.psm || null,
      task.env || null,
      task.idl_branch || null,
      task.dry_run !== undefined ? task.dry_run : null,
      task.api_group_id || null,
      task.status || null,
      task.stage || null,
      task.result || null,
      task.error || null,
      JSON.stringify(task.logs || []),
      task.startTime ? new Date(task.startTime) : null,
      task.endTime ? new Date(task.endTime) : null,
      JSON.stringify(metadata)
    ]);
  } catch (error) {
    console.error('[DB] Save task error:', error.message);
  }
}

/**
 * Load tasks from database
 * @returns {Promise<Array>} Array of tasks
 */
async function loadTasksFromDb() {
  const dbPool = getPool();
  if (!dbPool) return [];

  try {
    const [rows] = await dbPool.execute('SELECT * FROM janus_tasks ORDER BY created_at DESC LIMIT 100');
    return rows.map(dbRowToTask);
  } catch (error) {
    console.error('[DB] Load tasks error:', error.message);
    return [];
  }
}

/**
 * Get single task from database
 * @param {string} taskId - Task ID
 * @returns {Promise<Object|null>} Task object or null
 */
async function getTaskFromDb(taskId) {
  const dbPool = getPool();
  if (!dbPool) return null;

  try {
    const [rows] = await dbPool.execute('SELECT * FROM janus_tasks WHERE id = ?', [taskId]);
    if (rows.length === 0) return null;
    return dbRowToTask(rows[0]);
  } catch (error) {
    console.error('[DB] Get task error:', error.message);
    return null;
  }
}

/**
 * Delete task from database
 * @param {string} taskId - Task ID
 */
async function deleteTaskFromDb(taskId) {
  const dbPool = getPool();
  if (!dbPool) return;

  try {
    await dbPool.execute('DELETE FROM janus_tasks WHERE id = ?', [taskId]);
  } catch (error) {
    console.error('[DB] Delete task error:', error.message);
  }
}

/**
 * Batch delete tasks from database
 * @param {Array<string>} taskIds - Array of task IDs
 */
async function batchDeleteTasksFromDb(taskIds) {
  const dbPool = getPool();
  if (!dbPool || taskIds.length === 0) return;

  try {
    const placeholders = taskIds.map(() => '?').join(',');
    await dbPool.execute(`DELETE FROM janus_tasks WHERE id IN (${placeholders})`, taskIds);
  } catch (error) {
    console.error('[DB] Batch delete tasks error:', error.message);
  }
}

module.exports = {
  dbRowToTask,
  saveTaskToDb,
  loadTasksFromDb,
  getTaskFromDb,
  deleteTaskFromDb,
  batchDeleteTasksFromDb
};
