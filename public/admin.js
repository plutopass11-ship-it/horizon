/* ═══════════════════════════════════════════════════════════════
   PLUTO HORIZON — Admin Panel JavaScript
   Complete admin SPA logic: auth, file browser, shares, settings
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── STATE ─────────────────────────────────────────────────── */
  const state = {
    user: JSON.parse(localStorage.getItem('ph_user') || 'null'),
    currentPath: '',
    selectedFolder: null,
    shares: [],
    settings: {},
    sharesRefreshTimer: null,
  };

  /* ── HELPERS ───────────────────────────────────────────────── */

  /** Authenticated fetch wrapper — redirects on 401 */
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const res = await fetch(path, { ...opts, headers, credentials: 'include' });
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    return res;
  }

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '—';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function relativeTime(dateStr) {
    if (!dateStr) return '—';
    const now = Date.now();
    const target = new Date(dateStr).getTime();
    const diff = target - now;
    const abs = Math.abs(diff);
    const mins = Math.floor(abs / 60000);
    const hours = Math.floor(abs / 3600000);
    const days = Math.floor(abs / 86400000);

    let str;
    if (mins < 1) str = 'just now';
    else if (mins < 60) str = `${mins}m`;
    else if (hours < 24) str = `${hours}h`;
    else str = `${days}d`;

    if (diff < 0 && mins >= 1) return str + ' ago';
    if (diff > 0) return 'in ' + str;
    return str;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function shortToken(token) {
    if (!token) return '';
    return token.length > 12 ? token.slice(0, 6) + '…' + token.slice(-4) : token;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /** Parse a duration value + unit into hours */
  function toHours(value, unit) {
    return unit === 'days' ? value * 24 : Number(value);
  }

  /** Convert hours to best display unit */
  function fromHours(h) {
    if (h >= 24 && h % 24 === 0) return { value: h / 24, unit: 'days' };
    return { value: h, unit: 'hours' };
  }

  /* ── TOAST SYSTEM ──────────────────────────────────────────── */
  const toastContainer = document.getElementById('toast-container');

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    el.innerHTML = `<span>${icons[type] || ''}</span> <span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-out');
      el.addEventListener('animationend', () => el.remove());
    }, 3500);
  }

  /* ── DOM REFS ──────────────────────────────────────────────── */
  const $loginScreen   = document.getElementById('login-screen');
  const $appShell      = document.getElementById('app-shell');
  const $loginForm     = document.getElementById('login-form');
  const $loginEmail    = document.getElementById('login-email');
  const $loginPass     = document.getElementById('login-password');
  const $loginError    = document.getElementById('login-error');
  const $loginBtn      = document.getElementById('login-btn');
  const $userName      = document.getElementById('user-name');
  const $userRole      = document.getElementById('user-role');
  const $logoutBtn     = document.getElementById('logout-btn');
  const $sidebarToggle = document.getElementById('sidebar-toggle');
  const $sidebar       = document.getElementById('sidebar');
  const $navSettings   = document.getElementById('nav-settings');
  const $breadcrumb    = document.getElementById('breadcrumb');
  const $fileGrid      = document.getElementById('file-grid');
  const $sharesTbody   = document.getElementById('shares-tbody');
  const $sharesEmpty   = document.getElementById('shares-empty');
  const $shareSearch   = document.getElementById('share-search');

  // Modal
  const $modalOverlay  = document.getElementById('modal-overlay');
  const $shareModal    = document.getElementById('share-modal');
  const $modalClose    = document.getElementById('modal-close');
  const $modalCancel   = document.getElementById('modal-cancel');
  const $modalDoneClose= document.getElementById('modal-done-close');
  const $sharePathText = document.getElementById('share-path-text');
  const $shareExpiry   = document.getElementById('share-expiry');
  const $shareExpiryUnit = document.getElementById('share-expiry-unit');
  const $shareMaxDl    = document.getElementById('share-max-downloads');
  const $shareExpiryHint = document.getElementById('share-expiry-hint');
  const $shareCreateBtn= document.getElementById('share-create-btn');
  const $stepConfig    = document.getElementById('modal-step-config');
  const $stepProgress  = document.getElementById('modal-step-progress');
  const $stepDone      = document.getElementById('modal-step-done');
  const $zipFill       = document.getElementById('zip-progress-fill');
  const $zipPct        = document.getElementById('zip-progress-pct');
  const $shareLinkInput= document.getElementById('share-link-input');
  const $copyLinkBtn   = document.getElementById('copy-link-btn');

  // Zip & PIN controls
  const $zipToggle     = document.getElementById('share-zip-toggle');
  const $pinToggle     = document.getElementById('share-pin-toggle');
  const $pinInput      = document.getElementById('share-pin-input');
  const $pinGenerate   = document.getElementById('share-pin-generate');

  // Confirm dialog
  const $confirmOverlay= document.getElementById('confirm-overlay');
  const $confirmTitle  = document.getElementById('confirm-title');
  const $confirmMsg    = document.getElementById('confirm-message');
  const $confirmOk     = document.getElementById('confirm-ok');
  const $confirmCancel = document.getElementById('confirm-cancel');
  const $confirmCloseX = document.getElementById('confirm-close-x');

  /* ═══════════════════════════════════════════════════════════════
     AUTH
     ═══════════════════════════════════════════════════════════════ */

  function showLogin() {
    $loginScreen.hidden = false;
    $appShell.hidden = true;
    stopSharesRefresh();
  }

  async function showApp() {
    // Verify session is still valid
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (!res.ok) { logout(); return; }
      const data = await res.json();
      state.user = data.user || data;
      localStorage.setItem('ph_user', JSON.stringify(state.user));
    } catch {
      logout();
      return;
    }

    $loginScreen.hidden = true;
    $appShell.hidden = false;
    $userName.textContent = state.user?.name || state.user?.email || 'User';
    $userRole.textContent = state.user?.role || 'user';

    // Show/hide settings nav for admin/manager
    const role = (state.user?.role || '').toLowerCase();
    $navSettings.style.display = (role === 'admin' || role === 'manager') ? '' : 'none';

    loadFiles('');
    loadShares();
    loadSettings();
    startSharesRefresh();
  }

  function logout() {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    state.user = null;
    localStorage.removeItem('ph_user');
    showLogin();
  }

  $loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $loginError.hidden = true;
    const btnText = $loginBtn.querySelector('.btn-text');
    const btnLoader = $loginBtn.querySelector('.btn-loader');
    btnText.hidden = true;
    btnLoader.hidden = false;
    $loginBtn.disabled = true;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: $loginEmail.value.trim(),
          password: $loginPass.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      state.user = data.user;
      localStorage.setItem('ph_user', JSON.stringify(data.user));
      showApp();
    } catch (err) {
      $loginError.textContent = err.message;
      $loginError.hidden = false;
    } finally {
      btnText.hidden = false;
      btnLoader.hidden = true;
      $loginBtn.disabled = false;
    }
  });

  $logoutBtn.addEventListener('click', logout);

  /* ═══════════════════════════════════════════════════════════════
     NAVIGATION
     ═══════════════════════════════════════════════════════════════ */

  const navItems = document.querySelectorAll('.nav-item[data-section]');
  const sections = document.querySelectorAll('.content-section');

  function switchSection(sectionId) {
    navItems.forEach(n => n.classList.toggle('active', n.dataset.section === sectionId));
    sections.forEach(s => {
      const isActive = s.id === `section-${sectionId}`;
      s.classList.toggle('active', isActive);
      // Re-trigger animation
      if (isActive) {
        s.style.animation = 'none';
        s.offsetHeight; // reflow
        s.style.animation = '';
      }
    });
    // Close sidebar on mobile
    $sidebar.classList.remove('open');
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => switchSection(item.dataset.section));
  });

  $sidebarToggle.addEventListener('click', () => {
    $sidebar.classList.toggle('open');
  });

  /* ═══════════════════════════════════════════════════════════════
     FILE BROWSER
     ═══════════════════════════════════════════════════════════════ */

  async function loadFiles(path) {
    state.currentPath = path;
    state.selectedFolder = null;
    renderBreadcrumb(path);
    $fileGrid.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading files…</p></div>`;

    try {
      const res = await api(`/api/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error('Failed to load files');
      const data = await res.json();
      renderFiles(data.entries || data.items || data);
    } catch (err) {
      $fileGrid.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  function renderBreadcrumb(path) {
    const parts = path ? path.split('/').filter(Boolean) : [];
    let html = `<button class="breadcrumb-item${parts.length === 0 ? ' active' : ''}" data-path="">Root</button>`;
    let cumulative = '';
    parts.forEach((part, i) => {
      cumulative += (cumulative ? '/' : '') + part;
      const isLast = i === parts.length - 1;
      html += `<span class="breadcrumb-sep">›</span>`;
      html += `<button class="breadcrumb-item${isLast ? ' active' : ''}" data-path="${escapeHtml(cumulative)}">${escapeHtml(part)}</button>`;
    });
    $breadcrumb.innerHTML = html;

    $breadcrumb.querySelectorAll('.breadcrumb-item:not(.active)').forEach(btn => {
      btn.addEventListener('click', () => loadFiles(btn.dataset.path));
    });
  }

  function renderFiles(items) {
    if (!items || items.length === 0) {
      $fileGrid.innerHTML = `<div class="empty-state"><span class="empty-icon">📂</span><p>This folder is empty</p></div>`;
      return;
    }

    // Sort: folders first, then alphabetical
    items.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    let html = '';
    items.forEach((item, i) => {
      const isDir = item.type === 'directory';
      const icon = isDir ? '📁' : getFileIcon(item.name);
      const size = isDir ? '' : formatBytes(item.size);
      const modified = item.modified ? formatDate(item.modified) : '';
      const meta = [size, modified].filter(Boolean).join(' · ');
      const delay = Math.min(i * 0.04, 0.6);

      html += `
        <div class="file-item" data-name="${escapeHtml(item.name)}" data-type="${item.type}" style="animation-delay:${delay}s">
          <span class="file-icon">${icon}</span>
          <div class="file-info">
            <div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
            ${meta ? `<div class="file-meta">${escapeHtml(meta)}</div>` : ''}
          </div>
        </div>`;
    });

    $fileGrid.innerHTML = html;

    $fileGrid.querySelectorAll('.file-item').forEach(el => {
      el.addEventListener('click', () => handleFileClick(el));
    });
  }

  function getFileIcon(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    const map = {
      mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', wmv: '🎬', webm: '🎬',
      mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵',
      jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', bmp: '🖼️', tiff: '🖼️',
      pdf: '📕', doc: '📝', docx: '📝', txt: '📝', rtf: '📝',
      xls: '📊', xlsx: '📊', csv: '📊',
      ppt: '📙', pptx: '📙',
      zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
      psd: '🎨', ai: '🎨', fig: '🎨', sketch: '🎨',
      aep: '🎞️', prproj: '🎞️',
      js: '📄', ts: '📄', py: '📄', html: '📄', css: '📄', json: '📄',
    };
    return map[ext] || '📄';
  }

  function handleFileClick(el) {
    const name = el.dataset.name;
    const type = el.dataset.type;

    if (type === 'directory') {
      // Check if already selected — if so, navigate
      if (state.selectedFolder === name) {
        const newPath = state.currentPath ? state.currentPath + '/' + name : name;
        loadFiles(newPath);
        return;
      }

      // Select this folder
      $fileGrid.querySelectorAll('.file-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      state.selectedFolder = name;

      // Show share action if not already visible
      let actionsRow = $fileGrid.querySelector('.file-actions');
      if (actionsRow) actionsRow.remove();
      actionsRow = document.createElement('div');
      actionsRow.className = 'file-actions';
      actionsRow.innerHTML = `
        <button class="btn btn-primary" id="btn-create-share">🔗 Create Share Link</button>
        <button class="btn btn-ghost" id="btn-open-folder">📂 Open Folder</button>
      `;
      $fileGrid.appendChild(actionsRow);

      document.getElementById('btn-create-share').addEventListener('click', () => openShareModal());
      document.getElementById('btn-open-folder').addEventListener('click', () => {
        const newPath = state.currentPath ? state.currentPath + '/' + name : name;
        loadFiles(newPath);
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     SHARE CREATION MODAL
     ═══════════════════════════════════════════════════════════════ */

  /* ── PIN toggle wiring ── */
  $pinToggle.addEventListener('change', () => {
    const on = $pinToggle.checked;
    $pinInput.disabled = !on;
    $pinGenerate.disabled = !on;
    if (!on) $pinInput.value = '';
  });

  $pinGenerate.addEventListener('click', () => {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    $pinInput.value = pin;
  });

  function openShareModal() {
    const folderPath = state.currentPath
      ? state.currentPath + '/' + state.selectedFolder
      : state.selectedFolder;

    $sharePathText.textContent = '/' + folderPath;

    // Populate defaults from settings
    const defExpiry = fromHours(state.settings.default_expiry_hours || state.settings.defaultExpiryHours || 24);
    $shareExpiry.value = defExpiry.value;
    $shareExpiryUnit.value = defExpiry.unit;
    $shareMaxDl.value = state.settings.default_max_downloads || state.settings.defaultMaxDownloads || 5;

    const maxExpiry = fromHours(state.settings.max_expiry_hours || state.settings.maxExpiryHours || 168);
    $shareExpiryHint.textContent = `Max allowed: ${maxExpiry.value} ${maxExpiry.unit}`;

    // Reset zip toggle (default checked)
    $zipToggle.checked = true;

    // Reset PIN fields
    $pinToggle.checked = false;
    $pinInput.value = '';
    $pinInput.disabled = true;
    $pinGenerate.disabled = true;

    // Show config step, hide others
    showModalStep('config');
    $modalOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeShareModal() {
    $modalOverlay.hidden = true;
    document.body.style.overflow = '';
  }

  function showModalStep(step) {
    $stepConfig.hidden = step !== 'config';
    $stepProgress.hidden = step !== 'progress';
    $stepDone.hidden = step !== 'done';
  }

  $modalClose.addEventListener('click', closeShareModal);
  $modalCancel.addEventListener('click', closeShareModal);
  $modalDoneClose.addEventListener('click', closeShareModal);
  $modalOverlay.addEventListener('click', (e) => {
    if (e.target === $modalOverlay) closeShareModal();
  });

  $shareCreateBtn.addEventListener('click', async () => {
    const folderPath = state.currentPath
      ? state.currentPath + '/' + state.selectedFolder
      : state.selectedFolder;

    const expiryValue = parseInt($shareExpiry.value, 10);
    const expiryUnit = $shareExpiryUnit.value;
    const maxDownloads = parseInt($shareMaxDl.value, 10);

    if (!expiryValue || expiryValue < 1) {
      toast('Please enter a valid expiry time', 'error');
      return;
    }
    if (!maxDownloads || maxDownloads < 1) {
      toast('Please enter a valid download limit', 'error');
      return;
    }

    const expiryHours = toHours(expiryValue, expiryUnit);
    const maxAllowed = state.settings.max_expiry_hours || state.settings.maxExpiryHours || 168;
    if (expiryHours > maxAllowed) {
      const max = fromHours(maxAllowed);
      toast(`Expiry cannot exceed ${max.value} ${max.unit}`, 'error');
      return;
    }

    // Validate PIN if enabled
    if ($pinToggle.checked && !$pinInput.value.trim()) {
      toast('Please enter a PIN or click Generate', 'error');
      return;
    }

    // Disable button, show loader
    const btnText = $shareCreateBtn.querySelector('.btn-text');
    const btnLoader = $shareCreateBtn.querySelector('.btn-loader');
    btnText.hidden = true;
    btnLoader.hidden = false;
    $shareCreateBtn.disabled = true;

    try {
      const res = await api('/api/shares', {
        method: 'POST',
        body: JSON.stringify({
          path: folderPath,
          expiry_hours: expiryHours,
          max_downloads: maxDownloads,
          zip: $zipToggle.checked,
          pin: $pinToggle.checked ? $pinInput.value.trim() : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create share');
      }
      const share = await res.json();

      // If not zipped or already ready, skip progress step
      if (share.is_zipped === 0 || share.is_zipped === false || share.status === 'ready') {
        const link = `${location.origin}${share.download_url || '/d/' + share.token}`;
        $shareLinkInput.value = link;
        showModalStep('done');
        loadShares();
        toast('Share link created!', 'success');
      } else {
        // Switch to progress step and poll
        showModalStep('progress');
        $zipFill.style.width = '0%';
        $zipPct.textContent = '0%';
        pollZipStatus(share.id || share.token);
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btnText.hidden = false;
      btnLoader.hidden = true;
      $shareCreateBtn.disabled = false;
    }
  });

  async function pollZipStatus(shareId) {
    let attempts = 0;
    const maxAttempts = 600; // 10 minutes at 1s intervals

    const poll = async () => {
      attempts++;
      try {
        const res = await api(`/api/shares/${shareId}/status`);
        if (!res.ok) throw new Error('Failed to check status');
        const data = await res.json();

        const pct = data.progress != null ? Math.round(data.progress) : 0;
        $zipFill.style.width = pct + '%';
        $zipPct.textContent = pct + '%';

        if (data.status === 'ready') {
          // Done
          const link = `${location.origin}${data.download_url || '/d/' + (data.token || shareId)}`;
          $shareLinkInput.value = link;
          showModalStep('done');
          loadShares(); // Refresh table
          toast('Share link created!', 'success');
          return;
        }

        if (data.status === 'error') {
          toast('Zip creation failed: ' + (data.error || 'Unknown error'), 'error');
          closeShareModal();
          return;
        }

        if (attempts < maxAttempts) {
          setTimeout(poll, 1000);
        } else {
          toast('Zip creation timed out', 'error');
          closeShareModal();
        }
      } catch (err) {
        toast('Error checking zip status', 'error');
        closeShareModal();
      }
    };

    poll();
  }

  // Copy link
  $copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($shareLinkInput.value);
      $copyLinkBtn.textContent = '✓ Copied!';
      toast('Link copied to clipboard', 'success');
      setTimeout(() => { $copyLinkBtn.textContent = 'Copy'; }, 2000);
    } catch {
      $shareLinkInput.select();
      document.execCommand('copy');
      $copyLinkBtn.textContent = '✓ Copied!';
      setTimeout(() => { $copyLinkBtn.textContent = 'Copy'; }, 2000);
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     ACTIVE SHARES
     ═══════════════════════════════════════════════════════════════ */

  async function loadShares() {
    try {
      const res = await api('/api/shares');
      if (!res.ok) throw new Error('Failed to load shares');
      const data = await res.json();
      state.shares = data.shares || data || [];
      renderShares(state.shares);
    } catch (err) {
      console.error('loadShares error:', err);
    }
  }

  function renderShares(shares) {
    const query = ($shareSearch.value || '').toLowerCase();
    const filtered = shares.filter(s => {
      if (!query) return true;
      return (
        (s.token || '').toLowerCase().includes(query) ||
        (s.path || '').toLowerCase().includes(query) ||
        (s.status || '').toLowerCase().includes(query) ||
        (s.createdBy || s.created_by || '').toLowerCase().includes(query)
      );
    });

    if (filtered.length === 0) {
      $sharesTbody.innerHTML = '';
      $sharesEmpty.hidden = false;
      return;
    }

    $sharesEmpty.hidden = true;

    $sharesTbody.innerHTML = filtered.map(share => {
      const status = (share.status || 'ready').toLowerCase();
      const statusMap = {
        ready:   { icon: '🟢', label: 'Ready',   cls: 'ready' },
        zipping: { icon: '🟡', label: 'Zipping', cls: 'zipping' },
        expired: { icon: '🔴', label: 'Expired', cls: 'expired' },
        revoked: { icon: '⚫', label: 'Revoked', cls: 'revoked' },
      };
      const st = statusMap[status] || statusMap.ready;
      const downloads = `${share.downloadCount ?? share.download_count ?? share.downloads ?? 0} / ${share.maxDownloads ?? share.max_downloads ?? '∞'}`;
      const expiresRel = relativeTime(share.expiresAt || share.expires_at);
      const expiresAbs = formatDate(share.expiresAt || share.expires_at);
      const createdBy = share.createdBy || share.created_by || '—';
      const token = share.token || share.id || '';
      const pinIndicator = share.pin_hash ? ' 🔒' : '';

      return `<tr>
        <td class="td-token" title="${escapeHtml(token)}">${escapeHtml(shortToken(token))}${pinIndicator}</td>
        <td class="td-path" title="${escapeHtml(share.path || '')}">${escapeHtml(share.path || '—')}</td>
        <td><span class="status-badge status-badge--${st.cls}">${st.icon} ${st.label}</span></td>
        <td>${escapeHtml(downloads)}</td>
        <td title="${escapeHtml(expiresAbs)}">${escapeHtml(expiresRel)}</td>
        <td>${escapeHtml(createdBy)}</td>
        <td class="td-actions">
          <button class="btn btn-ghost btn-sm" data-copy-share="${escapeHtml(token)}">📋 Copy</button>
          ${status === 'ready' || status === 'zipping'
            ? `<button class="btn btn-danger btn-sm" data-revoke="${escapeHtml(share.id || token)}">Revoke</button>`
            : ''}
        </td>
      </tr>`;
    }).join('');

    // Bind events
    $sharesTbody.querySelectorAll('[data-copy-share]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const t = btn.dataset.copyShare;
        const link = `${location.origin}/d/${t}`;
        try {
          await navigator.clipboard.writeText(link);
          btn.innerHTML = '✓ Copied!';
          toast('Link copied', 'success');
          setTimeout(() => { btn.innerHTML = '📋 Copy'; }, 2000);
        } catch {
          toast('Failed to copy', 'error');
        }
      });
    });

    $sharesTbody.querySelectorAll('[data-revoke]').forEach(btn => {
      btn.addEventListener('click', () => confirmRevoke(btn.dataset.revoke));
    });
  }

  $shareSearch.addEventListener('input', () => renderShares(state.shares));

  function startSharesRefresh() {
    stopSharesRefresh();
    state.sharesRefreshTimer = setInterval(() => loadShares(), 30000);
  }

  function stopSharesRefresh() {
    if (state.sharesRefreshTimer) {
      clearInterval(state.sharesRefreshTimer);
      state.sharesRefreshTimer = null;
    }
  }

  /* ── CONFIRM / REVOKE ── */
  let confirmCallback = null;

  function confirmRevoke(shareId) {
    $confirmTitle.textContent = 'Revoke Share';
    $confirmMsg.textContent = 'Are you sure you want to revoke this share link? This cannot be undone.';
    $confirmOk.textContent = 'Revoke';
    $confirmOverlay.hidden = false;
    document.body.style.overflow = 'hidden';

    confirmCallback = async () => {
      try {
        const res = await api(`/api/shares/${shareId}/revoke`, { method: 'POST' });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to revoke');
        }
        toast('Share revoked', 'success');
        loadShares();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  function closeConfirm() {
    $confirmOverlay.hidden = true;
    document.body.style.overflow = '';
    confirmCallback = null;
  }

  $confirmOk.addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeConfirm();
  });
  $confirmCancel.addEventListener('click', closeConfirm);
  $confirmCloseX.addEventListener('click', closeConfirm);
  $confirmOverlay.addEventListener('click', (e) => {
    if (e.target === $confirmOverlay) closeConfirm();
  });

  /* ═══════════════════════════════════════════════════════════════
     SETTINGS
     ═══════════════════════════════════════════════════════════════ */

  async function loadSettings() {
    try {
      const res = await api('/api/settings');
      if (!res.ok) return;
      const data = await res.json();
      state.settings = data;
      populateSettings(data);
    } catch (err) {
      console.error('loadSettings error:', err);
    }
  }

  function populateSettings(s) {
    // Default Expiry
    const defExp = fromHours(s.defaultExpiryHours || s.default_expiry_hours || 24);
    document.getElementById('set-default-expiry').value = defExp.value;
    document.getElementById('set-default-expiry-unit').value = defExp.unit;

    // Max Expiry
    const maxExp = fromHours(s.maxExpiryHours || s.max_expiry_hours || 168);
    document.getElementById('set-max-expiry').value = maxExp.value;
    document.getElementById('set-max-expiry-unit').value = maxExp.unit;

    // Default Max Downloads
    document.getElementById('set-default-max-downloads').value =
      s.defaultMaxDownloads || s.default_max_downloads || 5;

    // Max Zip Size
    document.getElementById('set-max-zip-size').value =
      s.maxZipSizeMB || s.max_zip_size_mb || 500;

    // Browse Root
    document.getElementById('set-browse-root').value =
      s.browseRoot || s.browse_root || '';
  }

  // Save handlers
  document.querySelectorAll('[data-save]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.save;
      let payload = {};

      switch (key) {
        case 'defaultExpiry': {
          const val = parseInt(document.getElementById('set-default-expiry').value, 10);
          const unit = document.getElementById('set-default-expiry-unit').value;
          if (!val || val < 1) { toast('Enter a valid expiry', 'error'); return; }
          payload = { default_expiry_hours: toHours(val, unit) };
          break;
        }
        case 'maxExpiry': {
          const val = parseInt(document.getElementById('set-max-expiry').value, 10);
          const unit = document.getElementById('set-max-expiry-unit').value;
          if (!val || val < 1) { toast('Enter a valid max expiry', 'error'); return; }
          payload = { max_expiry_hours: toHours(val, unit) };
          break;
        }
        case 'defaultMaxDownloads': {
          const val = parseInt(document.getElementById('set-default-max-downloads').value, 10);
          if (!val || val < 1) { toast('Enter a valid download limit', 'error'); return; }
          payload = { default_max_downloads: val };
          break;
        }
        case 'maxZipSize': {
          const val = parseInt(document.getElementById('set-max-zip-size').value, 10);
          if (!val || val < 1) { toast('Enter a valid zip size limit', 'error'); return; }
          payload = { max_zip_size_mb: val };
          break;
        }
        case 'browseRoot': {
          payload = { browse_root: document.getElementById('set-browse-root').value.trim() };
          break;
        }
      }

      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        const res = await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to save');
        }
        const updated = await res.json();
        state.settings = { ...state.settings, ...updated };
        toast('Setting saved', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════════ */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$modalOverlay.hidden) closeShareModal();
      if (!$confirmOverlay.hidden) closeConfirm();
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════════════ */
  if (state.user) {
    showApp();
  } else {
    showLogin();
  }

})();
