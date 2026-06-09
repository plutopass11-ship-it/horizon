/**
 * cleanup.js — Hourly cleanup of expired shares and their zip files
 *
 * Runs on a 1-hour interval. Identifies shares that have:
 *   - Passed their expires_at timestamp
 *   - Reached their max download count
 * Marks them as 'expired' and deletes the associated zip files from disk.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('./db');

const ZIP_DIR = process.env.ZIP_DIR || path.join(__dirname, 'zips');

// Cleanup interval in milliseconds (1 hour)
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// ─── Prepared statements ────────────────────────────────────────────────────

// Find shares that are past their expiry date and still active
const findExpiredByTime = db.prepare(`
  SELECT id, zip_filename FROM shares
  WHERE status IN ('ready', 'zipping')
    AND expires_at <= datetime('now')
`);

// Find shares that have reached their max download count
const findExpiredByDownloads = db.prepare(`
  SELECT id, zip_filename FROM shares
  WHERE status = 'ready'
    AND download_count >= max_downloads
`);

// Mark a share as expired
const markExpired = db.prepare(`
  UPDATE shares SET status = 'expired' WHERE id = ?
`);

// ─── Cleanup logic ──────────────────────────────────────────────────────────

/**
 * Run a single cleanup pass.
 * Finds all expired shares, marks them in the DB, and deletes zip files.
 *
 * @returns {{ expiredCount: number, deletedFiles: number }} Cleanup stats
 */
function runCleanup() {
  let expiredCount = 0;
  let deletedFiles = 0;

  try {
    // Gather all shares that need expiring
    const expiredByTime = findExpiredByTime.all();
    const expiredByDownloads = findExpiredByDownloads.all();

    // Deduplicate by ID
    const seen = new Set();
    const toExpire = [];

    for (const share of [...expiredByTime, ...expiredByDownloads]) {
      if (!seen.has(share.id)) {
        seen.add(share.id);
        toExpire.push(share);
      }
    }

    if (toExpire.length === 0) {
      return { expiredCount: 0, deletedFiles: 0 };
    }

    // Process expirations in a transaction for atomicity
    const processExpiry = db.transaction(() => {
      for (const share of toExpire) {
        markExpired.run(share.id);
        expiredCount++;

        // Delete the zip file from disk
        if (share.zip_filename) {
          const zipPath = path.join(ZIP_DIR, share.zip_filename);
          try {
            if (fs.existsSync(zipPath)) {
              fs.unlinkSync(zipPath);
              deletedFiles++;
            }
          } catch (err) {
            console.error(
              `[cleanup] Failed to delete zip file ${share.zip_filename}:`,
              err.message
            );
          }
        }
      }
    });

    processExpiry();

    if (expiredCount > 0) {
      console.log(
        `[cleanup] Expired ${expiredCount} share(s), deleted ${deletedFiles} zip file(s)`
      );
    }
  } catch (err) {
    console.error('[cleanup] Error during cleanup pass:', err);
  }

  return { expiredCount, deletedFiles };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

let cleanupTimer = null;

/**
 * Start the hourly cleanup scheduler.
 * Runs an immediate cleanup pass, then repeats every hour.
 */
function startCleanupScheduler() {
  console.log('[cleanup] Starting hourly cleanup scheduler');

  // Run immediately on startup
  runCleanup();

  // Schedule recurring cleanup
  cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  // Allow the process to exit even if the timer is still active
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * Stop the cleanup scheduler (useful for graceful shutdown).
 */
function stopCleanupScheduler() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[cleanup] Cleanup scheduler stopped');
  }
}

module.exports = {
  runCleanup,
  startCleanupScheduler,
  stopCleanupScheduler,
};
