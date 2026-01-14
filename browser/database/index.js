/**
 * Database initialization and connection pool management
 */

const mysql = require('mysql2/promise');
const { dbConfig } = require('../config');

let dbPool = null;

/**
 * Initialize database connection and create tables
 * @returns {Promise<boolean>} Success status
 */
async function initDatabase() {
  try {
    dbPool = mysql.createPool(dbConfig);

    // Create tasks table if not exists
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS janus_tasks (
        id VARCHAR(64) PRIMARY KEY,
        type VARCHAR(64),
        psm VARCHAR(256),
        env VARCHAR(256),
        idl_branch VARCHAR(256),
        dry_run BOOLEAN DEFAULT TRUE,
        status VARCHAR(32),
        stage VARCHAR(64),
        result TEXT,
        error TEXT,
        logs LONGTEXT,
        start_time DATETIME,
        end_time DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Add stage column if it doesn't exist
    try {
      await dbPool.execute(`ALTER TABLE janus_tasks ADD COLUMN stage VARCHAR(64) AFTER status`);
    } catch (e) { /* Column already exists */ }

    // Add api_group_id column if it doesn't exist
    try {
      await dbPool.execute(`ALTER TABLE janus_tasks ADD COLUMN api_group_id VARCHAR(64) AFTER dry_run`);
    } catch (e) { /* Column already exists */ }

    // Add metadata JSON column
    try {
      await dbPool.execute(`ALTER TABLE janus_tasks ADD COLUMN metadata JSON`);
    } catch (e) { /* Column already exists */ }

    // Create screenshots table
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS janus_screenshots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id VARCHAR(64) NOT NULL,
        screenshot_index INT NOT NULL,
        label VARCHAR(256),
        data LONGTEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_task_id (task_id)
      )
    `);

    // Create task type definitions table
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS janus_task_types (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(256) NOT NULL,
        description TEXT,
        parameters JSON,
        subtasks JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    console.log('[DB] MySQL connected and tables ready');
    return true;
  } catch (error) {
    console.error('[DB] MySQL connection failed:', error.message);
    return false;
  }
}

/**
 * Get the database connection pool
 * @returns {Pool|null} Database pool
 */
function getPool() {
  return dbPool;
}

module.exports = {
  initDatabase,
  getPool
};
