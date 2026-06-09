/**
 * server.js — Main Express application for Pluto Horizon
 *
 * Studio file sharing web app.
 * All API routes, static file serving, and download endpoint live here.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ─── Internal modules ───────────────────────────────────────────────────────
const { db, getSetting, getAllSettings, updateSetting } = require('./db');
const {
  authenticateWithKitsu,
  requireAuth,
  requireRole,
} = require('./kitsu-auth');
const { createZip, getZipPath, ZIP_DIR } = require('./zipper');
const { startCleanupScheduler } = require('./cleanup');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;
const NAS_DIR = process.env.NAS_DIR || path.join(__dirname, 'test-data');

// Ensure required directories exist
fs.mkdirSync(NAS_DIR, { recursive: true });
fs.mkdirSync(ZIP_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });

// ─── Express app setup ──────────────────────────────────────────────────────

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Serve static frontend files from public/
app.use(express.static(path.join(__dirname, 'public')));

// ─── Prepared statements ────────────────────────────────────────────────────

const stmts = {
  insertShare: db.prepare(`
    INSERT INTO shares (id, token, source_path, zip_filename, status, zip_progress,
                        max_downloads, created_by, expires_at, pin_hash, is_zipped)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getShareById: db.prepare('SELECT * FROM shares WHERE id = ?'),

  getShareByToken: db.prepare('SELECT * FROM shares WHERE token = ?'),

  listShares: db.prepare(
    'SELECT * FROM shares ORDER BY created_at DESC'
  ),

  deleteShare: db.prepare(
    `UPDATE shares SET status = 'revoked' WHERE id = ?`
  ),

  incrementDownload: db.prepare(`
    UPDATE shares
    SET download_count = download_count + 1,
        downloaded_by = ?
    WHERE id = ?
  `),
};

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/login
 * Authenticate a user via the Kitsu API and set a session cookie.
 *
 * Body: { email: string, password: string }
 * Returns: { user: object }
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: 'Email and password are required.' });
    }

    const { user, kitsuToken } = await authenticateWithKitsu(email, password);

    // Set HttpOnly cookie with the Kitsu access token
    res.cookie('kitsu_token', kitsuToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    });

    res.json({ user });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/auth/logout
 * Clear the session cookie.
 */
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('kitsu_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
  res.json({ message: 'Logged out' });
});

/**
 * GET /api/auth/me
 * Return the current authenticated user's profile from the Kitsu session.
 */
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    first_name: req.user.first_name,
    last_name: req.user.last_name,
    full_name: req.user.full_name,
    role: req.user.role,
    active: req.user.active,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FILE BROWSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/files?path=
 * Browse the NAS directory tree. Returns files and directories at the
 * given path (relative to the configured browse root).
 *
 * Query: path (optional, defaults to root)
 * Returns: { path: string, entries: Array<{ name, type, size, modified }> }
 */
