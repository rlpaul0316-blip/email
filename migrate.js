// migrate.js
// Runs the SQL files at startup so tables/seed data exist without
// needing manual psql access. Safe to run every boot: every statement
// uses IF NOT EXISTS / ON CONFLICT DO NOTHING, so it won't duplicate.

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

// order matters: schema first, then seed, then the stars column
const FILES = ['schema.sql', 'seed_settings.sql', 'add_stars.sql'];

async function runMigrations() {
  for (const file of FILES) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) {
      console.log(`(migrate) skipping missing ${file}`);
      continue;
    }
    const sql = fs.readFileSync(full, 'utf8');
    try {
      await pool.query(sql);
      console.log(`(migrate) applied ${file}`);
    } catch (e) {
      // add_stars re-adding a column, etc. — log but don't crash the boot
      console.log(`(migrate) ${file}: ${e.message}`);
    }
  }
}

module.exports = { runMigrations };
