/**
 * zipper.js — Background zip creation with progress tracking
 *
 * Creates zip archives from NAS directories/files using the `archiver` library.
 * Progress is tracked in the SQLite database so the frontend can poll for
 * zip completion status.
 */

const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

// Resolve zip output directory from env or default to ./zips
const ZIP_DIR = process.env.ZIP_DIR || path.join(__dirname, 'zips');

// Ensure zip directory exists
fs.mkdirSync(ZIP_DIR, { recursive: true });

// ─── Prepared statements ────────────────────────────────────────────────────

const updateProgress = db.prepare(
  'UPDATE shares SET zip_progress = ? WHERE id = ?'
);

const markReady = db.prepare(
  `UPDATE shares
     SET status = 'ready', zip_progress = 100, zip_size = ?, zip_filename = ?
   WHERE id = ?`
);

const markFailed = db.prepare(
  `UPDATE shares
     SET status = 'expired', zip_progress = -1
   WHERE id = ?`
);

// ─── Size calculation ───────────────────────────────────────────────────────

/**
 * Recursively calculate the total size in bytes of a path (file or directory).
 * @param {string} targetPath - Absolute path to measure
 * @returns {number} Total size in bytes
 */
function calculateTotalSize(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return stat.size;
  }

  let total = 0;
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      total += calculateTotalSize(fullPath);
    } else if (entry.isFile()) {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

// ─── Main zip creation function ─────────────────────────────────────────────

/**
 * Create a zip archive from a source path and track progress in the database.
 *
 * This function runs asynchronously — call it without awaiting to run in the
 * background while the API responds immediately.
 *
 * @param {string} shareId - The share record ID in the database
 * @param {string} sourcePath - Absolute path to the file or directory to zip
 * @param {string} zipFilename - Output zip filename (stored in ZIP_DIR)
 */
async function createZip(shareId, sourcePath, zipFilename) {
  const outputPath = path.join(ZIP_DIR, zipFilename);

  try {
    // Verify source exists
    if (!fs.existsSync(sourcePath)) {
      console.error(`[zipper] Source path does not exist: ${sourcePath}`);
      markFailed.run(shareId);
      return;
    }

    // Calculate total source size for progress tracking
    const totalSize = calculateTotalSize(sourcePath);
    if (totalSize === 0) {
      console.warn(`[zipper] Source is empty: ${sourcePath}`);
    }

    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 5 }, // Balanced speed vs compression
    });

    let processedBytes = 0;
    let lastReportedProgress = 0;

    // Track progress via archiver's 'progress' event
    archive.on('progress', (progress) => {
      processedBytes = progress.fs.processedBytes || 0;
      const pct =
        totalSize > 0 ? Math.min(Math.floor((processedBytes / totalSize) * 100), 99) : 0;

      // Only update DB when progress changes by at least 1%
      if (pct > lastReportedProgress) {
        lastReportedProgress = pct;
        try {
          updateProgress.run(pct, shareId);
        } catch (err) {
          // Non-fatal: log and continue
          console.error(`[zipper] Failed to update progress: ${err.message}`);
        }
      }
    });

    // Wait for the archive to finish writing
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', (warn) => {
        if (warn.code === 'ENOENT') {
          console.warn(`[zipper] Warning: ${warn.message}`);
        } else {
          reject(warn);
        }
      });

      // Pipe archive data to the output file
      archive.pipe(output);

      const stat = fs.statSync(sourcePath);

      if (stat.isDirectory()) {
        // Add entire directory contents, preserving folder structure
        // The second arg is the prefix inside the zip — use the folder name
        const dirName = path.basename(sourcePath);
        archive.directory(sourcePath, dirName);
      } else {
        // Single file — add it at the root of the zip
        archive.file(sourcePath, { name: path.basename(sourcePath) });
      }

      archive.finalize();
    });

    // Get final zip size
    const zipStat = fs.statSync(outputPath);
    const zipSize = zipStat.size;

    // Mark share as ready
    markReady.run(zipSize, zipFilename, shareId);
    console.log(
      `[zipper] ✓ Zip created: ${zipFilename} (${(zipSize / 1024 / 1024).toFixed(1)} MB)`
    );
  } catch (err) {
    console.error(`[zipper] ✗ Failed to create zip for share ${shareId}:`, err);
    markFailed.run(shareId);

    // Clean up partial zip file
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch (cleanupErr) {
      console.error(`[zipper] Failed to clean up partial zip:`, cleanupErr);
    }
  }
}

/**
 * Get the full filesystem path for a zip filename.
 * @param {string} zipFilename - The zip filename
 * @returns {string} Absolute path to the zip file
 */
function getZipPath(zipFilename) {
  return path.join(ZIP_DIR, zipFilename);
}

module.exports = {
  createZip,
  getZipPath,
  ZIP_DIR,
};