app.get('/api/files', requireAuth, (req, res) => {
  try {
    const browseRoot = getSetting('browse_root') || NAS_DIR;
    const relativePath = req.query.path || '';

    // Resolve and validate the requested path is within the browse root
    const resolvedRoot = path.resolve(browseRoot);
    const requestedPath = path.resolve(resolvedRoot, relativePath);

    // Prevent directory traversal attacks
    if (!requestedPath.startsWith(resolvedRoot)) {
      return res.status(403).json({ error: 'Access denied: path traversal.' });
    }

    if (!fs.existsSync(requestedPath)) {
      return res.status(404).json({ error: 'Path not found.' });
    }

    const stat = fs.statSync(requestedPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory.' });
    }

    const dirEntries = fs.readdirSync(requestedPath, { withFileTypes: true });
    const entries = [];

    for (const entry of dirEntries) {
      // Skip hidden files (starting with .)
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(requestedPath, entry.name);
      try {
        const entryStat = fs.statSync(fullPath);
        entries.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? entryStat.size : undefined,
          modified: entryStat.mtime.toISOString(),
        });
      } catch {
        // Skip entries we can't stat (permission errors, broken symlinks)
        continue;
      }
    }

    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    res.json({
      path: relativePath || '/',
      entries,
    });
  } catch (err) {
    console.error('[files] Error browsing files:', err);
    res.status(500).json({ error: 'Failed to browse directory.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SHARE ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/shares
 * Create a new share link. Triggers background zip creation or direct file sharing.
 *
 * Body: {
 *   path: string,            // Path relative to browse root
 *   expiry_hours?: number,   // Custom expiry in hours (uses default if omitted)
 *   max_downloads?: number,  // Custom max downloads (uses default if omitted)
 *   pin?: string,            // Optional PIN to protect the share
 *   zip?: boolean            // Optional, default true. If false, share file directly
 * }
 * Returns: The created share object
 */
app.post('/api/shares', requireAuth, async (req, res) => {
  try {
    const { path: sharePath, expiry_hours, max_downloads, pin, zip } = req.body;

    if (!sharePath) {
      return res.status(400).json({ error: 'Path is required.' });
    }

    // ─── Resolve settings ─────────────────────────────────────────────
    const defaultExpiryHours = parseInt(getSetting('default_expiry_hours'), 10) || 168;
    const maxExpiryHours = parseInt(getSetting('max_expiry_hours'), 10) || 720;
    const defaultMaxDownloads = parseInt(getSetting('default_max_downloads'), 10) || 10;
    const maxZipSizeMb = parseInt(getSetting('max_zip_size_mb'), 10) || 10240;

    // Determine expiry hours
    let expiryHours = defaultExpiryHours;
    if (expiry_hours !== undefined && expiry_hours !== null) {
      expiryHours = parseInt(expiry_hours, 10);
      if (isNaN(expiryHours) || expiryHours < 1) {
        return res.status(400).json({ error: 'expiry_hours must be a positive integer.' });
      }
      if (expiryHours > maxExpiryHours) {
        return res.status(400).json({
          error: `expiry_hours cannot exceed ${maxExpiryHours} hours (${(maxExpiryHours / 24).toFixed(1)} days).`,
        });
      }
    }

    // Determine max downloads
    let maxDownloads = defaultMaxDownloads;
    if (max_downloads !== undefined && max_downloads !== null) {
      maxDownloads = parseInt(max_downloads, 10);
      if (isNaN(maxDownloads) || maxDownloads < 1) {
        return res.status(400).json({ error: 'max_downloads must be a positive integer.' });
      }
    }

    // ─── Validate source path ─────────────────────────────────────────
    const browseRoot = getSetting('browse_root') || NAS_DIR;
    const resolvedRoot = path.resolve(browseRoot);
    const sourcePath = path.resolve(resolvedRoot, sharePath);

    if (!sourcePath.startsWith(resolvedRoot)) {
      return res.status(403).json({ error: 'Access denied: path traversal.' });
    }

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Source path not found.' });
    }

    // ─── Check size limit (only when zipping) ──────────────────────────
    const shouldZip = zip !== false; // default true
    if (shouldZip) {
      let sourceSize = 0;
      try {
        const stat = fs.statSync(sourcePath);
        if (stat.isFile()) {
          sourceSize = stat.size;
        } else {
          // Quick size check for directories — this is synchronous but
          // acceptable for the request because we need to enforce limits
          sourceSize = calculateTotalSizeQuick(sourcePath);
        }
      } catch {
        // If size check fails, proceed anyway (zip will fail if too large)
      }

      const maxBytes = maxZipSizeMb * 1024 * 1024;
      if (sourceSize > maxBytes) {
        return res.status(400).json({
          error: `Source size (${(sourceSize / 1024 / 1024).toFixed(0)} MB) exceeds maximum allowed (${maxZipSizeMb} MB).`,
        });
      }
    }

    // ─── PIN hashing ──────────────────────────────────────────────────
    let pinHash = null;
    if (pin && typeof pin === 'string' && pin.length > 0) {
      pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    }

    // ─── Create share record ──────────────────────────────────────────
    const shareId = uuidv4();
    const token = crypto.randomBytes(16).toString('hex'); // 32-char URL-safe token
    const createdBy = req.user.full_name || req.user.email;

    // Calculate expiry timestamp (hours from now)
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '');

    if (shouldZip) {
      // ─── Zipped share (existing behavior) ─────────────────────────
      const zipFilename = `${shareId}.zip`;

      stmts.insertShare.run(
        shareId,
        token,
        sharePath,
        zipFilename,
        'zipping',  // status
        0,           // zip_progress
        maxDownloads,
        createdBy,
        expiresAt,
        pinHash,
        1            // is_zipped
      );

      // Trigger background zip creation (fire-and-forget)
      createZip(shareId, sourcePath, zipFilename).catch((err) => {
        console.error(`[server] Background zip failed for ${shareId}:`, err);
      });
    } else {
      // ─── Direct file share (no zipping) ───────────────────────────
      const stat = fs.statSync(sourcePath);
      const fileSize = stat.size;

      stmts.insertShare.run(
        shareId,
        token,
        sharePath,
        null,        // zip_filename — not used for direct shares
        'ready',     // status — immediately ready
        100,         // zip_progress — 100%
        maxDownloads,
        createdBy,
        expiresAt,
        pinHash,
        0            // is_zipped
      );

      // Update zip_size to the actual file size
      db.prepare('UPDATE shares SET zip_size = ? WHERE id = ?').run(fileSize, shareId);
    }

    // Return the share record
    const share = stmts.getShareById.get(shareId);
    res.status(201).json({
      ...share,
      download_url: `/d/${token}`,
    });
  } catch (err) {
    console.error('[shares] Error creating share:', err);
    res.status(500).json({ error: 'Failed to create share.' });
  }
});

/**
 * Quick recursive size calculation (synchronous).
 * Used for pre-zip size limit enforcement.
 */
function calculateTotalSizeQuick(dirPath) {
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += calculateTotalSizeQuick(fullPath);
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      }
    } catch {
      // Skip inaccessible entries
    }
  }
  return total;
}

