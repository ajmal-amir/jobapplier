// ═══════════════════════════════════════════════════════════════════════════════
// FILE: background/background.js
// PURPOSE: The "brain" of the extension. This is a Service Worker that runs
//          behind the scenes, separate from any web page.
//
// WHAT IS A SERVICE WORKER?
//   A service worker is a special JavaScript file that runs in the background,
//   independently of any open tabs. It can:
//     ✓ Listen for messages from content scripts and the popup
//     ✓ Store and retrieve data
//     ✓ Set alarms (scheduled tasks, like cron jobs)
//     ✓ Send notifications
//     ✗ Cannot access the DOM (no document, no window)
//     ✗ Stops running when idle (restarts on demand)
//
// MESSAGE PASSING:
//   Content scripts (in web pages) can't directly call storage or APIs —
//   they communicate with the background script by sending messages.
//   Think of it like texting: content script sends a message, background
//   script receives it, processes it, and sends a reply.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Import utilities ─────────────────────────────────────────────────────────
// Load utility scripts into the service worker global scope.
importScripts('../utils/storage.js');
importScripts('../utils/email.js');
const StorageUtils = self.StorageUtils;
const EmailUtils   = self.EmailUtils;

// ─── APPLICATION STATE ───────────────────────────────────────────────────────
// Service workers can be stopped and restarted, so any variables here are
// temporary. For persistent state, always use chrome.storage.local.
// These variables track the current session's automation state in memory.
let automationState = {
  isRunning:    false,   // Is the automation currently active?
  isPaused:     false,   // Is it temporarily paused (waiting for user)?
  currentTab:   null,    // The tab ID we're currently working on
  jobQueue:     [],      // List of job URLs waiting to be processed
  processedUrls: new Set(), // URLs we've already visited this session (avoids duplicates)
  sessionStats: {        // Counters for this session (reset when extension restarts)
    applied:    0,
    skipped:    0,
    failed:     0,
    totalScanned: 0,
  }
};

// ─── INSTALL / UPDATE HANDLER ─────────────────────────────────────────────────
// Runs once when the extension is first installed or updated.
// Use this to set up default settings and alarms.
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[AI Job Applicant] Extension installed/updated:', details.reason);

  if (details.reason === 'install') {
    // First time install — set up default settings so the options page
    // has something to show before the user configures anything
    console.log('[AI Job Applicant] First install — setting up defaults');

    // Open the options page automatically so the user can configure the extension
    chrome.tabs.create({ url: 'options/options.html' });
  }

  // Set up the daily email alarm regardless of install/update
  // This ensures the alarm survives extension updates
  await setupDailyEmailAlarm();
});

// ─── ALARM HANDLER ────────────────────────────────────────────────────────────
// Chrome alarms are like cron jobs — they fire at scheduled times.
// Unlike setTimeout(), alarms persist even when the service worker is sleeping.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('[AI Job Applicant] Alarm fired:', alarm.name);

  if (alarm.name === 'dailyEmailReport') {
    // Time to send the daily email report!
    await sendDailyEmailReport();
  }
});

// ─── SET UP DAILY EMAIL ALARM ─────────────────────────────────────────────────
// Creates a repeating alarm that fires once per day at the user's preferred time.
async function setupDailyEmailAlarm() {
  // First, clear any existing alarm to avoid duplicates
  await chrome.alarms.clear('dailyEmailReport');

  // Load user settings to get their preferred email time
  const settings = await StorageUtils.getAppSettings();

  if (!settings.sendDailyEmail) {
    console.log('[AI Job Applicant] Daily email disabled in settings');
    return; // User opted out of email reports
  }

  // Parse the time string "18:00" into hours and minutes
  const [hours, minutes] = settings.emailTime.split(':').map(Number);

  // Calculate when to fire the alarm next
  const now = new Date();
  const nextFire = new Date();
  nextFire.setHours(hours, minutes, 0, 0); // Set to today at the configured time

  // If that time has already passed today, schedule for tomorrow
  if (nextFire <= now) {
    nextFire.setDate(nextFire.getDate() + 1); // Add one day
  }

  // chrome.alarms.create() schedules an alarm
  // when: timestamp in milliseconds of when to fire first
  // periodInMinutes: how often to repeat (1440 min = 24 hours)
  chrome.alarms.create('dailyEmailReport', {
    when: nextFire.getTime(),
    periodInMinutes: 1440  // Repeat every 24 hours
  });

  console.log(`[AI Job Applicant] Daily email alarm set for ${nextFire.toLocaleString()}`);
}

