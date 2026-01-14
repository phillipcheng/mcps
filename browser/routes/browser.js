/**
 * Browser pool management routes
 */

const express = require('express');

const router = express.Router();

/**
 * Create browser routes with injected browser pool
 * @param {Object} browserPool - Browser pool instance
 * @returns {Router} Express router
 */
function createBrowserRoutes(browserPool) {
  // GET /api/browser/status - Get browser pool status
  router.get('/status', (req, res) => {
    res.json(browserPool.getStatus());
  });

  // POST /api/browser/close - Close browser pool
  router.post('/close', async (req, res) => {
    await browserPool.close(console.log);
    res.json({ success: true, message: 'Browser pool closed' });
  });

  return router;
}

module.exports = { createBrowserRoutes };
