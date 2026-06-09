/**
 * kitsu-auth.js — Kitsu API authentication module + cookie-based middleware
 *
 * Handles:
 *  - Authenticating users against the Kitsu (CGWire Zou) API
 *  - Express middleware for protecting routes via Kitsu token cookies
 *  - Role-based access control helpers
 */

// ─── Configuration ──────────────────────────────────────────────────────────

const KITSU_API_URL = process.env.KITSU_API_URL || 'http://cgwire:3002/api';

// ─── Kitsu API authentication ───────────────────────────────────────────────

/**
 * Authenticate a user against the Kitsu API.
 *
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} Object with { user, kitsuToken }
 * @throws {Error} If authentication fails
 */
async function authenticateWithKitsu(email, password) {
  // Step 1: Log in to Kitsu to obtain an access token
  const loginRes = await fetch(`${KITSU_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    const errBody = await loginRes.text().catch(() => '');
    const status = loginRes.status;
    if (status === 401 || status === 400) {
      throw Object.assign(new Error('Invalid email or password'), {
        statusCode: 401,
      });
    }
    throw Object.assign(
      new Error(`Kitsu API error: ${status} ${errBody}`),
      { statusCode: 502 }
    );
  }

  const loginData = await loginRes.json();
  const kitsuToken = loginData.access_token || loginData.login?.access_token;

  if (!kitsuToken) {
    throw Object.assign(new Error('No access token received from Kitsu'), {
      statusCode: 502,
    });
  }

  // Step 2: Fetch user profile from Kitsu
  const userRes = await fetch(`${KITSU_API_URL}/auth/authenticated`, {
    headers: {
      Authorization: `Bearer ${kitsuToken}`,
    },
  });

  if (!userRes.ok) {
    throw Object.assign(new Error('Failed to fetch user profile from Kitsu'), {
      statusCode: 502,
    });
  }

  const userData = await userRes.json();
  const user = userData.user || userData;

  return {
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      full_name: user.full_name || `${user.first_name} ${user.last_name}`,
      role: mapKitsuRole(user.role || 'user'),
      active: user.active,
      has_avatar: user.has_avatar,
    },
    kitsuToken,
  };
}

// ─── Role mapping ───────────────────────────────────────────────────────────

/**
 * Map a Kitsu role string to a Horizon role.
 * admin and studio_manager → admin
 * manager → manager
 * everything else → user
 *
 * @param {string} kitsuRole - The role from Kitsu
 * @returns {string} Mapped Horizon role
 */
function mapKitsuRole(kitsuRole) {
  if (kitsuRole === 'admin' || kitsuRole === 'studio_manager') return 'admin';
  if (kitsuRole === 'manager') return 'manager';
  return 'user';
}

// ─── Express middleware ─────────────────────────────────────────────────────

/**
 * Cookie-based Kitsu authentication middleware.
 * Reads the Kitsu access token from req.cookies.kitsu_token,
 * verifies it against the Kitsu API, and attaches user data to req.user.
 */
async function requireAuth(req, res, next) {
  const kitsuToken = req.cookies && req.cookies.kitsu_token;

  if (!kitsuToken) {
    return res
      .status(401)
      .json({ error: 'Authentication required. No session found.' });
  }

  try {
    const userRes = await fetch(`${KITSU_API_URL}/auth/authenticated`, {
      headers: {
        Authorization: `Bearer ${kitsuToken}`,
      },
    });

    if (!userRes.ok) {
      return res
        .status(401)
        .json({ error: 'Session expired or invalid. Please log in again.' });
    }

    const userData = await userRes.json();
    const user = userData.user || userData;

    req.user = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      full_name: user.full_name || `${user.first_name} ${user.last_name}`,
      role: mapKitsuRole(user.role || 'user'),
      active: user.active,
    };

    next();
  } catch (err) {
    console.error('[kitsu-auth] Error verifying token:', err.message);
    return res
      .status(401)
      .json({ error: 'Authentication failed. Please log in again.' });
  }
}

/**
 * Role-based authorization middleware factory.
 * Only allows users whose role is in the allowed list.
 *
 * @param  {...string} roles - Allowed roles (e.g. 'admin', 'manager')
 * @returns {Function} Express middleware
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
}

module.exports = {
  authenticateWithKitsu,
  requireAuth,
  requireRole,
};
