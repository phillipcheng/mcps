/**
 * Task type definition database operations
 */

const { getPool } = require('./index');

/**
 * Get all task types from database
 * @returns {Promise<Array>} Array of task types
 */
async function getTaskTypes() {
  const dbPool = getPool();
  if (!dbPool) return [];

  try {
    const [rows] = await dbPool.execute('SELECT * FROM janus_task_types ORDER BY name');
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters) : row.parameters,
      subtasks: typeof row.subtasks === 'string' ? JSON.parse(row.subtasks) : row.subtasks,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  } catch (error) {
    console.error('[DB] Get task types error:', error.message);
    return [];
  }
}

/**
 * Get single task type from database
 * @param {string} typeId - Task type ID
 * @returns {Promise<Object|null>} Task type or null
 */
async function getTaskType(typeId) {
  const dbPool = getPool();
  if (!dbPool) return null;

  try {
    const [rows] = await dbPool.execute('SELECT * FROM janus_task_types WHERE id = ?', [typeId]);
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters) : row.parameters,
      subtasks: typeof row.subtasks === 'string' ? JSON.parse(row.subtasks) : row.subtasks,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  } catch (error) {
    console.error('[DB] Get task type error:', error.message);
    return null;
  }
}

/**
 * Create task type in database
 * @param {Object} data - Task type data {id, name, description, parameters, subtasks}
 * @returns {Promise<string>} Created task type ID
 */
async function createTaskType(data) {
  const dbPool = getPool();
  if (!dbPool) throw new Error('Database not connected');

  const id = data.id || `tasktype_${Date.now()}`;

  await dbPool.execute(
    'INSERT INTO janus_task_types (id, name, description, parameters, subtasks) VALUES (?, ?, ?, ?, ?)',
    [id, data.name, data.description || null, JSON.stringify(data.parameters), JSON.stringify(data.subtasks)]
  );

  return id;
}

/**
 * Update task type in database
 * @param {string} typeId - Task type ID
 * @param {Object} updates - Fields to update
 */
async function updateTaskType(typeId, updates) {
  const dbPool = getPool();
  if (!dbPool) return;

  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.parameters !== undefined) {
    fields.push('parameters = ?');
    values.push(JSON.stringify(updates.parameters));
  }
  if (updates.subtasks !== undefined) {
    fields.push('subtasks = ?');
    values.push(JSON.stringify(updates.subtasks));
  }

  if (fields.length === 0) return;

  values.push(typeId);
  await dbPool.execute(`UPDATE janus_task_types SET ${fields.join(', ')} WHERE id = ?`, values);
}

/**
 * Delete task type from database
 * @param {string} typeId - Task type ID
 */
async function deleteTaskType(typeId) {
  const dbPool = getPool();
  if (!dbPool) return;

  await dbPool.execute('DELETE FROM janus_task_types WHERE id = ?', [typeId]);
}

/**
 * Find task type by ID or name
 * @param {string} identifier - Task type ID or name
 * @returns {Promise<Object|null>} Task type or null
 */
async function findTaskType(identifier) {
  const dbPool = getPool();
  if (!dbPool) return null;

  try {
    const [rows] = await dbPool.execute(
      'SELECT * FROM janus_task_types WHERE id = ? OR name = ?',
      [identifier, identifier]
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      parameters: typeof row.parameters === 'string' ? JSON.parse(row.parameters) : row.parameters,
      subtasks: typeof row.subtasks === 'string' ? JSON.parse(row.subtasks) : row.subtasks
    };
  } catch (error) {
    console.error('[DB] Find task type error:', error.message);
    return null;
  }
}

module.exports = {
  getTaskTypes,
  getTaskType,
  createTaskType,
  updateTaskType,
  deleteTaskType,
  findTaskType
};
