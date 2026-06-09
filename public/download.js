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

  // PIN elements
  const $pinInput   = document.getElementById('dl-pin-input');
  const $pinSubmit  = document.getElementById('dl-pin-submit');
  const $pinError   = document.getElementById('dl-pin-error');

  let countdownTimer = null;
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
    [$loading, $pin, $preparing, $ready, $expired, $revoked, $limit, $error].forEach(el => {
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

    // Ready
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