// ─── SEND DAILY EMAIL REPORT ─────────────────────────────────────────────────
// Collects today's log entries and emails them to the user.
async function sendDailyEmailReport() {
  console.log('[AI Job Applicant] Sending daily email report...');

  try {
    // Load required data from storage
    const emailConfig = await StorageUtils.load(StorageUtils.KEYS.EMAIL_CONFIG, {});
    const allLogs     = await StorageUtils.load(StorageUtils.KEYS.APP_LOG, []);

    // Filter to only today's entries
    const today = new Date().toISOString().split('T')[0]; // "2024-01-15"
    const todayLogs = allLogs.filter(entry => {
      // entry.timestamp is an ISO string like "2024-01-15T14:30:00.000Z"
      return entry.timestamp.startsWith(today);
    });

    // Calculate summary statistics from today's logs
    const stats = {
      applied:       todayLogs.filter(e => e.status === 'applied').length,
      skipped:       todayLogs.filter(e => e.status === 'skipped').length,
      failed:        todayLogs.filter(e => e.status === 'failed').length,
      linkedInCount: todayLogs.filter(e => e.source === 'LinkedIn').length,
      indeedCount:   todayLogs.filter(e => e.source === 'Indeed').length,
      // Calculate average match score (handle division by zero)
      avgMatchScore: todayLogs.length > 0
        ? Math.round(todayLogs.reduce((sum, e) => sum + (e.matchScore || 0), 0) / todayLogs.length)
        : 0,
    };

    // Send the email via EmailJS
    await EmailUtils.sendDailyReport(emailConfig, todayLogs, stats);

  } catch (error) {
    console.error('[AI Job Applicant] Failed to send daily report:', error.message);
  }
}

