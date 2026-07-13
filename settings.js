// settings.js
// Central access to runtime-editable text + prices.
// Everything user-facing is read through here so the admin panel
// can change it live without a redeploy.

const { pool } = require('./db');

// simple in-memory cache to avoid a DB hit on every message
let cache = {};
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

async function loadAll() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  cache = Object.fromEntries(rows.map(r => [r.key, r.value]));
  cacheLoadedAt = Date.now();
  return cache;
}

async function ensureFresh() {
  if (Date.now() - cacheLoadedAt > CACHE_TTL_MS) await loadAll();
}

// get a raw setting
async function get(key, fallback = '') {
  await ensureFresh();
  return cache[key] ?? fallback;
}

// get a setting with {token} substitution
async function render(key, vars = {}, fallback = '') {
  let text = await get(key, fallback);
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

// update a setting (used by admin panel)
async function set(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, value]
  );
  cache[key] = value; // keep cache in sync immediately
}

module.exports = { loadAll, get, render, set };
