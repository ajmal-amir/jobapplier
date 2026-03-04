// ═══════════════════════════════════════════════════════════════════════════════
// FILE: popup/popup.js
// PURPOSE: Controls the popup window's behavior and UI.
//          Communicates with the background service worker to start/stop
//          automation and display current status.
//
// HOW POPUP JS DIFFERS FROM CONTENT SCRIPTS:
//   - Popup JS runs in the popup page's context (not in any website)
//   - It can access chrome.runtime (to message background)
//   - It CAN'T directly access the DOM of the website the user is browsing
//   - Every time the user closes the popup, this JS stops running
//     → All state must be fetched fresh each time the popup opens
// ═══════════════════════════════════════════════════════════════════════════════

// ── DOMContentLoaded ──────────────────────────────────────────────────────────
// Wait for the HTML to fully parse before running any JS.
// If we try to access elements before they exist, we get null → crashes.
document.addEventListener('DOMContentLoaded', async () => {

  // ── GET ELEMENT REFERENCES ─────────────────────────────────────────────
  // Store references to DOM elements we'll update frequently.
  // Doing this once is faster than calling getElementById every time.
  const statusDot     = document.getElementById('statusDot');
  const statusText    = document.getElementById('statusText');
  const dailyCounter  = document.getElementById('dailyCounter');
  const warningBanner = document.getElementById('warningBanner');
  const warningMsg    = document.getElementById('warningText');
  const configStatus  = document.getElementById('configStatus');

  const btnStart      = document.getElementById('btnStart');
  const btnPause      = document.getElementById('btnPause');
  const btnStop       = document.getElementById('btnStop');
  const btnSettings   = document.getElementById('btnSettings');
  const btnViewLog    = document.getElementById('btnViewLog');
  const btnLinkedIn   = document.getElementById('btnLinkedIn');
  const btnIndeed     = document.getElementById('btnIndeed');

  const statApplied   = document.getElementById('statApplied');
  const statSkipped   = document.getElementById('statSkipped');
  const statFailed    = document.getElementById('statFailed');
  const statScanned   = document.getElementById('statScanned');
  const activityLog   = document.getElementById('activityLog');

  const chkLinkedIn   = document.getElementById('chkLinkedIn');
  const chkIndeed     = document.getElementById('chkIndeed');

  // ── INITIAL DATA LOAD ──────────────────────────────────────────────────
  // When the popup opens, fetch current status from the background worker
  await refreshStatus();
  await checkConfiguration();
  await loadRecentLog();

  // ── AUTO-REFRESH ───────────────────────────────────────────────────────
  // Refresh the status every 3 seconds while the popup is open.
  // setInterval() runs a function repeatedly at a given interval (in ms).
  const refreshInterval = setInterval(refreshStatus, 3000);

  // When the popup closes, clear the interval to avoid memory leaks
  // The 'visibilitychange' event fires when the popup gains/loses visibility
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(refreshInterval); // Popup hidden/closed → stop refreshing
    }
  });

  // ── BUTTON EVENT LISTENERS ────────────────────────────────────────────
  // addEventListener() attaches a function to run when an event fires.
  // Here we listen for 'click' events on each button.

  btnStart.addEventListener('click', async () => {
    // Disable the button immediately to prevent double-clicks
    btnStart.disabled = true;
    btnStart.textContent = '⏳ Starting...';

    try {
      // Send message to background worker to start the automation
      // chrome.runtime.sendMessage() sends a message to the background script
      const response = await sendMessage('START_AUTOMATION', {});

      if (response.success) {
        updateStatus({ isRunning: true, isPaused: false });
        showNotification('Automation started! Navigate to LinkedIn or Indeed.', 'success');
      } else {
        // Start failed — show the error (e.g., "API key not set")
        showWarning(response.error || 'Failed to start automation');
        btnStart.disabled = false;
        btnStart.textContent = '▶ Start';
      }
    } catch (err) {
      showWarning('Could not connect to background script: ' + err.message);
      btnStart.disabled = false;
      btnStart.textContent = '▶ Start';
    }
  });

  btnPause.addEventListener('click', async () => {
    const response = await sendMessage('PAUSE_AUTOMATION', {});
    if (response.success) {
      updateStatus({ isRunning: true, isPaused: response.isPaused });
    }
  });

  btnStop.addEventListener('click', async () => {
    // Confirm before stopping — the user might have clicked accidentally
    if (!confirm('Stop the automation? Your session stats will be cleared.')) return;

    const response = await sendMessage('STOP_AUTOMATION', {});
    if (response.success) {
      updateStatus({ isRunning: false, isPaused: false });
      showNotification('Automation stopped.', 'info');
    }
  });

  // Settings button: open the options page in a new browser tab
  btnSettings.addEventListener('click', () => {
    // chrome.runtime.openOptionsPage() opens the page defined in manifest.json "options_page"
    chrome.runtime.openOptionsPage();
  });

  // View log button: open options page (which has the full log tab)
  btnViewLog.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Quick navigation: open LinkedIn job search in a new tab
  btnLinkedIn.addEventListener('click', () => {
    // Open LinkedIn jobs for "Software Engineer" in Charlotte, NC
    // encodeURIComponent() makes the URL safe by escaping special characters
    const query    = encodeURIComponent('Software Engineer AI Engineer');
    const location = encodeURIComponent('Charlotte, North Carolina');
    chrome.tabs.create({
      url: `https://www.linkedin.com/jobs/search/?keywords=${query}&location=${location}&f_TPR=r86400`
      // f_TPR=r86400 filters to jobs posted in the last 24 hours (86400 seconds)
    });
  });

  btnIndeed.addEventListener('click', () => {
    const query    = encodeURIComponent('Software Engineer AI Engineer');
    const location = encodeURIComponent('Charlotte, NC');
    chrome.tabs.create({
      url: `https://www.indeed.com/jobs?q=${query}&l=${location}&fromage=1`
      // fromage=1 filters to jobs posted in the last 1 day
    });
  });

  // ── HELPER FUNCTIONS ──────────────────────────────────────────────────

  // sendMessage() wraps chrome.runtime.sendMessage() in a Promise
  // so we can use async/await instead of callbacks.
  function sendMessage(action, data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action, data }, (response) => {
        // chrome.runtime.lastError occurs if the background script isn't running
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: 'No response' });
        }
      });
    });
  }

  // refreshStatus() fetches current state from background and updates the UI
  async function refreshStatus() {
    const response = await sendMessage('GET_STATUS', {});
    if (!response.success) return; // Background might be restarting — skip silently

    // Update stats
    statApplied.textContent = response.sessionStats?.applied  || 0;
    statSkipped.textContent = response.sessionStats?.skipped  || 0;
    statFailed.textContent  = response.sessionStats?.failed   || 0;
    statScanned.textContent = response.sessionStats?.totalScanned || 0;

    // Update daily counter pill
    const current = response.dailyCount || 0;
    const limit   = response.dailyLimit || 30;
    dailyCounter.textContent = `${current} / ${limit} today`;

    // Update running/paused/stopped state
    updateStatus({
      isRunning: response.isRunning,
      isPaused:  response.isPaused,
    });

    // Refresh the activity log
    await loadRecentLog();
  }

  // updateStatus() changes the visual state of the status indicator and buttons
  function updateStatus({ isRunning, isPaused }) {
    // Remove all state classes and re-add the correct one
    statusDot.classList.remove('running', 'paused', 'stopped');

    if (isRunning && !isPaused) {
      statusDot.classList.add('running');
      statusText.textContent = '🟢 Running';
      btnStart.disabled  = true;    // Can't start if already running
      btnPause.disabled  = false;   // Can pause
      btnStop.disabled   = false;   // Can stop
      btnPause.textContent = '⏸ Pause';
    } else if (isRunning && isPaused) {
      statusDot.classList.add('paused');
      statusText.textContent = '⏸ Paused';
      btnStart.disabled  = true;
      btnPause.disabled  = false;
      btnStop.disabled   = false;
      btnPause.textContent = '▶ Resume';
    } else {
      statusDot.classList.add('stopped');
      statusText.textContent = 'Stopped';
      btnStart.disabled  = false;   // Can start when stopped
      btnPause.disabled  = true;    // Can't pause if not running
      btnStop.disabled   = true;    // Can't stop if not running
      btnStart.textContent = '▶ Start';
    }
  }

  // checkConfiguration() validates that all required settings are configured
  async function checkConfiguration() {
    // Ask background to load config and check completeness
    const response = await sendMessage('GET_CONFIG', {});

    if (!response.success) return;

    const issues = [];

    // Check for required fields
    if (!response.hasApiKey)        issues.push('OpenAI API key missing');
    if (!response.resume)           issues.push('Resume not set');
    if (!response.profile?.email)   issues.push('Email address missing');

    if (issues.length > 0) {
      // Show warning banner with first issue
      warningBanner.classList.remove('hidden');
      warningMsg.textContent = issues[0] + ' — click ⚙️ to fix';
      configStatus.textContent = `⚠️ ${issues.length} setup issue(s)`;
      configStatus.style.color = '#d97706';
    } else {
      // All good!
      warningBanner.classList.add('hidden');
      configStatus.textContent = '✅ Ready';
      configStatus.style.color = '#16a34a';
    }
  }

  // loadRecentLog() fetches and displays the 5 most recent job actions
  async function loadRecentLog() {
    const response = await sendMessage('GET_LOG', { limit: 5 });
    if (!response.success || !response.log) return;

    const log = response.log;

    if (log.length === 0) {
      // No log entries yet — show placeholder
      activityLog.innerHTML = '<p class="log-empty">No recent activity. Start the automation to begin!</p>';
      return;
    }

    // Build HTML for each log entry
    // .map() transforms each entry into an HTML string, .join() concatenates them
    const entriesHtml = log.map(entry => {
      // Determine the icon and CSS class based on status
      const icon  = entry.status === 'applied' ? '✅' : entry.status === 'failed' ? '❌' : '⏭️';
      const cssClass = `log-entry status-${entry.status}`;

      // Format the time (extract HH:MM from ISO string)
      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit'
      });

      // Template literal builds the HTML string
      return `
        <div class="${cssClass}">
          <span class="log-entry-icon">${icon}</span>
          <div>
            <div class="log-entry-title">${escapeHtml(entry.jobTitle)}</div>
            <div class="log-entry-company">${escapeHtml(entry.company)} · ${time}</div>
          </div>
          <span class="log-entry-score">${entry.matchScore}%</span>
        </div>
      `;
    }).join(''); // Join all HTML strings into one

    // innerHTML sets the HTML content of the log container
    activityLog.innerHTML = entriesHtml;
  }

  // showWarning() displays an error/warning in the banner
  function showWarning(message) {
    warningBanner.classList.remove('hidden');
    warningMsg.textContent = message;
    // Auto-hide after 5 seconds
    setTimeout(() => warningBanner.classList.add('hidden'), 5000);
  }

  // showNotification() creates a brief floating notification
  function showNotification(message, type = 'info') {
    // We repurpose the warning banner for success messages too
    warningMsg.textContent = message;
    warningBanner.classList.remove('hidden');
    warningBanner.style.background = type === 'success' ? '#dcfce7' : '#f0f9ff';
    setTimeout(() => warningBanner.classList.add('hidden'), 3000);
  }

  // escapeHtml() prevents XSS when inserting user data into innerHTML
  // Never use innerHTML with un-escaped user data!
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

}); // end DOMContentLoaded