/**
 * GET /api/shares
 * List all active share links.
 */
app.get('/api/shares', requireAuth, (req, res) => {
  try {
    const shares = stmts.listShares.all();
    res.json(
      shares.map((s) => ({
        ...s,
        download_url: `/d/${s.token}`,
        downloaded_by: JSON.parse(s.downloaded_by || '[]'),
      }))
    );
  } catch (err) {
    console.error('[shares] Error listing shares:', err);
    res.status(500).json({ error: 'Failed to list shares.' });
  }
});

/**
 * DELETE /api/shares/:id
 * Revoke a share link. Restricted to admin and manager roles.
 */
function revokeShareHandler(req, res) {
  try {
    const share = stmts.getShareById.get(req.params.id);
    if (!share) {
      return res.status(404).json({ error: 'Share not found.' });
    }

    stmts.deleteShare.run(req.params.id);

    // Delete the zip file if it exists
    if (share.zip_filename) {
      const zipPath = getZipPath(share.zip_filename);
      try {
        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }
      } catch (err) {
        console.warn(`[shares] Failed to delete zip: ${err.message}`);
      }
    }

    res.json({ message: 'Share revoked successfully.' });
  } catch (err) {
    console.error('[shares] Error revoking share:', err);
    res.status(500).json({ error: 'Failed to revoke share.' });
  }
}

app.delete(
  '/api/shares/:id',
  requireAuth,
  requireRole('admin', 'manager'),
  revokeShareHandler
);

// Alias: POST /api/shares/:id/revoke (used by some frontend code)
app.post(
  '/api/shares/:id/revoke',
  requireAuth,
  requireRole('admin', 'manager'),
  revokeShareHandler
);