// ─── MESSAGE LISTENER ─────────────────────────────────────────────────────────
// This is the central hub for communication between all extension parts.
// When any content script or popup calls chrome.runtime.sendMessage(),
// this listener receives it.
//
// message.action: a string identifying what to do (like an API endpoint)
// message.data: any payload data sent with the message
// sender: info about who sent the message (which tab, which script)
// sendResponse: call this function to send a reply back to the sender
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AI Job Applicant] Received message:', message.action, 'from tab:', sender.tab?.id);

  // Handle the message asynchronously (we need async/await for storage/API calls)
  // We return true to tell Chrome we'll call sendResponse() asynchronously
  handleMessage(message, sender, sendResponse);
  return true; // IMPORTANT: Keep message channel open for async response
});

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
// Routes incoming messages to the appropriate handler function.
async function handleMessage(message, sender, sendResponse) {
  try {
    let response;

    // Switch on the action name — like a REST API router
    switch (message.action) {

      // ── Start/Stop/Pause Automation ──────────────────────────────────────
      case 'START_AUTOMATION':
        response = await handleStartAutomation(message.data);
        break;

      case 'STOP_AUTOMATION':
        response = await handleStopAutomation();
        break;

      case 'PAUSE_AUTOMATION':
        automationState.isPaused = !automationState.isPaused; // Toggle pause
        await StorageUtils.save(StorageUtils.KEYS.IS_RUNNING, !automationState.isPaused);
        response = { success: true, isPaused: automationState.isPaused };
        break;

      // ── Job Application Logging ───────────────────────────────────────────
      case 'LOG_APPLICATION':
        // Content script reports a job application result — save it to log
        const logRecord = await StorageUtils.addToLog(message.data);

        // Update session counters
        if (message.data.status === 'applied')  automationState.sessionStats.applied++;
        if (message.data.status === 'skipped')  automationState.sessionStats.skipped++;
        if (message.data.status === 'failed')   automationState.sessionStats.failed++;
        automationState.sessionStats.totalScanned++;

        // Increment the daily count to enforce the max daily limit
        await StorageUtils.incrementTodayCount();

        // Optionally send an immediate email notification for each application
        const emailConfig = await StorageUtils.load(StorageUtils.KEYS.EMAIL_CONFIG, {});
        if (emailConfig.sendImmediateNotification && message.data.status === 'applied') {
          // Don't await this — let it happen in the background so we don't slow down
          EmailUtils.sendJobAppliedNotification(emailConfig, logRecord).catch(console.error);
        }

        response = { success: true, record: logRecord };
        break;

      // ── Status Check ──────────────────────────────────────────────────────
      case 'GET_STATUS':
        // Popup asks: "what's the current status?"
        const dailyCount = await StorageUtils.getTodayCount();
        const settings   = await StorageUtils.getAppSettings();
        response = {
          isRunning:    automationState.isRunning,
          isPaused:     automationState.isPaused,
          sessionStats: automationState.sessionStats,
          dailyCount:   dailyCount.count,
          dailyLimit:   settings.maxDailyApplications,
        };
        break;

      // ── Check Daily Limit ─────────────────────────────────────────────────
      case 'CHECK_DAILY_LIMIT':
        // Content script checks if it's allowed to apply to more jobs today
        const daily    = await StorageUtils.getTodayCount();
        const appSettings = await StorageUtils.getAppSettings();
        const underLimit  = daily.count < appSettings.maxDailyApplications;
        response = {
          allowed:   underLimit,
          current:   daily.count,
          limit:     appSettings.maxDailyApplications,
          remaining: Math.max(0, appSettings.maxDailyApplications - daily.count),
        };
        break;

      // ── Get Full Configuration ────────────────────────────────────────────
      case 'GET_CONFIG':
        // Content script needs all settings to do its job
        const [profile, resume, prefs, appsettings, apiKey] = await Promise.all([
          StorageUtils.getProfile(),
          StorageUtils.load(StorageUtils.KEYS.RESUME, ''),
          StorageUtils.getJobPreferences(),
          StorageUtils.getAppSettings(),
          StorageUtils.load(StorageUtils.KEYS.OPENAI_KEY, ''),
        ]);
        // Promise.all() runs multiple async operations in parallel — faster!
        response = {
          profile:     profile,
          resume:      resume,
          preferences: prefs,
          settings:    appsettings,
          hasApiKey:   !!apiKey, // !! converts to boolean — true if key exists
          // ⚠️ We send the API key to content scripts so they can call OpenAI
          //    directly. This is necessary but means the key is in page memory.
          //    It's never sent to any third-party site.
          apiKey:      apiKey,
        };
        break;

      // ── Get Application Log ───────────────────────────────────────────────
      case 'GET_LOG':
        const log = await StorageUtils.load(StorageUtils.KEYS.APP_LOG, []);
        // Return the most recent entries (configurable limit)
        const limit = message.data?.limit || 100;
        response = { log: log.slice(0, limit) };
        break;

      // ── Test Email Configuration ──────────────────────────────────────────
      case 'TEST_EMAIL':
        const testEmailConfig = await StorageUtils.load(StorageUtils.KEYS.EMAIL_CONFIG, {});
        const testSuccess = await EmailUtils.sendEmail(testEmailConfig, {
          subject:   'AI Job Applicant — Test Email',
          html_body: '<h2>Test Successful!</h2><p>Your email notifications are working correctly.</p>',
          plain_body: 'Test Successful! Your email notifications are working correctly.',
        });
        response = { success: testSuccess };
        break;

      // ── Open Job URL in New Tab ───────────────────────────────────────────
      case 'OPEN_JOB_TAB':
        // Content script requests that background open a URL in a new tab
        const newTab = await chrome.tabs.create({
          url:    message.data.url,
          active: false // Open in background — don't steal focus from user
        });
        response = { success: true, tabId: newTab.id };
        break;

      // ── Unknown Action ────────────────────────────────────────────────────
      default:
        console.warn('[AI Job Applicant] Unknown message action:', message.action);
        response = { success: false, error: `Unknown action: ${message.action}` };
    }

    // Send the response back to whoever sent the message
    sendResponse({ success: true, ...response });

  } catch (error) {
    // Catch any unexpected errors and send them back as error responses
    console.error('[AI Job Applicant] Error handling message:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// ─── START AUTOMATION ─────────────────────────────────────────────────────────
// Called when the user clicks "Start" in the popup.
// Validates settings and updates state to indicate automation is active.
async function handleStartAutomation(data) {
  // ── Validate required settings ──────────────────────────────────────────
  const apiKey = await StorageUtils.load(StorageUtils.KEYS.OPENAI_KEY, '');
  if (!apiKey) {
    // Can't start without an API key
    return { success: false, error: 'OpenAI API key not configured. Go to extension options.' };
  }

  const resume = await StorageUtils.load(StorageUtils.KEYS.RESUME, '');
  if (!resume) {
    return { success: false, error: 'Resume not configured. Go to extension options.' };
  }

  const profile = await StorageUtils.getProfile();
  if (!profile.email) {
    return { success: false, error: 'Email address not configured. Go to extension options.' };
  }

  // ── Check daily limit ───────────────────────────────────────────────────
  const daily    = await StorageUtils.getTodayCount();
  const settings = await StorageUtils.getAppSettings();
  if (daily.count >= settings.maxDailyApplications) {
    return {
      success: false,
      error: `Daily limit of ${settings.maxDailyApplications} applications reached. Come back tomorrow!`
    };
  }

  // ── Update state ────────────────────────────────────────────────────────
  automationState.isRunning    = true;
  automationState.isPaused     = false;
  automationState.sessionStats = { applied: 0, skipped: 0, failed: 0, totalScanned: 0 };
  automationState.processedUrls.clear(); // Clear session's visited URL cache

  // Save running state persistently (so content scripts know to run)
  await StorageUtils.save(StorageUtils.KEYS.IS_RUNNING, true);

  console.log('[AI Job Applicant] Automation started');

  // Send message to content script on the active tab to begin
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    // Inject a message into the active tab's content script to start scanning
    chrome.tabs.sendMessage(activeTab.id, { action: 'BEGIN_SCANNING' }).catch(() => {
      // Content script might not be loaded on this page — that's OK
      console.log('[AI Job Applicant] No content script on active tab — navigate to LinkedIn or Indeed');
    });
  }

  return { success: true, message: 'Automation started! Navigate to LinkedIn or Indeed job search.' };
}

// ─── STOP AUTOMATION ──────────────────────────────────────────────────────────
async function handleStopAutomation() {
  automationState.isRunning = false;
  automationState.isPaused  = false;

  // Save stopped state so content scripts know to stop
  await StorageUtils.save(StorageUtils.KEYS.IS_RUNNING, false);

  console.log('[AI Job Applicant] Automation stopped. Session stats:', automationState.sessionStats);

  return {
    success: true,
    stats:   automationState.sessionStats,
    message: 'Automation stopped.'
  };
}

// ─── TAB UPDATE LISTENER ──────────────────────────────────────────────────────
// Fires whenever a tab's URL changes or the page finishes loading.
// Used to detect when the user navigates to LinkedIn/Indeed job search pages.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only act when the page has fully loaded (status === 'complete')
  // and when automation is running
  if (changeInfo.status !== 'complete' || !automationState.isRunning) return;

  // Check if this is a LinkedIn or Indeed job search page
  const isLinkedIn = tab.url?.includes('linkedin.com/jobs');
  const isIndeed   = tab.url?.includes('indeed.com');

  if (isLinkedIn || isIndeed) {
    console.log('[AI Job Applicant] Job search page detected:', tab.url);

    // Send a message to the content script in this tab to start scanning
    // The content script will pick this up and start the automation loop
    chrome.tabs.sendMessage(tabId, { action: 'BEGIN_SCANNING' }).catch((err) => {
      // Ignore errors — content script might not be ready yet
      console.log('[AI Job Applicant] Tab message failed (normal on first load):', err.message);
    });
  }
});

// ─── NOTIFICATION CLICK HANDLER ───────────────────────────────────────────────
// When the user clicks a desktop notification, open the relevant job URL.
chrome.notifications.onClicked.addListener((notificationId) => {
  // Our notification IDs encode the job URL: "job-<URL>"
  if (notificationId.startsWith('job-')) {
    const url = notificationId.replace('job-', '');
    chrome.tabs.create({ url }); // Open the job page
  }
});

console.log('[AI Job Applicant] Background service worker started');
