/* ═══════════════════════════════════════════════════════════════
   PLUTO HORIZON — Download Page JavaScript
   Public-facing download page logic: status polling, countdown,
   PIN verification, download initiation, error states
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── DOM REFS ──────────────────────────────────────────────── */
  const $loading    = document.getElementById('dl-loading');
  const $pin        = document.getElementById('dl-pin');
  const $preparing  = document.getElementById('dl-preparing');
  const $ready      = document.getElementById('dl-ready');
  const $expired    = document.getElementById('dl-expired');
  const $revoked    = document.getElementById('dl-revoked');
  const $limit      = document.getElementById('dl-limit');
  const $error      = document.getElementById('dl-error');
  const $browser    = document.getElementById('dl-browser');
  const $errorText  = document.getElementById('dl-error-text');

  const $fileName   = document.getElementById('dl-file-name');
  const $fileSize   = document.getElementById('dl-file-size');
  const $dlLeft     = document.getElementById('dl-downloads-left');
  const $dlBtn      = document.getElementById('dl-btn');

  const $progressFill = document.getElementById('dl-progress-fill');
  const $progressPct  = document.getElementById('dl-progress-pct');

  const $cdDays  = document.getElementById('cd-days');
  const $cdHours = document.getElementById('cd-hours');
  const $cdMins  = document.getElementById('cd-mins');
  const $cdSecs  = document.getElementById('cd-secs');

  // Browser elements
  const $browserTitle     = document.getElementById('dl-browser-title');
  const $browserDownloads = document.getElementById('dl-browser-downloads');
  const $browserBreadcrumb = document.getElementById('dl-browser-breadcrumb');
  const $browserGrid      = document.getElementById('dl-browser-grid');
  const $cd2Days  = document.getElementById('cd2-days');
  const $cd2Hours = document.getElementById('cd2-hours');
  const $cd2Mins  = document.getElementById('cd2-mins');
  const $cd2Secs  = document.getElementById('cd2-secs');

  // PIN elements
  const $pinInput   = document.getElementById('dl-pin-input');
  const $pinSubmit  = document.getElementById('dl-pin-submit');
  const $pinError   = document.getElementById('dl-pin-error');

  let countdownTimer = null;
  let countdownTimer2 = null;
  let shareData = null;

  /* ── HELPERS ───────────────────────────────────────────────── */

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '—';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function getToken() {
    // Extract token from URL: /download/:token or /d/:token or ?token=...
    const parts = window.location.pathname.split('/').filter(Boolean);
    // Try path like /download/abc123 or /d/abc123
    if (parts.length >= 2) {
      return parts[parts.length - 1];
    }
    // Try query param
    const params = new URLSearchParams(window.location.search);
    return params.get('token') || params.get('t') || null;
  }

  function showState(stateId) {
    [$loading, $pin, $preparing, $ready, $browser, $expired, $revoked, $limit, $error].forEach(el => {
      if (el) el.hidden = true;
    });
    const el = document.getElementById(`dl-${stateId}`);
    if (el) {
      el.hidden = false;
      // Re-trigger animation
      el.style.animation = 'none';
      el.offsetHeight;
      el.style.animation = '';
    }
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /* ── COUNTDOWN ─────────────────────────────────────────────── */

  function startCountdown(expiresAt) {
    if (countdownTimer) clearInterval(countdownTimer);

    const targetMs = new Date(expiresAt).getTime();

    function tick() {
      const now = Date.now();
      const diff = targetMs - now;

      if (diff <= 0) {
        clearInterval(countdownTimer);
        $cdDays.textContent  = '00';
        $cdHours.textContent = '00';
        $cdMins.textContent  = '00';
        $cdSecs.textContent  = '00';
        // Switch to expired state
        showState('expired');
        return;
      }

      const totalSecs = Math.floor(diff / 1000);
      const days  = Math.floor(totalSecs / 86400);
      const hours = Math.floor((totalSecs % 86400) / 3600);
      const mins  = Math.floor((totalSecs % 3600) / 60);
      const secs  = totalSecs % 60;

      $cdDays.textContent  = pad(days);
      $cdHours.textContent = pad(hours);
      $cdMins.textContent  = pad(mins);
      $cdSecs.textContent  = pad(secs);
    }

    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /* ── POLL ZIP PROGRESS ─────────────────────────────────────── */

  async function pollPreparing(token) {
    let attempts = 0;
    const maxAttempts = 600;

    const poll = async () => {
      attempts++;
      try {
        const res = await fetch(`/d/${token}/status`, { credentials: 'include' });
        if (!res.ok) {
          // Fallback to old endpoint
          const res2 = await fetch(`/api/shares/${token}/status`, { credentials: 'include' });
          if (!res2.ok) throw new Error('Status check failed');
          const data = await res2.json();
          handlePollData(data, token);
          return;
        }
        const data = await res.json();
        handlePollData(data, token);
      } catch {
        if (attempts < 3) {
          setTimeout(poll, 2000);
        } else {
          $errorText.textContent = 'Failed to check preparation status.';
          showState('error');
        }
      }
    };

    function handlePollData(data, token) {
      const pct = data.progress != null ? Math.round(data.progress) : 0;
      $progressFill.style.width = pct + '%';
      $progressPct.textContent = pct + '%';

      if (data.status === 'ready') {
        // Merge any new data
        if (data.zipSize || data.zip_size) {
          shareData.zipSize = data.zipSize || data.zip_size;
        }
        showReady();
        return;
      }

      if (data.status === 'error') {
        $errorText.textContent = 'There was an error preparing this download.';
        showState('error');
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(poll, 1500);
      } else {
        $errorText.textContent = 'Preparation timed out. Please try again later.';
        showState('error');
      }
    }

    showState('preparing');
    poll();
  }

  /* ── SHOW READY STATE ──────────────────────────────────────── */

  function showReady() {
    if (!shareData) return;

    const name = shareData.folderName || shareData.folder_name || shareData.path || 'Download';
    $fileName.textContent = name;

    const zipSize = shareData.zipSize || shareData.zip_size;
    const fileSize = shareData.fileSize || shareData.file_size;
    $fileSize.textContent = (zipSize || fileSize) ? formatBytes(zipSize || fileSize) : '';

    const dlCount = shareData.downloadCount ?? shareData.download_count ?? shareData.downloads ?? 0;
    const maxDl = shareData.maxDownloads ?? shareData.max_downloads;
    if (maxDl) {
      const remaining = Math.max(0, maxDl - dlCount);
      $dlLeft.textContent = `${remaining} download${remaining !== 1 ? 's' : ''} remaining`;
    } else {
      $dlLeft.textContent = '';
    }

    showState('ready');

    const expiresAt = shareData.expiresAt || shareData.expires_at;
    if (expiresAt) {
      startCountdown(expiresAt);
    }
  }

  /* ── PIN VERIFICATION ─────────────────────────────────────── */

  function showPinEntry(token) {
    showState('pin');
    $pinError.hidden = true;
    $pinInput.value = '';

    const handleVerify = async () => {
      const pin = $pinInput.value.trim();
      if (!pin) {
        $pinError.textContent = 'Please enter the PIN.';
        $pinError.hidden = false;
        return;
      }

      $pinSubmit.disabled = true;
      const btnText = $pinSubmit.querySelector('.dl-btn-text');
      if (btnText) btnText.textContent = 'Verifying…';

      try {
        const res = await fetch(`/d/${token}/verify-pin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ pin }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Invalid PIN');
        }

        // PIN verified — re-fetch share info (cookie now set)
        showState('loading');
        const infoRes = await fetch(`/d/${token}/info`, { credentials: 'include' });

        if (!infoRes.ok) {
          $errorText.textContent = 'Could not load share information.';
          showState('error');
          return;
        }

        const data = await infoRes.json();
        shareData = data;
        processShareData(data, token);

      } catch (err) {
        $pinError.textContent = err.message;
        $pinError.hidden = false;
      } finally {
        $pinSubmit.disabled = false;
        if (btnText) btnText.textContent = 'Verify';
      }
    };

    // Remove old listeners by cloning
    const newSubmit = $pinSubmit.cloneNode(true);
    $pinSubmit.parentNode.replaceChild(newSubmit, $pinSubmit);

    // Re-assign since we replaced the node
    const $newPinSubmit = document.getElementById('dl-pin-submit');
    $newPinSubmit.addEventListener('click', handleVerify);

    // Also handle Enter key on pin input
    const newPinInput = document.getElementById('dl-pin-input');
    newPinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleVerify();
      }
    });
  }

  /* ── PROCESS SHARE DATA ─────────────────────────────────────── */

  function processShareData(data, token) {
    const status = (data.status || '').toLowerCase();

    // Check states
    if (status === 'revoked') {
      showState('revoked');
      return;
    }

    if (status === 'expired') {
      showState('expired');
      return;
    }

    // Check if expired by date
    const expiresAt = data.expiresAt || data.expires_at;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      showState('expired');
      return;
    }

    // Check download limit
    const dlCount = data.downloadCount ?? data.download_count ?? data.downloads ?? 0;
    const maxDl = data.maxDownloads ?? data.max_downloads;
    if (maxDl && dlCount >= maxDl) {
      showState('limit');
      return;
    }

    // Check if still zipping
    if (status === 'zipping' || status === 'preparing') {
      pollPreparing(token);
      return;
    }

    // If it's a browsable directory (non-zipped), show file browser
    if (data.is_directory && (data.is_zipped === 0 || data.is_zipped === false)) {
      showFileBrowser(data, token);
      return;
    }

    // Ready (single file or zipped directory)
    showReady();
  }

  /* ── DOWNLOAD BUTTON ───────────────────────────────────────── */

  $dlBtn.addEventListener('click', () => {
    const token = getToken();
    if (!token) return;

    // Trigger download via navigating to API endpoint
    window.location.href = `/d/${token}/download`;

    // Update the remaining count optimistically
    if (shareData) {
      const dlCount = (shareData.downloadCount ?? shareData.download_count ?? shareData.downloads ?? 0) + 1;
      const maxDl = shareData.maxDownloads ?? shareData.max_downloads;
      if (maxDl) {
        shareData.downloadCount = dlCount;
        const remaining = Math.max(0, maxDl - dlCount);
        $dlLeft.textContent = `${remaining} download${remaining !== 1 ? 's' : ''} remaining`;
        if (remaining <= 0) {
          setTimeout(() => showState('limit'), 1500);
        }
      }
    }
  });

  /* ── FILE BROWSER ───────────────────────────────────────────── */

  function showFileBrowser(data, token) {
    $browserTitle.textContent = data.folder_name || data.folderName || data.source_path || 'Shared Files';

    const dlCount = data.download_count ?? data.downloadCount ?? 0;
    const maxDl = data.max_downloads ?? data.maxDownloads;
    if (maxDl) {
      const remaining = Math.max(0, maxDl - dlCount);
      $browserDownloads.textContent = `${remaining} download${remaining !== 1 ? 's' : ''} remaining`;
    } else {
      $browserDownloads.textContent = '';
    }

    showState('browser');
    loadShareFiles(token, '');

    // Start countdown on the browser's timer
    const expiresAt = data.expires_at || data.expiresAt;
    if (expiresAt) {
      startCountdown2(expiresAt);
    }
  }

  function startCountdown2(expiresAt) {
    if (countdownTimer2) clearInterval(countdownTimer2);

    const targetMs = new Date(expiresAt).getTime();

    function tick() {
      const now = Date.now();
      const diff = targetMs - now;

      if (diff <= 0) {
        clearInterval(countdownTimer2);
        $cd2Days.textContent  = '00';
        $cd2Hours.textContent = '00';
        $cd2Mins.textContent  = '00';
        $cd2Secs.textContent  = '00';
        showState('expired');
        return;
      }

      const totalSecs = Math.floor(diff / 1000);
      const days  = Math.floor(totalSecs / 86400);
      const hours = Math.floor((totalSecs % 86400) / 3600);
      const mins  = Math.floor((totalSecs % 3600) / 60);
      const secs  = totalSecs % 60;

      $cd2Days.textContent  = pad(days);
      $cd2Hours.textContent = pad(hours);
      $cd2Mins.textContent  = pad(mins);
      $cd2Secs.textContent  = pad(secs);
    }

    tick();
    countdownTimer2 = setInterval(tick, 1000);
  }

  async function loadShareFiles(token, browsePath) {
    $browserGrid.innerHTML = '<div class="dl-browser-empty"><div class="spinner"></div><p>Loading…</p></div>';
    renderBrowserBreadcrumb(token, browsePath);

    try {
      const res = await fetch(`/d/${token}/files?path=${encodeURIComponent(browsePath)}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load files');
      const data = await res.json();
      renderBrowserFiles(data.entries || [], token, browsePath);
    } catch (err) {
      $browserGrid.innerHTML = `<div class="dl-browser-empty">⚠️ ${err.message}</div>`;
    }
  }

  function renderBrowserBreadcrumb(token, browsePath) {
    $browserBreadcrumb.innerHTML = '';

    // Root button
    const rootBtn = document.createElement('button');
    rootBtn.className = 'dl-breadcrumb-item';
    rootBtn.textContent = '📂 Root';
    if (!browsePath) {
      rootBtn.classList.add('active');
    } else {
      rootBtn.addEventListener('click', () => loadShareFiles(token, ''));
    }
    $browserBreadcrumb.appendChild(rootBtn);

    if (browsePath) {
      const parts = browsePath.split('/').filter(Boolean);
      let accumulated = '';
      parts.forEach((part, idx) => {
        // Add separator
        const sep = document.createElement('span');
        sep.className = 'dl-breadcrumb-sep';
        sep.textContent = '›';
        $browserBreadcrumb.appendChild(sep);

        accumulated += (accumulated ? '/' : '') + part;
        const btn = document.createElement('button');
        btn.className = 'dl-breadcrumb-item';
        btn.textContent = part;

        if (idx === parts.length - 1) {
          btn.classList.add('active');
        } else {
          const path = accumulated;
          btn.addEventListener('click', () => loadShareFiles(token, path));
        }
        $browserBreadcrumb.appendChild(btn);
      });
    }
  }

  function renderBrowserFiles(entries, token, browsePath) {
    $browserGrid.innerHTML = '';

    if (!entries.length) {
      $browserGrid.innerHTML = '<div class="dl-browser-empty">📭 This folder is empty</div>';
      return;
    }

    // Sort: directories first, then files alphabetically
    entries.sort((a, b) => {
      const aDir = a.type === 'directory' ? 0 : 1;
      const bDir = b.type === 'directory' ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return (a.name || '').localeCompare(b.name || '');
    });

    entries.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'dl-file-item';
      item.dataset.type = entry.type || 'file';

      const isDir = entry.type === 'directory';
      const icon = isDir ? '📁' : getFileIcon(entry.name || '');

      const iconEl = document.createElement('span');
      iconEl.className = 'dl-file-item-icon';
      iconEl.textContent = icon;

      const infoEl = document.createElement('div');
      infoEl.className = 'dl-file-item-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'dl-file-item-name';
      nameEl.textContent = entry.name || 'Unnamed';
      nameEl.title = entry.name || '';
      infoEl.appendChild(nameEl);

      if (!isDir && entry.size != null) {
        const sizeEl = document.createElement('div');
        sizeEl.className = 'dl-file-item-size';
        sizeEl.textContent = formatBytes(entry.size);
        infoEl.appendChild(sizeEl);
      } else if (isDir) {
        const metaEl = document.createElement('div');
        metaEl.className = 'dl-file-item-size';
        metaEl.textContent = 'Folder';
        infoEl.appendChild(metaEl);
      }

      item.appendChild(iconEl);
      item.appendChild(infoEl);

      if (isDir) {
        // Click to navigate into folder
        const newPath = browsePath ? browsePath + '/' + entry.name : entry.name;
        item.addEventListener('click', () => loadShareFiles(token, newPath));
      } else {
        // Download button for files
        const dlBtn = document.createElement('button');
        dlBtn.className = 'dl-file-item-dl';
        dlBtn.textContent = '⬇ Download';
        const filePath = browsePath ? browsePath + '/' + entry.name : entry.name;
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.location.href = `/d/${token}/file?path=${encodeURIComponent(filePath)}`;
        });
        item.appendChild(dlBtn);
      }

      $browserGrid.appendChild(item);
    });
  }

  function getFileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      // Video
      mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', wmv: '🎬', flv: '🎬', webm: '🎬',
      // Audio
      mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', m4a: '🎵', wma: '🎵',
      // Images
      jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', svg: '🖼️',
      webp: '🖼️', tiff: '🖼️', tif: '🖼️', ico: '🖼️', psd: '🖼️', raw: '🖼️',
      // Documents
      pdf: '📄', doc: '📝', docx: '📝', txt: '📝', rtf: '📝', odt: '📝',
      // Spreadsheets
      xls: '📊', xlsx: '📊', csv: '📊', ods: '📊',
      // Presentations
      ppt: '📊', pptx: '📊', odp: '📊',
      // Archives
      zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦', bz2: '📦',
      // Code
      js: '💻', ts: '💻', py: '💻', html: '💻', css: '💻', json: '💻',
      xml: '💻', yaml: '💻', yml: '💻', sh: '💻', bat: '💻',
      // 3D / Design
      blend: '🎨', fbx: '🎨', obj: '🎨', stl: '🎨', c4d: '🎨',
      // Project files
      aep: '🎬', prproj: '🎬', drp: '🎬',
      // Fonts
      ttf: '🔤', otf: '🔤', woff: '🔤', woff2: '🔤',
      // Executables
      exe: '⚙️', msi: '⚙️', dmg: '⚙️', app: '⚙️',
    };
    return map[ext] || '📄';
  }

  /* ── INIT ──────────────────────────────────────────────────── */

  async function init() {
    const token = getToken();

    if (!token) {
      $errorText.textContent = 'No share token provided. Please check the URL.';
      showState('error');
      return;
    }

    try {
      const res = await fetch(`/d/${token}/info`, { credentials: 'include' });

      if (res.status === 404) {
        showState('error');
        return;
      }

      if (!res.ok) {
        $errorText.textContent = 'Could not load share information.';
        showState('error');
        return;
      }

      const data = await res.json();
      shareData = data;

      // Check if PIN is required
      if (data.pin_required) {
        showPinEntry(token);
        return;
      }

      processShareData(data, token);

    } catch (err) {
      console.error('Init error:', err);
      $errorText.textContent = 'Something went wrong. Please try again later.';
      showState('error');
    }
  }

  init();

})();