/**
 * GET /api/shares/:id/status
 * Check zip progress for a share.
 */
app.get('/api/shares/:id/status', requireAuth, (req, res) => {
  try {
    const share = stmts.getShareById.get(req.params.id);
    if (!share) {
      return res.status(404).json({ error: 'Share not found.' });
    }

    res.json({
      id: share.id,
      status: share.status,
      zip_progress: share.zip_progress,
      zip_size: share.zip_size,
      zip_filename: share.zip_filename,
    });
  } catch (err) {
    console.error('[shares] Error checking status:', err);
    res.status(500).json({ error: 'Failed to check share status.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/settings
 * Get all app settings.
 */
app.get('/api/settings', requireAuth, (req, res) => {
  try {
    const settings = getAllSettings();
    res.json(settings);
  } catch (err) {
    console.error('[settings] Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

/**
 * PUT /api/settings
 * Update app settings. Restricted to admin and manager roles.
 *
 * Body: { key: value, ... }
 * Only known settings keys are accepted.
 */
const ALLOWED_SETTINGS = new Set([
  'default_expiry_hours',
  'default_max_downloads',
  'browse_root',
  'max_zip_size_mb',
  'max_expiry_hours',
]);

app.put(
  '/api/settings',
  requireAuth,
  requireRole('admin', 'manager'),
  (req, res) => {
    try {
      const updates = req.body;

      if (!updates || typeof updates !== 'object') {
        return res
          .status(400)
          .json({ error: 'Request body must be a JSON object.' });
      }

      const unknownKeys = Object.keys(updates).filter(
        (k) => !ALLOWED_SETTINGS.has(k)
      );
      if (unknownKeys.length > 0) {
        return res.status(400).json({
          error: `Unknown settings: ${unknownKeys.join(', ')}`,
          allowed: Array.from(ALLOWED_SETTINGS),
        });
      }

      // Validate numeric settings
      const numericKeys = [
        'default_expiry_hours',
        'default_max_downloads',
        'max_zip_size_mb',
        'max_expiry_hours',
      ];
      for (const key of numericKeys) {
        if (key in updates) {
          const val = parseInt(updates[key], 10);
          if (isNaN(val) || val < 1) {
            return res
              .status(400)
              .json({ error: `${key} must be a positive integer.` });
          }
        }
      }

      // Apply updates in a transaction
      const applyUpdates = db.transaction(() => {
        for (const [key, value] of Object.entries(updates)) {
          updateSetting(key, value);
        }
      });

      applyUpdates();

      // Return updated settings
      const settings = getAllSettings();
      res.json(settings);
    } catch (err) {
      console.error('[settings] Error updating settings:', err);
      res.status(500).json({ error: 'Failed to update settings.' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC DOWNLOAD ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /d/:token
 * Serve the download page HTML. The frontend JS will call /d/:token/info
 * to populate the page with share details.
 */
app.get('/d/:token', (req, res) => {
  const downloadPage = path.join(__dirname, 'public', 'download.html');
  if (fs.existsSync(downloadPage)) {
    return res.sendFile(downloadPage);
  }
  // Fallback: return a minimal HTML page
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Pluto Horizon — Download</title></head>
    <body>
      <h1>Pluto Horizon</h1>
      <p>Download page not found. Please deploy the frontend.</p>
    </body>
    </html>
  `);
});

/**
 * POST /d/:token/verify-pin
 * Verify a PIN for a PIN-protected share. Public endpoint.
 *
 * Body: { pin: string }
 * Returns: { verified: true } on success, 403 on failure
 */
app.post('/d/:token/verify-pin', (req, res) => {
  try {
    const share = stmts.getShareByToken.get(req.params.token);

    if (!share) {
      return res.status(404).json({ error: 'Share not found.' });
    }

    // If share has no PIN, it's always verified
    if (!share.pin_hash) {
      return res.json({ verified: true });
    }

    const { pin } = req.body || {};

    if (!pin || typeof pin !== 'string') {
      return res.status(403).json({ error: 'Incorrect PIN' });
    }

    const submittedHash = crypto.createHash('sha256').update(pin).digest('hex');

    if (submittedHash === share.pin_hash) {
      // Set a session cookie to remember PIN verification
      res.cookie('pin_verified_' + share.token, 'true', {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        path: '/',
      });
      return res.json({ verified: true });
    }

    return res.status(403).json({ error: 'Incorrect PIN' });
  } catch (err) {
    console.error('[download] Error verifying PIN:', err);
    res.status(500).json({ error: 'Failed to verify PIN.' });
  }
});

/**
 * GET /d/:token/info
 * Get share info for the download page (public endpoint).
 * Returns share metadata without sensitive fields.
 * If PIN-protected, requires PIN verification cookie.
 */
app.get('/d/:token/info', (req, res) => {
  try {
    const share = stmts.getShareByToken.get(req.params.token);

    if (!share) {
      return res.status(404).json({ error: 'Share not found.' });
    }

    // Check if share is still valid
    if (share.status === 'revoked') {
      return res.status(410).json({ error: 'This share has been revoked.' });
    }

    if (share.status === 'expired') {
      return res.status(410).json({ error: 'This share has expired.' });
    }

    // Check time-based expiry
    const expiresAt = new Date(share.expires_at + 'Z');
    if (expiresAt <= new Date()) {
      return res.status(410).json({ error: 'This share has expired.' });
    }

    // Check download limit
    if (share.download_count >= share.max_downloads) {
      return res
        .status(410)
        .json({ error: 'Download limit reached for this share.' });
    }

    // If PIN-protected, check for verification cookie
    if (share.pin_hash) {
      const pinCookie = req.cookies && req.cookies['pin_verified_' + share.token];
      if (!pinCookie) {
        return res.json({ pin_required: true, status: share.status });
      }
    }

    res.json({
      source_path: share.source_path,
      status: share.status,
      zip_progress: share.zip_progress,
      zip_size: share.zip_size,
      download_count: share.download_count,
      max_downloads: share.max_downloads,
      created_by: share.created_by,
      created_at: share.created_at,
      expires_at: share.expires_at,
      is_zipped: share.is_zipped,
    });
  } catch (err) {
    console.error('[download] Error fetching share info:', err);
    res.status(500).json({ error: 'Failed to fetch share info.' });
  }
});

/**
 * GET /d/:token/download
 * File download with Accept-Ranges support for resume capability.
 * Tracks download count and logs downloader IP + timestamp.
 * Supports both zipped and direct file downloads.
 */
app.get('/d/:token/download', (req, res) => {
  try {
    const share = stmts.getShareByToken.get(req.params.token);

    if (!share) {
      return res.status(404).json({ error: 'Share not found.' });
    }

    // Validate share is downloadable
    if (share.status === 'revoked') {
      return res.status(410).json({ error: 'This share has been revoked.' });
    }

    if (share.status === 'expired') {
      return res.status(410).json({ error: 'This share has expired.' });
    }

    if (share.status === 'zipping') {
      return res
        .status(202)
        .json({ error: 'Zip is still being created. Please wait.', zip_progress: share.zip_progress });
    }

    // Check time-based expiry
    const expiresAt = new Date(share.expires_at + 'Z');
    if (expiresAt <= new Date()) {
      return res.status(410).json({ error: 'This share has expired.' });
    }

    // Check download limit
    if (share.download_count >= share.max_downloads) {
      return res
        .status(410)
        .json({ error: 'Download limit reached for this share.' });
    }

    // If PIN-protected, check for verification cookie
    if (share.pin_hash) {
      const pinCookie = req.cookies && req.cookies['pin_verified_' + share.token];
      if (!pinCookie) {
        return res.status(403).json({ error: 'PIN verification required' });
      }
    }

    // ─── Determine file path and metadata ─────────────────────────────
    let filePath;
    let downloadFilename;
    let contentType;

    if (share.is_zipped === 0) {
      // Direct file download — resolve from browse root
      const browseRoot = getSetting('browse_root') || NAS_DIR;
      const resolvedRoot = path.resolve(browseRoot);
      filePath = path.resolve(resolvedRoot, share.source_path);

      // Safety check: ensure path is within browse root
      if (!filePath.startsWith(resolvedRoot)) {
        return res.status(403).json({ error: 'Access denied.' });
      }

      if (!fs.existsSync(filePath)) {
        return res.status(500).json({ error: 'Source file not found on server.' });
      }

      downloadFilename = path.basename(share.source_path);

      // Determine content type from extension
      const ext = path.extname(downloadFilename).toLowerCase();
      const mimeTypes = {
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed',
        '.7z': 'application/x-7z-compressed',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        '.pdf': 'application/pdf',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
        '.exr': 'application/octet-stream',
        '.psd': 'application/octet-stream',
        '.blend': 'application/octet-stream',
        '.ma': 'application/octet-stream',
        '.mb': 'application/octet-stream',
        '.fbx': 'application/octet-stream',
        '.obj': 'application/octet-stream',
        '.abc': 'application/octet-stream',
        '.usd': 'application/octet-stream',
        '.usda': 'application/octet-stream',
        '.usdc': 'application/octet-stream',
        '.usdz': 'application/octet-stream',
      };
      contentType = mimeTypes[ext] || 'application/octet-stream';
    } else {
      // Zipped download
      filePath = getZipPath(share.zip_filename);
      if (!fs.existsSync(filePath)) {
        return res.status(500).json({ error: 'Zip file not found on server.' });
      }
      const sourceName = path.basename(share.source_path) || 'download';
      downloadFilename = `${sourceName}.zip`;
      contentType = 'application/zip';
    }

    const fileStat = fs.statSync(filePath);
    const fileSize = fileStat.size;

    // ─── Track download ──────────────────────────────────────────────
    const downloadedBy = JSON.parse(share.downloaded_by || '[]');
    downloadedBy.push({
      ip: req.ip || req.connection?.remoteAddress || 'unknown',
      timestamp: new Date().toISOString(),
    });

    stmts.incrementDownload.run(JSON.stringify(downloadedBy), share.id);

    // ─── Accept-Ranges / Range support ───────────────────────────────
    const rangeHeader = req.headers.range;

    // Common headers
    res.set({
      'Content-Disposition': `attachment; filename="${downloadFilename}"`,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });

    if (rangeHeader) {
      // Parse Range header: bytes=start-end
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      // Validate range
      if (start >= fileSize || end >= fileSize || start > end) {
        res.set('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }

      const chunkSize = end - start + 1;

      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunkSize,
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      // Full file download
      res.set('Content-Length', fileSize);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (err) {
    console.error('[download] Error serving download:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to serve download.' });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

// 404 handler for unmatched API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         🚀 Pluto Horizon is running          ║
  ║                                              ║
  ║   Local:   http://localhost:${String(PORT).padEnd(5)}            ║
  ║   NAS Dir: ${NAS_DIR.substring(0, 32).padEnd(32)} ║
  ║   ZIP Dir: ${ZIP_DIR.substring(0, 32).padEnd(32)} ║
  ╚══════════════════════════════════════════════╝
  `);

  // Start the hourly cleanup scheduler
  startCleanupScheduler();
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[server] Shutting down gracefully...');
  const { stopCleanupScheduler } = require('./cleanup');
  stopCleanupScheduler();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[server] Received SIGTERM, shutting down...');
  const { stopCleanupScheduler } = require('./cleanup');
  stopCleanupScheduler();
  db.close();
  process.exit(0);
});

module.exports = app;
