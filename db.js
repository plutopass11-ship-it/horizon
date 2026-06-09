/**
 * db.js — SQLite database initialization for Pluto Horizon
 *
 * Creates and configures the better-sqlite3 database with WAL mode,
 * initializes the shares and settings tables, and seeds default settings.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Resolve database directory from env or default to ./data
const DB_DIR = process.env.DB_DIR || path.join(__dirname, 'data');

// Ensure the database directory exists
fs.mkdirSync(DB_DIR, { recursive: true });

const dbPath = path.join(DB_DIR, 'horizon.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema: shares table ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    source_path TEXT NOT NULL,
    zip_filename TEXT,
    zip_size INTEGER,
    status TEXT DEFAULT 'zipping',
    zip_progress INTEGER DEFAULT 0,
    download_count INTEGER DEFAULT 0,
    max_downloads INTEGER DEFAULT 10,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    downloaded_by TEXT DEFAULT '[]'
  );
`);

// Index on token for fast public lookups
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
`);

// Index on status for cleanup queries
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_shares_status ON shares(status);
`);

// ─── Schema migrations: add new columns if they don't exist ─────────────────
try {
  db.exec(`ALTER TABLE shares ADD COLUMN pin_hash TEXT DEFAULT NULL`);
} catch {
  // Column already exists — ignore
}

try {
  db.exec(`ALTER TABLE shares ADD COLUMN is_zipped INTEGER DEFAULT 1`);
} catch {
  // Column already exists — ignore
}

// ─── Schema: settings table ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ─── Seed default settings (INSERT OR IGNORE so existing values are kept) ───
const defaultSettings = {
  default_expiry_hours: '168',        // 7 days
  default_max_downloads: '10',
  browse_root: '/data/nas',
  max_zip_size_mb: '10240',           // 10 GB
  max_expiry_hours: '720',            // 30 days
};

const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);

const seedSettings = db.transaction(() => {
  for (const [key, value] of Object.entries(defaultSettings)) {
    insertSetting.run(key, value);
  }
});

seedSettings();

// ─── Helper: get a single setting by key ────────────────────────────────────
/**
 * Retrieve a setting value by key.
 * @param {string} key - The setting key
 * @returns {string|null} The setting value or null if not found
 */
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Retrieve all settings as a key-value object.
 * @returns {Object} All settings
 */
function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

/**
 * Update a single setting.
 * @param {string} key - The setting key
 * @param {string} value - The new value
 */
function updateSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    key,
    String(value)
  );
}

module.exports = {
  db,
  getSetting,
  getAllSettings,
  updateSetting,
};
