/**
 * Cookie management routes
 */

const express = require('express');
const { loadCookies, saveCookies } = require('../engine/cookies');

const router = express.Router();

// GET /api/cookies - Get all cookies
router.get('/', (req, res) => {
  const cookies = loadCookies();
  res.json({ count: cookies.length, cookies });
});

// POST /api/cookies - Upload cookies (with optional merge)
router.post('/', (req, res) => {
  try {
    const newCookies = req.body;
    const merge = req.query.merge === 'true';

    if (!Array.isArray(newCookies)) {
      return res.status(400).json({ error: 'Cookies must be an array' });
    }

    let finalCookies;
    if (merge) {
      // Merge: update existing cookies by name+domain, add new ones
      const existingCookies = loadCookies();
      const cookieMap = new Map();

      existingCookies.forEach(c => {
        const key = `${c.name}|${c.domain}`;
        cookieMap.set(key, c);
      });

      newCookies.forEach(c => {
        const key = `${c.name}|${c.domain}`;
        cookieMap.set(key, c);
      });

      finalCookies = Array.from(cookieMap.values());
    } else {
      finalCookies = newCookies;
    }

    saveCookies(finalCookies);
    res.json({ success: true, count: finalCookies.length, merged: merge });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
