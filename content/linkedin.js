// ═══════════════════════════════════════════════════════════════════════════════
// FILE: content/linkedin.js
// PURPOSE: LinkedIn-specific automation logic.
//          Handles job discovery, job matching, and application submission
//          via LinkedIn's "Easy Apply" feature.
//
// HOW CONTENT SCRIPTS WORK ON LINKEDIN:
//   - This script runs inside the LinkedIn page (like a browser plugin)
//   - It can read and modify LinkedIn's HTML
//   - It communicates with the background script via chrome.runtime.sendMessage()
//   - LinkedIn uses React + custom web components, so we need to fire
//     synthetic DOM events for the UI to detect our changes
//
// LINKEDIN PAGE STRUCTURE (as of 2024):
//   Job search:  linkedin.com/jobs/search/?keywords=...&location=...
//   Job page:    linkedin.com/jobs/view/[jobId]/
//   Easy Apply:  Modal dialog that opens on the job page
//
// ⚠️  LEGAL NOTE: This script reads publicly visible job data and helps fill
//     forms that the user themselves would fill. The user is in control at all
//     times. This is different from scraping LinkedIn's data for storage/resale.
// ═══════════════════════════════════════════════════════════════════════════════

// ── IIFE (Immediately Invoked Function Expression) ───────────────────────────
// Wraps all code in a function to avoid polluting the global scope.
// The () at the end immediately calls this function.
(async function() {
  'use strict'; // Strict mode catches common JS mistakes at runtime

  // ── WAIT FOR DEPENDENCIES ──────────────────────────────────────────────────
  // Our utility scripts (storage.js, openai.js, form-filler.js) are loaded
  // before this script per manifest.json, but we add a safety check anyway.
  function waitForDeps(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.StorageUtils && window.OpenAIUtils && window.FormFiller) {
          resolve(); // All dependencies are loaded
        } else if (Date.now() - start > timeout) {
          reject(new Error('Utility scripts not loaded in time')); // Timeout
        } else {
          setTimeout(check, 100); // Check again in 100ms
        }
      };
      check();
    });
  }

  try {
    await waitForDeps();
  } catch (err) {
    console.error('[LinkedIn] Dependency load failed:', err.message);
    return; // Abort — can't run without utilities
  }

  // ── STATE ─────────────────────────────────────────────────────────────────
  let config      = null;     // Loaded from background: profile, resume, settings, apiKey
  let isRunning   = false;    // True when automation is active
  let processedUrls = new Set(); // Track which job URLs we've already processed this session

  // ── LISTEN FOR MESSAGES FROM BACKGROUND ───────────────────────────────────
  // The background script sends 'BEGIN_SCANNING' when the user clicks Start
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[LinkedIn] Received message:', message.action);

    if (message.action === 'BEGIN_SCANNING') {
      // Don't await here — message listeners can't be async with sendResponse
      startScanning().catch(err => {
        console.error('[LinkedIn] Scanning error:', err.message);
      });
      sendResponse({ success: true }); // Acknowledge the message
    }

    if (message.action === 'STOP') {
      isRunning = false;
      sendResponse({ success: true });
    }
  });

  // ── AUTO-START ─────────────────────────────────────────────────────────────
  // Also check on page load if automation should be running
  // (Handles the case where user already clicked Start, then navigated to LinkedIn)
  const storedRunning = await StorageUtils.load(StorageUtils.KEYS.IS_RUNNING, false);
  if (storedRunning && isLinkedInJobsPage()) {
    await startScanning();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN SCANNING FUNCTION
  // ═══════════════════════════════════════════════════════════════════════════
  async function startScanning() {
    if (isRunning) return; // Prevent multiple concurrent scans
    isRunning = true;

    console.log('[LinkedIn] Starting job scan...');

    // Load configuration from storage (profile, resume, settings, API key)
    config = await loadConfig();
    if (!config) {
      isRunning = false;
      return;
    }

    // Check if LinkedIn is enabled in settings
    if (!config.settings.enableLinkedIn) {
      console.log('[LinkedIn] LinkedIn disabled in settings');
      isRunning = false;
      return;
    }

    // ── Determine what page we're on ────────────────────────────────────────
    const url = window.location.href;

    if (url.includes('/jobs/search') || url.includes('/jobs/collections')) {
      // ── Job Search Results Page ─────────────────────────────────────────
      await scanJobListings();
    } else if (url.includes('/jobs/view/')) {
      // ── Individual Job Post Page ────────────────────────────────────────
      await processCurrentJobPage();
    } else {
      // Not on a job page — navigate to job search
      console.log('[LinkedIn] Not on a jobs page. Navigating to job search...');
      navigateToJobSearch(config.preferences);
    }

    isRunning = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCAN JOB LISTINGS (Search Results Page)
  // ═══════════════════════════════════════════════════════════════════════════
  async function scanJobListings() {
    console.log('[LinkedIn] Scanning job listings...');

    // ── Wait for job cards to load ──────────────────────────────────────────
    // LinkedIn loads job cards dynamically (AJAX). We wait up to 10 seconds.
    const jobCards = await waitForElement('.jobs-search-results__list-item, .job-card-container', 10000);
    if (!jobCards) {
      console.warn('[LinkedIn] No job cards found on search page');
      return;
    }

    // Find all job cards on the page
    // querySelectorAll returns a NodeList → spread into array for .filter(), .map() etc.
    const jobCardEls = [...document.querySelectorAll(
      '.job-card-container, .jobs-search-results__list-item, [data-occludable-job-id]'
    )];

    console.log(`[LinkedIn] Found ${jobCardEls.length} job cards`);

    // Process each job card
    for (const card of jobCardEls) {
      // Check if we should keep running
      const stillRunning = await StorageUtils.load(StorageUtils.KEYS.IS_RUNNING, false);
      if (!stillRunning) {
        console.log('[LinkedIn] Automation stopped by user');
        break;
      }

      // Check daily application limit
      const limitCheck = await sendMessage('CHECK_DAILY_LIMIT', {});
      if (!limitCheck.allowed) {
        console.log(`[LinkedIn] Daily limit (${limitCheck.limit}) reached. Stopping.`);
        break;
      }

      try {
        await processJobCard(card);
        // Delay between jobs to appear human-like and avoid rate limiting
        await sleep(config.settings.delayBetweenApps || 8000);
      } catch (err) {
        console.error('[LinkedIn] Error processing job card:', err.message);
        await sleep(2000); // Short delay before continuing
      }
    }

    // ── Navigate to next page of results ────────────────────────────────────
    const nextPageBtn = document.querySelector(
      'button[aria-label="View next page"], .artdeco-pagination__button--next'
    );
    if (nextPageBtn && !nextPageBtn.disabled) {
      console.log('[LinkedIn] Moving to next page of results...');
      await sleep(3000); // Wait before clicking next page
      nextPageBtn.click();
      // The page will reload and content script will re-run
    } else {
      console.log('[LinkedIn] No more pages. Scan complete.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS A SINGLE JOB CARD
  // ═══════════════════════════════════════════════════════════════════════════
  async function processJobCard(card) {
    // ── Extract job URL from the card ────────────────────────────────────────
    // LinkedIn job cards have a link to the individual job page
    const jobLink = card.querySelector('a[href*="/jobs/view/"]');
    if (!jobLink) return;

    const jobUrl = jobLink.href; // Full URL to the job post

    // ── Skip if already processed this session ───────────────────────────────
    if (processedUrls.has(jobUrl)) {
      console.log('[LinkedIn] Already processed:', jobUrl);
      return;
    }
    processedUrls.add(jobUrl);

    // ── Click the job card to load its details in the side panel ────────────
    // LinkedIn shows job details in a side panel when you click a card
    const clickTarget = card.querySelector('a, .job-card-container__link');
    if (clickTarget) {
      clickTarget.click();
      await sleep(2000); // Wait for details panel to load
    }

    // ── Extract job details from the details panel ───────────────────────────
    const jobDetails = extractJobDetails();
    if (!jobDetails.title) {
      console.log('[LinkedIn] Could not extract job title from card');
      return;
    }

    console.log(`[LinkedIn] Processing: ${jobDetails.title} at ${jobDetails.company}`);

    // ── Check if this is an Easy Apply job ───────────────────────────────────
    const isEasyApply = isEasyApplyJob();

    // ── Skip if Easy Apply is not available and external is disabled ─────────
    if (!isEasyApply && !config.settings.enableExternalForms) {
      await logApplication({
        jobTitle:  jobDetails.title,
        company:   jobDetails.company,
        location:  jobDetails.location,
        url:       jobUrl,
        source:    'LinkedIn',
        applyType: 'External',
        status:    'skipped',
        matchScore: 0,
        notes:     'External forms disabled in settings',
      });
      return;
    }

    // ── Analyze job match using OpenAI ───────────────────────────────────────
    console.log(`[LinkedIn] Analyzing job match...`);
    const matchResult = await OpenAIUtils.analyzeJobMatch(
      config.apiKey,
      config.resume,
      jobDetails.title,
      jobDetails.description,
      jobDetails.company
    );

    console.log(`[LinkedIn] Match score: ${matchResult.score}% (threshold: ${config.preferences.matchThreshold}%)`);

    // ── Skip low-match jobs ──────────────────────────────────────────────────
    if (matchResult.score < config.preferences.matchThreshold) {
      console.log(`[LinkedIn] Skipping — match score too low (${matchResult.score}%)`);
      await logApplication({
        jobTitle:  jobDetails.title,
        company:   jobDetails.company,
        location:  jobDetails.location,
        url:       jobUrl,
        source:    'LinkedIn',
        applyType: isEasyApply ? 'EasyApply' : 'External',
        status:    'skipped',
        matchScore: matchResult.score,
        notes:     `Match score ${matchResult.score}% below threshold ${config.preferences.matchThreshold}%`,
      });
      return;
    }

    // ── Apply! ───────────────────────────────────────────────────────────────
    let applicationResult;

    if (isEasyApply) {
      applicationResult = await applyViaEasyApply(jobDetails, jobUrl, matchResult);
    } else {
      applicationResult = await handleExternalApplication(jobDetails, jobUrl, matchResult);
    }

    // ── Log the result ───────────────────────────────────────────────────────
    await logApplication({
      jobTitle:  jobDetails.title,
      company:   jobDetails.company,
      location:  jobDetails.location,
      url:       jobUrl,
      source:    'LinkedIn',
      applyType: isEasyApply ? 'EasyApply' : 'External',
      status:    applicationResult.status,
      matchScore: matchResult.score,
      notes:     applicationResult.notes || '',
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPLY VIA LINKEDIN EASY APPLY
  // ═══════════════════════════════════════════════════════════════════════════
  async function applyViaEasyApply(jobDetails, jobUrl, matchResult) {
    console.log(`[LinkedIn] Applying via Easy Apply to: ${jobDetails.title}`);

    try {
      // ── Click the Easy Apply button ───────────────────────────────────────
      // LinkedIn's Easy Apply button has specific class names and aria-labels
      const easyApplyBtn = document.querySelector(
        'button.jobs-apply-button, ' +
        'button[data-control-name="jobdetails_topcard_inapply"], ' +
        '.jobs-s-apply button'
      );

      if (!easyApplyBtn) {
        return { status: 'failed', notes: 'Easy Apply button not found' };
      }

      easyApplyBtn.click();
      await sleep(2000); // Wait for the modal to open

      // ── Find the Easy Apply modal ─────────────────────────────────────────
      const modal = await waitForElement(
        '.jobs-easy-apply-modal, .artdeco-modal[aria-labelledby*="apply"]',
        5000
      );

      if (!modal) {
        return { status: 'failed', notes: 'Easy Apply modal did not open' };
      }

      // ── Handle multi-step form ─────────────────────────────────────────────
      // LinkedIn Easy Apply forms often have multiple steps (pages)
      // We loop through each step until we reach the submit step
      let stepCount = 0;
      const maxSteps = 10; // Safety limit to prevent infinite loops

      while (stepCount < maxSteps) {
        stepCount++;
        console.log(`[LinkedIn] Easy Apply step ${stepCount}`);

        // Fill all visible fields on the current step
        const fillResult = await FormFiller.fillForm({
          profile:         config.profile,
          resume:          config.resume,
          apiKey:          config.apiKey,
          jobTitle:        jobDetails.title,
          company:         jobDetails.company,
          jobDescription:  jobDetails.description,
        }, false); // false = don't auto-submit within fillForm

        await sleep(500);

        // ── Check what button is available ────────────────────────────────
        // LinkedIn shows "Next" on intermediate steps and "Submit application" on the last
        const nextBtn   = modal.querySelector('button[aria-label="Continue to next step"], button.artdeco-button--primary');
        const submitBtn = modal.querySelector(
          'button[aria-label="Submit application"], ' +
          'button[data-control-name="continue_unify"],' +
          'button.jobs-easy-apply-modal__submit-btn'
        );

        // Identify the button label to decide what to do
        const btnText = (nextBtn || submitBtn)?.innerText?.toLowerCase() || '';

        if (btnText.includes('submit') || btnText.includes('send application')) {
          // ── Last step — submit ─────────────────────────────────────────
          if (config.settings.autoSubmit) {
            // Auto-submit mode: click submit automatically
            (submitBtn || nextBtn)?.click();
            await sleep(2000);
            console.log('[LinkedIn] Easy Apply submitted!');
          } else {
            // Manual mode: highlight the submit button and notify user
            if (submitBtn || nextBtn) {
              (submitBtn || nextBtn).style.boxShadow = '0 0 0 4px #22c55e, 0 0 20px #22c55e88';
              (submitBtn || nextBtn).title = 'Click here to submit your application!';
            }
            showNotificationBanner(
              `✅ Application ready! Click the green "Submit application" button to apply to ${jobDetails.title} at ${jobDetails.company}`,
              'success'
            );
            // Wait for user to submit (poll for modal close)
            await waitForModalClose(modal, 60000); // Wait up to 60 seconds
          }
          return { status: 'applied', notes: 'Easy Apply submitted' };

        } else if (nextBtn && btnText.includes('next')) {
          // ── Intermediate step — click Next ────────────────────────────
          nextBtn.click();
          await sleep(1500); // Wait for next step to load

        } else if (btnText.includes('review')) {
          // ── Review step — click Review, then Submit ───────────────────
          nextBtn?.click();
          await sleep(1500);

        } else {
          // Unknown button — try clicking it and see what happens
          const anyBtn = modal.querySelector('button.artdeco-button--primary');
          if (anyBtn) {
            anyBtn.click();
            await sleep(1500);
          } else {
            // No button found — modal might be stuck
            break;
          }
        }
      }

      return { status: 'failed', notes: 'Form submission timed out or could not complete all steps' };

    } catch (err) {
      console.error('[LinkedIn] Easy Apply error:', err.message);
      return { status: 'failed', notes: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE EXTERNAL APPLICATION (Non-Easy-Apply Jobs)
  // ═══════════════════════════════════════════════════════════════════════════
  async function handleExternalApplication(jobDetails, jobUrl, matchResult) {
    // Bundle the job context so the form-filler on the external page has context
    const jobContext = {
      jobTitle:    jobDetails.title,
      company:     jobDetails.company,
      description: jobDetails.description,
      matchScore:  matchResult.score,
    };

    // Try to find the external URL directly from an anchor tag first
    // (LinkedIn sometimes renders the apply button as <a href="..."> for external jobs)
    const applyLink = document.querySelector(
      'a.jobs-apply-button[href], ' +
      'a[data-tracking-control-name*="apply"][href]'
    );
    if (applyLink?.href) {
      await sendMessage('OPEN_JOB_TAB', { url: applyLink.href, jobContext });
      return { status: 'applied', notes: `Opened external form: ${applyLink.href}` };
    }

    // Fallback: find the apply button element
    const applyBtn = document.querySelector(
      'button.jobs-apply-button, ' +
      'button[data-control-name="jobdetails_topcard_inapply"]'
    );

    if (!applyBtn) {
      return { status: 'failed', notes: 'External apply button not found' };
    }

    // Some buttons carry the URL in a data attribute
    const dataUrl = applyBtn.dataset.jobApplyUrl || applyBtn.dataset.applyUrl || null;
    if (dataUrl) {
      await sendMessage('OPEN_JOB_TAB', { url: dataUrl, jobContext });
      return { status: 'applied', notes: `Opened external form: ${dataUrl}` };
    }

    // Last resort: click the button and hope the browser opens the new tab.
    // The background tab-creation listener will attempt to fill the form.
    applyBtn.click();
    await sleep(2000);
    return {
      status: 'applied',
      notes: 'External application opened via button click — form filler will attempt to activate',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── extractJobDetails() ───────────────────────────────────────────────────
  // Extracts job information from the LinkedIn job details panel
  function extractJobDetails() {
    // LinkedIn's job details panel CSS selectors (may change when LinkedIn updates their site)
    const title    = document.querySelector('.job-details-jobs-unified-top-card__job-title h1, .jobs-unified-top-card__job-title')?.innerText?.trim() || '';
    const company  = document.querySelector('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name')?.innerText?.trim() || '';
    const location = document.querySelector('.job-details-jobs-unified-top-card__bullet, .jobs-unified-top-card__bullet')?.innerText?.trim() || '';

    // Job description — the long text block describing the role
    const descEl = document.querySelector(
      '.jobs-description-content__text, ' +
      '.jobs-description__content, ' +
      '#job-details'
    );
    const description = descEl?.innerText?.trim() || '';

    return { title, company, location, description };
  }

  // ── isEasyApplyJob() ─────────────────────────────────────────────────────
  // Returns true if the current job has LinkedIn Easy Apply (not external)
  function isEasyApplyJob() {
    // Check the main apply button's text — Easy Apply says "Easy Apply",
    // external apply buttons say "Apply" with no "Easy" prefix.
    const applyBtn = document.querySelector('button.jobs-apply-button');
    if (applyBtn) {
      const text = applyBtn.innerText?.toLowerCase() || '';
      if (text.includes('easy apply')) return true;
    }

    // Fallback: aria-label on the button
    const ariaBtn = document.querySelector('button[aria-label*="Easy Apply"]');
    if (ariaBtn) return true;

    // Fallback: Easy Apply badge on job card
    const badge = document.querySelector('.job-card-container__apply-method');
    if (badge?.innerText?.toLowerCase().includes('easy apply')) return true;

    return false;
  }

  // ── isLinkedInJobsPage() ─────────────────────────────────────────────────
  // Returns true if we're on a LinkedIn jobs-related page
  function isLinkedInJobsPage() {
    const url = window.location.href;
    return url.includes('linkedin.com/jobs') || url.includes('linkedin.com/feed');
  }

  // ── navigateToJobSearch() ─────────────────────────────────────────────────
  // Navigates to LinkedIn job search with the user's preferences
  function navigateToJobSearch(prefs) {
    const titles   = (prefs.jobTitles || ['Software Engineer']).join(' OR ');
    const location = prefs.location || 'Charlotte, NC';
    const keywords = encodeURIComponent(titles);
    const loc      = encodeURIComponent(location);

    // f_WT=2 = Remote jobs; f_TPR=r86400 = posted in last 24 hours
    window.location.href = `https://www.linkedin.com/jobs/search/?keywords=${keywords}&location=${loc}&f_TPR=r86400&sortBy=DD`;
  }

  // ── processCurrentJobPage() ───────────────────────────────────────────────
  // Handles automation when on a specific job post URL (not search results)
  async function processCurrentJobPage() {
    const jobDetails = extractJobDetails();
    if (!jobDetails.title) {
      console.log('[LinkedIn] On job page but could not extract details');
      return;
    }

    console.log(`[LinkedIn] Direct job page: ${jobDetails.title} at ${jobDetails.company}`);

    const matchResult = await OpenAIUtils.analyzeJobMatch(
      config.apiKey,
      config.resume,
      jobDetails.title,
      jobDetails.description,
      jobDetails.company
    );

    if (matchResult.score >= config.preferences.matchThreshold) {
      if (isEasyApplyJob()) {
        await applyViaEasyApply(jobDetails, window.location.href, matchResult);
      }
    }
  }

  // ── loadConfig() ─────────────────────────────────────────────────────────
  // Loads all configuration from the background script
  async function loadConfig() {
    const response = await sendMessage('GET_CONFIG', {});
    if (!response.success) {
      console.error('[LinkedIn] Failed to load config:', response.error);
      return null;
    }
    if (!response.hasApiKey) {
      console.error('[LinkedIn] No API key configured');
      showNotificationBanner('⚠️ Please configure your OpenAI API key in extension settings', 'warning');
      return null;
    }
    if (!response.resume) {
      console.error('[LinkedIn] No resume configured');
      showNotificationBanner('⚠️ Please add your resume in extension settings', 'warning');
      return null;
    }
    return response;
  }

  // ── logApplication() ─────────────────────────────────────────────────────
  // Sends an application log entry to the background script for storage
  async function logApplication(data) {
    await sendMessage('LOG_APPLICATION', data);
  }

  // ── sendMessage() ─────────────────────────────────────────────────────────
  // Sends a message to the background script and returns the response
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

  // ── waitForElement() ─────────────────────────────────────────────────────
  // Polls the DOM until an element matching the selector appears (or timeout)
  // Necessary for dynamic SPAs like LinkedIn where content loads asynchronously
  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) { resolve(existing); return; }

      // MutationObserver watches for DOM changes
      // When new nodes are added, it checks if they match our selector
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect(); // Stop watching
          resolve(el);
        }
      });

      // observe(target, options) starts watching
      // childList: true = watch for added/removed child elements
      // subtree: true = watch all descendants, not just direct children
      observer.observe(document.body, { childList: true, subtree: true });

      // Timeout: if element never appears, resolve with null
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  // ── waitForModalClose() ───────────────────────────────────────────────────
  // Waits for the Easy Apply modal to close (indicates user submitted or dismissed)
  function waitForModalClose(modal, timeout = 60000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        // If modal is no longer in the DOM, it was closed
        if (!document.contains(modal)) {
          resolve('closed');
          return;
        }
        if (Date.now() - start > timeout) {
          resolve('timeout');
          return;
        }
        setTimeout(check, 500); // Check every 500ms
      };
      check();
    });
  }

  // ── showNotificationBanner() ──────────────────────────────────────────────
  // Shows a non-intrusive notification banner at the top of the LinkedIn page
  function showNotificationBanner(message, type = 'info') {
    // Remove existing banner if present
    document.getElementById('ai-job-applicant-banner')?.remove();

    // Create the banner element
    const banner       = document.createElement('div');
    banner.id          = 'ai-job-applicant-banner';
    banner.textContent = message;

    // Style the banner inline (we don't have a stylesheet in the page context)
    const colors = {
      success: '#16a34a',
      warning: '#d97706',
      info:    '#0a66c2',
      error:   '#dc2626',
    };

    Object.assign(banner.style, {
      position:     'fixed',
      top:          '70px',        // Below LinkedIn's fixed header
      left:         '50%',
      transform:    'translateX(-50%)',
      background:   colors[type] || colors.info,
      color:        'white',
      padding:      '12px 24px',
      borderRadius: '8px',
      zIndex:       '999999',      // Above LinkedIn's UI
      fontSize:     '14px',
      fontWeight:   '600',
      maxWidth:     '600px',
      textAlign:    'center',
      boxShadow:    '0 4px 12px rgba(0,0,0,0.3)',
      cursor:       'pointer',
    });

    // Click the banner to dismiss it
    banner.addEventListener('click', () => banner.remove());

    document.body.appendChild(banner);

    // Auto-dismiss after 10 seconds
    setTimeout(() => banner?.remove(), 10000);
  }

  // ── sleep() ──────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  console.log('[AI Job Applicant] LinkedIn content script loaded');

})(); // End IIFE
