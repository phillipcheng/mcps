/**
 * Screenshot database operations
 */

const { getPool } = require('./index');

/**
 * Save screenshot to database
 * @param {string} taskId - Task ID
 * @param {number} index - Screenshot index
 * @param {string} label - Screenshot label
 * @param {string} data - Base64 screenshot data
 */
async function saveScreenshotToDb(taskId, index, label, data) {
  const dbPool = getPool();
  if (!dbPool) return;

  try {
    await dbPool.execute(`
      INSERT INTO janus_screenshots (task_id, screenshot_index, label, data, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `, [taskId, index, label, data]);
  } catch (error) {
    console.error('[DB] Save screenshot error:', error.message);
  }
}

/**
 * Load screenshots from database
 * @param {string} taskId - Task ID
 * @returns {Promise<Array>} Array of screenshots
 */
async function loadScreenshotsFromDb(taskId) {
  const dbPool = getPool();
  if (!dbPool) return [];

  try {
    const [rows] = await dbPool.execute(
      'SELECT screenshot_index, label, data, created_at FROM janus_screenshots WHERE task_id = ? ORDER BY screenshot_index',
      [taskId]
    );
    return rows.map(row => ({
      label: row.label,
      data: row.data,
      time: row.created_at ? row.created_at.toISOString() : null
    }));
  } catch (error) {
    console.error('[DB] Load screenshots error:', error.message);
    return [];
  }
}

/**
 * Delete screenshots from database
 * @param {string} taskId - Task ID
 */
async function deleteScreenshotsFromDb(taskId) {
  const dbPool = getPool();
  if (!dbPool) return;

  try {
    await dbPool.execute('DELETE FROM janus_screenshots WHERE task_id = ?', [taskId]);
  } catch (error) {
    console.error('[DB] Delete screenshots error:', error.message);
  }
}

module.exports = {
  saveScreenshotToDb,
  loadScreenshotsFromDb,
  deleteScreenshotsFromDb
};
