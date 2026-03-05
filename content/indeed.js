// ═══════════════════════════════════════════════════════════════════════════════
// FILE: content/indeed.js
// PURPOSE: Indeed-specific job discovery and application automation.
//
// INDEED PAGE TYPES:
//   Job search: indeed.com/jobs?q=...&l=...
//   Job post:   indeed.com/viewjob?jk=...
//   Indeed Apply: A modal/iframe that opens on-site
//   External: Redirects to company website
//
// INDEED APPLY TYPES:
//   1. "Indeed Apply" — the application happens in a popup on Indeed's site
//   2. "Apply on company site" — redirects to company's own ATS
//
// HOW TO TELL WHICH TYPE:
//   The "Apply now" button has different text/classes for each type
// ═══════════════════════════════════════════════════════════════════════════════

(async function() {
  'use strict';

  // ── Wait for utility scripts to load ─────────────────────────────────────
  await waitForDeps(5000).catch(err => {
    console.error('[Indeed] Dependencies not loaded:', err.message);
    return;
  });

  function waitForDeps(timeout) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.StorageUtils && window.OpenAIUtils && window.FormFiller) resolve();
        else if (Date.now() - start > timeout) reject(new Error('Timeout'));
        else setTimeout(check, 100);
      };
      check();
    });
  }

  // ── STATE ─────────────────────────────────────────────────────────────────
  let config    = null;
  let isRunning = false;
  let processedIds = new Set(); // Track job IDs we've already processed

  // ── LISTEN FOR MESSAGES ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'BEGIN_SCANNING') {
      startScanning().catch(err => console.error('[Indeed] Error:', err.message));
      sendResponse({ success: true });
    }
    if (message.action === 'STOP') {
      isRunning = false;
      sendResponse({ success: true });
    }
  });

  // ── AUTO-START CHECK ──────────────────────────────────────────────────────
  const autoStart = await StorageUtils.load(StorageUtils.KEYS.IS_RUNNING, false);
  if (autoStart && isIndeedPage()) {
    await startScanning();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN SCAN FUNCTION
  // ═══════════════════════════════════════════════════════════════════════════
  async function startScanning() {
    if (isRunning) return;
    isRunning = true;

    console.log('[Indeed] Starting job scan...');

    // Load config from background script
    config = await loadConfig();
    if (!config || !config.settings.enableIndeed) {
      isRunning = false;
      return;
    }

    const url = window.location.href;

    if (url.includes('/jobs') || url.includes('/q-')) {
      // ── Search results page ─────────────────────────────────────────────
      await scanJobListings();
    } else if (url.includes('/viewjob')) {
      // ── Individual job page ─────────────────────────────────────────────
      await processCurrentJobPage();
    } else {
      // Navigate to search
      navigateToJobSearch(config.preferences);
    }

    isRunning = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCAN JOB LISTINGS
  // ═══════════════════════════════════════════════════════════════════════════
  async function scanJobListings() {
    console.log('[Indeed] Scanning search results...');

    // Wait for job cards to appear
    const firstCard = await waitForElement('[data-jk], .job_seen_beacon, .jobsearch-SerpJobCard', 8000);
    if (!firstCard) {
      console.warn('[Indeed] No job cards found');
      return;
    }

    // Collect all job cards
    // Indeed uses [data-jk] attribute as the job's unique key/ID
    const jobCards = [...document.querySelectorAll(
      '[data-jk], .job_seen_beacon, .jobsearch-SerpJobCard, .tapItem'
    )];

    console.log(`[Indeed] Found ${jobCards.length} job cards`);

    for (const card of jobCards) {
      // Check if we should keep running
      const stillRunning = await StorageUtils.load(StorageUtils.KEYS.IS_RUNNING, false);
      if (!stillRunning) break;

      // Check daily limit
      const limitCheck = await sendMessage('CHECK_DAILY_LIMIT', {});
      if (!limitCheck.allowed) {
        console.log(`[Indeed] Daily limit reached (${limitCheck.limit})`);
        break;
      }

      try {
        await processJobCard(card);
        await sleep(config.settings.delayBetweenApps || 8000);
      } catch (err) {
        console.error('[Indeed] Card error:', err.message);
        await sleep(2000);
      }
    }

    // Navigate to next page
    const nextPageBtn = document.querySelector(
      'a[aria-label="Next Page"], [data-testid="pagination-page-next"]'
    );
    if (nextPageBtn) {
      console.log('[Indeed] Moving to next page...');
      await sleep(3000);
      nextPageBtn.click();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS A SINGLE JOB CARD
  // ═══════════════════════════════════════════════════════════════════════════
  async function processJobCard(card) {
    // Get the job's unique ID (data-jk attribute)
    const jobId = card.getAttribute('data-jk') || card.getAttribute('data-mobtk');
    if (!jobId) return;

    // Skip if already processed
    if (processedIds.has(jobId)) return;
    processedIds.add(jobId);

    // Construct the job URL
    const jobUrl = `https://www.indeed.com/viewjob?jk=${jobId}`;

    // Click the card to load job details in the right panel
    const clickTarget = card.querySelector('h2 a, .jcs-JobTitle, [data-jk] a');
    if (clickTarget) {
      clickTarget.click();
      await sleep(2000);
    }

    // Extract job details from the right panel
    const jobDetails = extractJobDetails();
    if (!jobDetails.title) return;

    console.log(`[Indeed] Processing: ${jobDetails.title} at ${jobDetails.company}`);

    // Determine apply type
    const applyType = getApplyType();
    console.log(`[Indeed] Apply type: ${applyType}`);

    // Skip external apps if disabled
    if (applyType === 'External' && !config.settings.enableExternalForms) {
      await logApplication({
        ...jobDetails, url: jobUrl, source: 'Indeed', applyType,
        status: 'skipped', matchScore: 0, notes: 'External forms disabled'
      });
      return;
    }

    // AI match analysis
    const matchResult = await OpenAIUtils.analyzeJobMatch(
      config.apiKey,
      config.resume,
      jobDetails.title,
      jobDetails.description,
      jobDetails.company
    );

    console.log(`[Indeed] Match score: ${matchResult.score}%`);

    // Skip low-match jobs
    if (matchResult.score < config.preferences.matchThreshold) {
      await logApplication({
        ...jobDetails, url: jobUrl, source: 'Indeed', applyType,
        status: 'skipped', matchScore: matchResult.score,
        notes: `Match ${matchResult.score}% below threshold ${config.preferences.matchThreshold}%`
      });
      return;
    }

    // Apply!
    let result;
    if (applyType === 'IndeedApply') {
      result = await applyViaIndeedApply(jobDetails, jobUrl, matchResult);
    } else {
      result = await handleExternalApplication(jobDetails, jobUrl, matchResult);
    }

    await logApplication({
      ...jobDetails, url: jobUrl, source: 'Indeed', applyType,
      status: result.status, matchScore: matchResult.score, notes: result.notes || ''
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPLY VIA INDEED APPLY
  // ═══════════════════════════════════════════════════════════════════════════
  async function applyViaIndeedApply(jobDetails, jobUrl, matchResult) {
    try {
      // Find the Indeed Apply button
      // Indeed Apply buttons have specific text/class (different from "Apply on company site")
      const applyBtn = document.querySelector(
        'button[id*="apply"], ' +
        '.ia-IndeedApplyButton, ' +
        'a.indeed-apply-button, ' +
        '[data-tn-element="apply-button"]'
      );

      if (!applyBtn) {
        return { status: 'failed', notes: 'Apply button not found' };
      }

      applyBtn.click();
      await sleep(2000);

      // Indeed Apply may open in an iframe or a new page section
      // First, check for an iframe-based application
      const applyFrame = await waitForElement(
        'iframe[src*="apply"], .ia-BasePage, .ia-container',
        5000
      );

      if (applyFrame) {
        // Application opened in an iframe or overlay
        // We'll handle it like a form on the page
        const fillResult = await FormFiller.fillForm({
          profile:        config.profile,
          resume:         config.resume,
          apiKey:         config.apiKey,
          jobTitle:       jobDetails.title,
          company:        jobDetails.company,
          jobDescription: jobDetails.description,
        }, config.settings.autoSubmit);

        showBanner(
          config.settings.autoSubmit
            ? `✅ Applied to ${jobDetails.title} at ${jobDetails.company}!`
            : `📋 Form filled! Click "Apply" to submit your application to ${jobDetails.company}`,
          config.settings.autoSubmit ? 'success' : 'info'
        );

        return {
          status: 'applied',
          notes: config.settings.autoSubmit ? 'Auto-submitted' : 'Form filled, awaiting user submission'
        };
      }

      return { status: 'failed', notes: 'Could not open Indeed Apply form' };

    } catch (err) {
      return { status: 'failed', notes: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE EXTERNAL APPLICATION
  // ═══════════════════════════════════════════════════════════════════════════
  async function handleExternalApplication(jobDetails, jobUrl, matchResult) {
    // Find the "Apply on company site" button
    const applyLink = document.querySelector(
      'a[href*="clk"], ' +
      '[data-tn-element="applyButton"] a, ' +
      '.jobsearch-IndeedApplyButton-buttonWrapper a'
    );

    if (applyLink) {
      const externalUrl = applyLink.href;
      // Open in new tab — generic form filler will activate there
      await sendMessage('OPEN_JOB_TAB', { url: externalUrl });
      return { status: 'applied', notes: `External form opened: ${externalUrl}` };
    }

    return { status: 'failed', notes: 'External apply link not found' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // Extract job details from Indeed's right-side job details panel
  function extractJobDetails() {
    // Indeed selectors — their HTML structure
    const title = document.querySelector(
      '[data-testid="jobsearch-JobInfoHeader-title"], ' +
      '.jobsearch-JobInfoHeader-title, ' +
      'h1.jobsearch-JobInfoHeader-title'
    )?.innerText?.trim() || '';

    const company = document.querySelector(
      '[data-testid="inlineHeader-companyName"], ' +
      '.jobsearch-CompanyInfoContainer a, ' +
      '.jobsearch-InlineCompanyRating-companyHeader'
    )?.innerText?.trim() || '';

    const location = document.querySelector(
      '[data-testid="job-location"], ' +
      '.jobsearch-JobInfoHeader-subtitle .jobsearch-JobInfoHeader-text'
    )?.innerText?.trim() || '';

    const description = document.querySelector(
      '#jobDescriptionText, ' +
      '.jobsearch-jobDescriptionText, ' +
      '[data-testid="job-description"]'
    )?.innerText?.trim() || '';

    return { title, company, location, description };
  }

  // Determine whether the current job uses Indeed Apply or external
  function getApplyType() {
    // Check for Indeed Apply button (stays on Indeed)
    const indeedApplyBtn = document.querySelector(
      '.ia-IndeedApplyButton, ' +
      'button[id*="indeed-apply"], ' +
      '[data-tn-element="apply-button"]:not(a)'
    );
    if (indeedApplyBtn) return 'IndeedApply';

    // Check for "Apply on company site" link
    const externalBtn = document.querySelector(
      '[data-tn-element="applyButton"] a, ' +
      'a[href*="clk?jk"]'
    );
    if (externalBtn) return 'External';

    return 'Unknown';
  }

  function isIndeedPage() {
    return window.location.href.includes('indeed.com');
  }

  function navigateToJobSearch(prefs) {
    const q = encodeURIComponent((prefs.jobTitles || ['Software Engineer']).join(' OR '));
    const l = encodeURIComponent(prefs.location || 'Charlotte, NC');
    window.location.href = `https://www.indeed.com/jobs?q=${q}&l=${l}&fromage=1&sort=date`;
  }

  async function processCurrentJobPage() {
    const jobDetails = extractJobDetails();
    if (!jobDetails.title) return;

    const matchResult = await OpenAIUtils.analyzeJobMatch(
      config.apiKey, config.resume, jobDetails.title,
      jobDetails.description, jobDetails.company
    );

    if (matchResult.score >= config.preferences.matchThreshold) {
      const applyType = getApplyType();
      if (applyType === 'IndeedApply') {
        await applyViaIndeedApply(jobDetails, window.location.href, matchResult);
      }
    }
  }

  async function loadConfig() {
    const response = await sendMessage('GET_CONFIG', {});
    if (!response.success || !response.hasApiKey || !response.resume) {
      console.error('[Indeed] Config incomplete');
      return null;
    }
    return response;
  }

  async function logApplication(data) {
    await sendMessage('LOG_APPLICATION', data);
  }

  function sendMessage(action, data) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action, data }, response => {
        if (chrome.runtime.lastError) resolve({ success: false });
        else resolve(response || { success: false });
      });
    });
  }

  function waitForElement(selector, timeout = 5000) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
    });
  }

  function showBanner(message, type = 'info') {
    document.getElementById('ai-job-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'ai-job-banner';
    banner.textContent = message;
    const colors = { success: '#16a34a', info: '#0a66c2', warning: '#d97706' };
    Object.assign(banner.style, {
      position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)',
      background: colors[type] || colors.info, color: 'white',
      padding: '12px 24px', borderRadius: '8px', zIndex: '999999',
      fontSize: '14px', fontWeight: '600', maxWidth: '600px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)', cursor: 'pointer',
    });
    banner.addEventListener('click', () => banner.remove());
    document.body.appendChild(banner);
    setTimeout(() => banner?.remove(), 10000);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  console.log('[AI Job Applicant] Indeed content script loaded');

})();
