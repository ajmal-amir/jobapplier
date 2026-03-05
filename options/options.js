// ═══════════════════════════════════════════════════════════════════════════════
// FILE: options/options.js
// PURPOSE: Manages the settings page — loading saved values, handling user
//          input, saving to chrome.storage, and rendering the log table.
//
// KEY CONCEPTS DEMONSTRATED HERE:
//   - chrome.storage API for persistent settings
//   - Tab navigation (show/hide panels)
//   - Form validation
//   - Dynamic table rendering
//   - CSV export
//   - Slider with live value display
// ═══════════════════════════════════════════════════════════════════════════════

// ── Wait for DOM to be ready ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {

  // ── TAB NAVIGATION SETUP ──────────────────────────────────────────────────
  // Get all tab buttons and panels
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels  = document.querySelectorAll('.tab-panel');

  // querySelectorAll() returns a NodeList — like an array of elements.
  // We attach click listeners to each button.
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.getAttribute('data-tab'); // e.g., "api", "profile"

      // Remove 'active' class from all buttons and panels (hide everything)
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabPanels.forEach(panel => panel.classList.remove('active'));

      // Add 'active' to the clicked button and its corresponding panel
      button.classList.add('active');
      document.getElementById(`tab-${targetTab}`).classList.add('active');

      // If the user clicked the log tab, reload the log
      if (targetTab === 'log') {
        loadApplicationLog();
      }
    });
  });

  // ── LOAD ALL SETTINGS ON PAGE OPEN ───────────────────────────────────────
  // Fill in all form fields with previously saved values.
  // NOTE: called AFTER all variable declarations so closure references are live.

  // ── SLIDER LIVE VALUE DISPLAY ─────────────────────────────────────────────
  // The match threshold slider should update its displayed value as it moves
  const slider  = document.getElementById('matchThreshold');
  const sliderOutput = document.getElementById('matchThresholdValue');

  if (slider) {
    // 'input' event fires on every change while dragging (unlike 'change' which fires on release)
    slider.addEventListener('input', () => {
      sliderOutput.value = slider.value; // Update the <output> element
    });
  }

  // ── RESUME CHARACTER COUNTER ──────────────────────────────────────────────
  const resumeTextarea = document.getElementById('resumeText');
  const charCount      = document.getElementById('resumeCharCount');
  const qualityDiv     = document.getElementById('resumeQuality');
  const qualityIcon    = document.getElementById('qualityIcon');
  const qualityText    = document.getElementById('qualityText');

  if (resumeTextarea) {
    resumeTextarea.addEventListener('input', () => {
      const len = resumeTextarea.value.length;
      charCount.textContent = `${len.toLocaleString()} characters`;

      // Give feedback on resume length
      qualityDiv.classList.remove('hidden');
      if (len < 200) {
        qualityIcon.textContent = '❌';
        qualityText.textContent = 'Resume too short — paste your full resume for best results';
        qualityDiv.style.borderColor = '#dc2626';
      } else if (len < 800) {
        qualityIcon.textContent = '⚠️';
        qualityText.textContent = 'Resume seems short — consider adding more detail';
        qualityDiv.style.borderColor = '#d97706';
      } else {
        qualityIcon.textContent = '✅';
        qualityText.textContent = `Good length! AI will use this to match and apply to jobs.`;
        qualityDiv.style.borderColor = '#16a34a';
      }
    });
  }

  // ── API KEY VISIBILITY TOGGLE ─────────────────────────────────────────────
  const apiKeyInput  = document.getElementById('openaiKey');
  const toggleVisBtn = document.getElementById('toggleKeyVisibility');

  if (toggleVisBtn && apiKeyInput) {
    toggleVisBtn.addEventListener('click', () => {
      // Toggle between "password" (hidden) and "text" (visible) types
      const isHidden = apiKeyInput.type === 'password';
      apiKeyInput.type = isHidden ? 'text' : 'password';
      toggleVisBtn.textContent = isHidden ? '🙈' : '👁️'; // Update button icon
    });
  }

  // ── TEST API KEY BUTTON ───────────────────────────────────────────────────
  const testApiBtn   = document.getElementById('testApiKey');
  const apiKeyStatus = document.getElementById('apiKeyStatus');

  if (testApiBtn) {
    testApiBtn.addEventListener('click', async () => {
      const apiKey = apiKeyInput.value.trim();
      if (!apiKey) {
        setStatus(apiKeyStatus, 'Enter an API key first', 'error');
        return;
      }

      testApiBtn.textContent = 'Testing...';
      testApiBtn.disabled    = true;

      try {
        // Make a minimal API call to verify the key works
        // We use a tiny max_tokens value to minimize cost (this test costs ~$0.001)
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model:      'gpt-4o-mini',    // Cheapest model for testing
            messages:   [{ role: 'user', content: 'Say OK' }],
            max_tokens: 5,                // Minimal response to minimize cost
          }),
        });

        if (response.ok) {
          setStatus(apiKeyStatus, '✅ API key is valid!', 'success');
        } else if (response.status === 401) {
          setStatus(apiKeyStatus, '❌ Invalid API key', 'error');
        } else if (response.status === 402) {
          setStatus(apiKeyStatus, '⚠️ Key valid but no credits', 'error');
        } else {
          setStatus(apiKeyStatus, `❌ Error: HTTP ${response.status}`, 'error');
        }
      } catch (err) {
        setStatus(apiKeyStatus, `❌ Network error: ${err.message}`, 'error');
      }

      testApiBtn.textContent = 'Test API Key';
      testApiBtn.disabled    = false;
    });
  }

  // ── TEST EMAIL BUTTON ─────────────────────────────────────────────────────
  const testEmailBtn   = document.getElementById('testEmail');
  const emailStatus    = document.getElementById('emailStatus');

  if (testEmailBtn) {
    testEmailBtn.addEventListener('click', async () => {
      testEmailBtn.textContent = 'Sending...';
      testEmailBtn.disabled    = true;

      // Send message to background script to perform the test email
      const response = await sendMessage('TEST_EMAIL', {});
      if (response.success) {
        setStatus(emailStatus, '✅ Test email sent! Check your inbox.', 'success');
      } else {
        setStatus(emailStatus, `❌ Failed: ${response.error || 'Check EmailJS settings'}`, 'error');
      }

      testEmailBtn.textContent = 'Send Test Email';
      testEmailBtn.disabled    = false;
    });
  }

  // ── SAVE BUTTONS ──────────────────────────────────────────────────────────
  // We have one save button per tab. They all call saveSettings() with the tab name.
  document.querySelectorAll('.save-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const tab = e.target.getAttribute('data-tab');
      await saveSettings(tab);
      showSaveBanner();
    });
  });

  // ── LOG FILTER CHANGES ────────────────────────────────────────────────────
  const logFilter = document.getElementById('logFilter');
  const logSource = document.getElementById('logSource');
  if (logFilter) logFilter.addEventListener('change', loadApplicationLog);
  if (logSource) logSource.addEventListener('change', loadApplicationLog);

  // ── EXPORT CSV BUTTON ─────────────────────────────────────────────────────
  const exportCsvBtn = document.getElementById('exportCsv');
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', exportLogToCsv);
  }

  // ── CLEAR LOG BUTTON ──────────────────────────────────────────────────────
  const clearLogBtn = document.getElementById('clearLog');
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', async () => {
      if (!confirm('Clear the entire application log? This cannot be undone.')) return;
      await chrome.storage.local.remove('applicationLog');
      loadApplicationLog(); // Reload the (now empty) log
    });
  }

  // Load saved settings now that all variables and listeners are initialised.
  await loadAllSettings();

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ════════════════════════════════════════════════════════════════════════════

  // ── loadAllSettings() ─────────────────────────────────────────────────────
  // Reads all saved settings from chrome.storage and populates the form fields
  async function loadAllSettings() {
    // chrome.storage.local.get(null) returns ALL stored keys at once
    const stored = await new Promise(resolve => {
      chrome.storage.local.get(null, resolve);
    });

    // Helper: set a form field's value if an element with that ID exists
    // The ?. (optional chaining) prevents errors if the element doesn't exist
    function setField(id, value) {
      const el = document.getElementById(id);
      if (!el || value === undefined || value === null) return;
      // Different element types need different property names
      if (el.type === 'checkbox') {
        el.checked = Boolean(value); // Convert to boolean first
      } else {
        el.value = value;
      }
    }

    // ── API Settings ────────────────────────────────────────────────────
    setField('openaiKey', stored.openAiApiKey || '');

    const email = stored.emailConfig || {};
    setField('emailServiceId',       email.serviceId   || '');
    setField('emailTemplateId',      email.templateId  || '');
    setField('emailPublicKey',       email.publicKey   || '');
    setField('emailToAddress',       email.toEmail     || '');
    setField('chkImmediateEmail',    email.sendImmediateNotification || false);

    // ── Profile ─────────────────────────────────────────────────────────
    const profile = stored.userProfile || {};
    setField('firstName',        profile.firstName        || '');
    setField('lastName',         profile.lastName         || '');
    setField('email',            profile.email            || '');
    setField('phone',            profile.phone            || '');
    setField('address',          profile.address          || '');
    setField('city',             profile.city             || 'Charlotte');
    setField('state',            profile.state            || 'NC');
    setField('zipCode',          profile.zipCode          || '');
    setField('linkedin',         profile.linkedin         || '');
    setField('github',           profile.github           || '');
    setField('portfolio',        profile.portfolio        || '');
    setField('citizenStatus',    profile.citizenStatus    || 'US Citizen');
    setField('usWorkAuth',       profile.usWorkAuth       !== false);
    setField('requireSponsorship', profile.requireSponsorship || false);
    setField('veteranStatus',    profile.veteranStatus    || 'I am not a protected veteran');
    setField('disabilityStatus', profile.disabilityStatus || "No, I don't wish to answer");

    // ── Resume ─────────────────────────────────────────────────────────
    const resume = stored.resumeText || '';
    setField('resumeText', resume);
    if (resume && charCount) {
      charCount.textContent = `${resume.length.toLocaleString()} characters`;
    }

    // ── Job Preferences ─────────────────────────────────────────────────
    const prefs = stored.jobPreferences || {};
    const titles = prefs.jobTitles || ['Software Engineer', 'AI Engineer', 'Machine Learning Engineer', 'Full Stack Engineer'];
    const titlesTextarea = document.getElementById('jobTitles');
    if (titlesTextarea) titlesTextarea.value = titles.join('\n');

    setField('location',        prefs.location  || 'Charlotte, NC');
    setField('minSalary',       prefs.minSalary || 0);
    setField('matchThreshold',  prefs.matchThreshold || 65);
    if (sliderOutput) sliderOutput.value = prefs.matchThreshold || 65;

    // Restore checkbox groups (work model, experience level)
    const remotePrefs = prefs.remote || ['remote', 'hybrid', 'on-site'];
    document.querySelectorAll('input[name="remote"]').forEach(cb => {
      cb.checked = remotePrefs.includes(cb.value);
    });
    const expPrefs = prefs.experienceLevel || ['mid-level', 'senior'];
    document.querySelectorAll('input[name="expLevel"]').forEach(cb => {
      cb.checked = expPrefs.includes(cb.value);
    });

    // ── App Settings ────────────────────────────────────────────────────
    const appSettings = stored.appSettings || {};
    setField('maxDailyApps',       appSettings.maxDailyApplications !== undefined ? appSettings.maxDailyApplications : 30);
    setField('delayBetweenApps',   appSettings.delayBetweenApps !== undefined ? appSettings.delayBetweenApps / 1000 : 8);
    setField('autoSubmit',         appSettings.autoSubmit          || false);
    setField('enableLinkedIn',     appSettings.enableLinkedIn      !== false);
    setField('enableIndeed',       appSettings.enableIndeed        !== false);
    setField('enableExternalForms', appSettings.enableExternalForms !== false);
    setField('skipApplied',        appSettings.skipApplied         !== false);
    setField('sendDailyEmail',     appSettings.sendDailyEmail      !== false);
    setField('emailTime',          appSettings.emailTime           || '18:00');
  }

  // ── saveSettings() ────────────────────────────────────────────────────────
  // Reads all form values and saves them to chrome.storage.local
  async function saveSettings(tab) {
    const toSave = {}; // Object to hold all key-value pairs to save

    if (tab === 'api' || tab === 'all') {
      // Save API key — trim() removes leading/trailing spaces
      const apiKey = document.getElementById('openaiKey')?.value.trim();
      if (apiKey) toSave['openAiApiKey'] = apiKey;

      // Save email config as a nested object
      toSave['emailConfig'] = {
        serviceId:                 document.getElementById('emailServiceId')?.value.trim()  || '',
        templateId:                document.getElementById('emailTemplateId')?.value.trim() || '',
        publicKey:                 document.getElementById('emailPublicKey')?.value.trim()  || '',
        toEmail:                   document.getElementById('emailToAddress')?.value.trim()  || '',
        sendImmediateNotification: document.getElementById('chkImmediateEmail')?.checked    || false,
      };
    }

    if (tab === 'profile' || tab === 'all') {
      toSave['userProfile'] = {
        firstName:         document.getElementById('firstName')?.value.trim()        || '',
        lastName:          document.getElementById('lastName')?.value.trim()         || '',
        email:             document.getElementById('email')?.value.trim()            || '',
        phone:             document.getElementById('phone')?.value.trim()            || '',
        address:           document.getElementById('address')?.value.trim()          || '',
        city:              document.getElementById('city')?.value.trim()             || 'Charlotte',
        state:             document.getElementById('state')?.value.trim()            || 'NC',
        zipCode:           document.getElementById('zipCode')?.value.trim()          || '',
        country:           'United States',
        linkedin:          document.getElementById('linkedin')?.value.trim()         || '',
        github:            document.getElementById('github')?.value.trim()           || '',
        portfolio:         document.getElementById('portfolio')?.value.trim()        || '',
        citizenStatus:     document.getElementById('citizenStatus')?.value           || 'US Citizen',
        usWorkAuth:        document.getElementById('usWorkAuth')?.checked            ?? true,
        requireSponsorship: document.getElementById('requireSponsorship')?.checked   ?? false,
        veteranStatus:     document.getElementById('veteranStatus')?.value           || 'I am not a protected veteran',
        disabilityStatus:  document.getElementById('disabilityStatus')?.value        || "No, I don't wish to answer",
      };
    }

    if (tab === 'resume' || tab === 'all') {
      toSave['resumeText'] = document.getElementById('resumeText')?.value || '';
    }

    if (tab === 'jobprefs' || tab === 'all') {
      // Split textarea lines into an array and remove empty lines
      const titles = document.getElementById('jobTitles')?.value
        .split('\n')
        .map(t => t.trim())
        .filter(t => t.length > 0) || [];

      // Collect checked checkbox values into arrays
      const remote = [...document.querySelectorAll('input[name="remote"]:checked')]
        .map(cb => cb.value);
      const expLevel = [...document.querySelectorAll('input[name="expLevel"]:checked')]
        .map(cb => cb.value);

      toSave['jobPreferences'] = {
        jobTitles:       titles,
        location:        document.getElementById('location')?.value.trim()     || 'Charlotte, NC',
        remote:          remote.length > 0 ? remote : ['remote', 'hybrid', 'on-site'],
        minSalary:       parseInt(document.getElementById('minSalary')?.value) || 0,
        experienceLevel: expLevel.length > 0 ? expLevel : ['mid-level', 'senior'],
        matchThreshold:  parseInt(document.getElementById('matchThreshold')?.value) || 65,
      };
    }

    if (tab === 'appsettings' || tab === 'all') {
      toSave['appSettings'] = {
        maxDailyApplications: parseInt(document.getElementById('maxDailyApps')?.value)        || 30,
        // Convert seconds to milliseconds for storage
        delayBetweenApps:     parseInt(document.getElementById('delayBetweenApps')?.value) * 1000 || 8000,
        autoSubmit:           document.getElementById('autoSubmit')?.checked            || false,
        enableLinkedIn:       document.getElementById('enableLinkedIn')?.checked        ?? true,
        enableIndeed:         document.getElementById('enableIndeed')?.checked          ?? true,
        enableExternalForms:  document.getElementById('enableExternalForms')?.checked   ?? true,
        skipApplied:          document.getElementById('skipApplied')?.checked           ?? true,
        sendDailyEmail:       document.getElementById('sendDailyEmail')?.checked        ?? true,
        emailTime:            document.getElementById('emailTime')?.value               || '18:00',
      };
    }

    // Save all collected key-value pairs to chrome.storage in one call
    // chrome.storage.local.set(object) saves multiple keys at once
    await new Promise((resolve, reject) => {
      chrome.storage.local.set(toSave, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    console.log('[AI Job Applicant] Settings saved:', Object.keys(toSave).join(', '));
  }

  // ── loadApplicationLog() ─────────────────────────────────────────────────
  // Fetches the application log and renders it as a table
  async function loadApplicationLog() {
    const stored = await new Promise(resolve => {
      chrome.storage.local.get('applicationLog', resolve);
    });

    let log = stored.applicationLog || [];

    // Apply filters from the filter dropdowns
    const filterStatus = document.getElementById('logFilter')?.value || 'all';
    const filterSource = document.getElementById('logSource')?.value || 'all';

    if (filterStatus !== 'all') {
      log = log.filter(e => e.status === filterStatus);
    }
    if (filterSource !== 'all') {
      log = log.filter(e => e.source === filterSource);
    }

    // Render stats bar
    const statsDiv = document.getElementById('logStats');
    const allLog   = stored.applicationLog || [];
    const appliedCount = allLog.filter(e => e.status === 'applied').length;
    const skippedCount = allLog.filter(e => e.status === 'skipped').length;
    const failedCount  = allLog.filter(e => e.status === 'failed').length;
    const avgScore = allLog.length > 0
      ? Math.round(allLog.reduce((s, e) => s + (e.matchScore || 0), 0) / allLog.length)
      : 0;

    if (statsDiv) {
      statsDiv.textContent = `Total: ${allLog.length} entries | Applied: ${appliedCount} | Skipped: ${skippedCount} | Failed: ${failedCount} | Avg Match: ${avgScore}%`;
    }

    // Render table rows
    const tbody = document.getElementById('logTableBody');
    if (!tbody) return;

    if (log.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:#64748b;">No applications logged yet.</td></tr>`;
      return;
    }

    // Build one <tr> for each log entry
    tbody.innerHTML = log.map(entry => {
      // Format date and time separately
      const date = new Date(entry.timestamp);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

      // Choose badge class based on status
      const badgeClass = `badge badge-${entry.status}`;

      // Build the table row HTML
      return `<tr>
        <td>${dateStr} ${timeStr}</td>
        <td title="${escapeHtml(entry.jobTitle)}">
          ${entry.url
            ? `<a href="${escapeHtml(entry.url)}" target="_blank" style="color:#0a66c2;">${escapeHtml(entry.jobTitle)}</a>`
            : escapeHtml(entry.jobTitle)
          }
        </td>
        <td>${escapeHtml(entry.company)}</td>
        <td>${escapeHtml(entry.location)}</td>
        <td>${entry.source}</td>
        <td>${entry.matchScore}%</td>
        <td>${entry.applyType}</td>
        <td><span class="${badgeClass}">${entry.status}</span></td>
      </tr>`;
    }).join('');
  }

  // ── exportLogToCsv() ─────────────────────────────────────────────────────
  // Converts the application log to a CSV file and triggers a download
  async function exportLogToCsv() {
    const stored = await new Promise(resolve => chrome.storage.local.get('applicationLog', resolve));
    const log    = stored.applicationLog || [];

    if (log.length === 0) {
      alert('No applications in the log to export.');
      return;
    }

    // CSV header row (column names)
    const headers = ['Date', 'Time', 'Job Title', 'Company', 'Location', 'Source', 'Match Score', 'Apply Type', 'Status', 'URL'];

    // Build rows — each field wrapped in quotes to handle commas within values
    const rows = log.map(entry => {
      const date = new Date(entry.timestamp);
      return [
        date.toLocaleDateString(),           // Date column
        date.toLocaleTimeString(),           // Time column
        `"${(entry.jobTitle  || '').replace(/"/g, '""')}"`, // Escape quotes in values
        `"${(entry.company   || '').replace(/"/g, '""')}"`,
        `"${(entry.location  || '').replace(/"/g, '""')}"`,
        entry.source,
        entry.matchScore || 0,
        entry.applyType  || '',
        entry.status     || '',
        entry.url        || '',
      ].join(','); // Join fields with commas
    });

    // Combine header and all rows with newlines
    const csvContent = [headers.join(','), ...rows].join('\n');

    // Create a "Blob" (Binary Large Object) from the CSV string
    // Blob represents file-like raw data in the browser
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

    // Create a temporary URL for the blob so we can trigger a download
    const url = URL.createObjectURL(blob);

    // Create an <a> element, set its href to our blob URL, and click it
    // This triggers the browser's download dialog
    const link = document.createElement('a');
    link.href     = url;
    link.download = `job-applications-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link); // Must be in DOM to click
    link.click();
    document.body.removeChild(link); // Clean up

    // Release the blob URL memory
    URL.revokeObjectURL(url);
  }

  // ── showSaveBanner() ─────────────────────────────────────────────────────
  // Shows a green "Saved!" banner that auto-hides after 2.5 seconds
  function showSaveBanner() {
    const banner = document.getElementById('saveBanner');
    if (!banner) return;
    banner.classList.remove('hidden');
    // setTimeout() runs a function once after a delay (ms)
    setTimeout(() => banner.classList.add('hidden'), 2500);
  }

  // ── setStatus() ─────────────────────────────────────────────────────────
  // Updates a status <span> element with text and a CSS class for color
  function setStatus(element, message, type) {
    if (!element) return;
    element.textContent = message;
    element.className   = `status-message ${type}`; // e.g., "status-message success"
    // Auto-clear after 5 seconds
    setTimeout(() => { element.textContent = ''; element.className = 'status-message'; }, 5000);
  }

  // ── sendMessage() ────────────────────────────────────────────────────────
  // Sends a message to the background service worker and returns the response
  function sendMessage(action, data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action, data }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false });
        }
      });
    });
  }

  // ── escapeHtml() ─────────────────────────────────────────────────────────
  // Prevents XSS by escaping HTML special characters before using innerHTML
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

}); // end DOMContentLoaded
