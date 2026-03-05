// ═══════════════════════════════════════════════════════════════════════════════
// FILE: utils/storage.js
// PURPOSE: Provides helper functions to save and retrieve data from
//          Chrome's built-in encrypted storage (chrome.storage.local).
//          This is safer than localStorage because the browser encrypts it
//          using the OS's keychain — so even if someone reads your disk,
//          they can't see your API keys.
//
// HOW STORAGE WORKS IN EXTENSIONS:
//   chrome.storage.local  → Stores data on the local machine (not synced)
//   chrome.storage.sync   → Syncs across devices (limited to 100KB, not for secrets!)
//   We always use .local for anything sensitive (API keys, resume, personal info).
//
// NOTE: chrome.storage uses callbacks OR Promises. We use async/await with
//       Promises here for cleaner, more readable code.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── NAMESPACE GUARD ─────────────────────────────────────────────────────────
// Since content scripts share a global scope (all loaded files can see each
// other's variables), we wrap everything in a check to avoid re-declaring
// if this file gets loaded twice.
if (typeof self.StorageUtils === 'undefined') {

  // ─── StorageUtils OBJECT ──────────────────────────────────────────────────
  // We define all our functions as properties of one object.
  // This prevents "polluting" the global scope with dozens of function names.
  self.StorageUtils = {

    // ─── KEY CONSTANTS ──────────────────────────────────────────────────────
    // Centralizing key names as constants prevents typos. If you mistype a
    // key, you'll get undefined instead of your data — hard bugs to find.
    KEYS: {
      PROFILE:      'userProfile',       // Name, email, phone, address, etc.
      RESUME:       'resumeText',        // Raw resume text (pasted by user)
      OPENAI_KEY:   'openAiApiKey',      // OpenAI secret key (stored encrypted by OS)
      EMAIL_CONFIG: 'emailConfig',       // EmailJS configuration
      JOB_PREFS:    'jobPreferences',    // Desired roles, location, salary, etc.
      APP_SETTINGS: 'appSettings',       // Max daily apps, delay, auto-submit, etc.
      APP_LOG:      'applicationLog',    // List of all jobs applied to
      IS_RUNNING:   'isRunning',         // Boolean: is the automation currently active?
      DAILY_COUNT:  'dailyAppCount',     // { date: 'YYYY-MM-DD', count: number }
    },

    // ─── SAVE (SET) ──────────────────────────────────────────────────────────
    // Saves any value to chrome.storage.local.
    // @param {string} key   - The storage key (use KEYS constants above)
    // @param {any}    value - Any JSON-serializable value (object, string, etc.)
    // @returns {Promise<void>}
    async save(key, value) {
      // chrome.storage.local.set() takes an object where keys map to values.
      // We wrap it in a Promise so we can use async/await.
      return new Promise((resolve, reject) => {
        chrome.storage.local.set(
          { [key]: value },   // ES6 computed property key: { 'userProfile': value }
          () => {
            // chrome.runtime.lastError is set if something went wrong
            if (chrome.runtime.lastError) {
              // Reject the Promise with the error — callers can catch() this
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(); // Success — nothing to return, just resolve
            }
          }
        );
      });
    },

    // ─── LOAD (GET) ──────────────────────────────────────────────────────────
    // Retrieves a value from chrome.storage.local.
    // @param {string} key      - The storage key
    // @param {any}    fallback - Returned if the key doesn't exist (default: null)
    // @returns {Promise<any>}
    async load(key, fallback = null) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.get(
          [key],  // Pass an array of keys to retrieve
          (result) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              // result is an object like { 'userProfile': {...} }
              // If the key wasn't found, result[key] is undefined — use fallback
              resolve(result[key] !== undefined ? result[key] : fallback);
            }
          }
        );
      });
    },

    // ─── DELETE ──────────────────────────────────────────────────────────────
    // Removes a key from storage.
    // @param {string} key - The storage key to delete
    async delete(key) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.remove(key, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });
    },

    // ─── CLEAR ALL ───────────────────────────────────────────────────────────
    // ⚠️  DANGER: Deletes ALL extension data. Used for "reset" functionality.
    async clearAll() {
      return new Promise((resolve, reject) => {
        chrome.storage.local.clear(() => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });
    },

    // ─── GET FULL PROFILE ────────────────────────────────────────────────────
    // Convenience method: loads the user's complete profile in one call.
    // Returns a merged object with defaults so callers don't get undefined.
    async getProfile() {
      const profile = await this.load(this.KEYS.PROFILE, {});
      // Object spread (...) merges defaults with stored values.
      // Stored values WIN — they overwrite the defaults on the right.
      return {
        firstName:   '',
        lastName:    '',
        email:       '',
        phone:       '',
        address:     '',
        city:        'Charlotte',
        state:       'NC',
        zipCode:     '',
        country:     'United States',
        linkedin:    '',
        github:      '',
        portfolio:   '',
        // Work authorization — pre-filled for this user
        usWorkAuth:  true,      // Authorized to work in the US
        requireSponsorship: false, // Does NOT need visa sponsorship
        veteranStatus: 'I am not a protected veteran',
        disabilityStatus: 'No, I don\'t wish to answer',
        citizenStatus: 'US Citizen',
        ...profile  // Overwrite defaults with whatever the user actually saved
      };
    },

    // ─── GET JOB PREFERENCES ─────────────────────────────────────────────────
    // Returns the user's job search settings with defaults.
    async getJobPreferences() {
      const prefs = await this.load(this.KEYS.JOB_PREFS, {});
      return {
        jobTitles:    ['Software Engineer', 'AI Engineer', 'Machine Learning Engineer', 'Full Stack Engineer'],
        location:     'Charlotte, NC',
        remote:       ['remote', 'hybrid', 'on-site'], // Accepted work models
        minSalary:    0,           // 0 = no minimum filter
        jobTypes:     ['full-time'],
        experienceLevel: ['mid-level', 'senior'],
        matchThreshold: 65,        // Only apply if AI scores match ≥ 65%
        ...prefs
      };
    },

    // ─── GET APP SETTINGS ────────────────────────────────────────────────────
    // Returns automation behavior settings with safe defaults.
    async getAppSettings() {
      const settings = await this.load(this.KEYS.APP_SETTINGS, {});
      return {
        maxDailyApplications: 30,    // Safety limit — applying to 30+ jobs/day looks spammy
        delayBetweenApps: 8000,      // 8 seconds between applications (in milliseconds)
        autoSubmit: false,           // ⚠️ FALSE by default — review before submitting
        enableLinkedIn: true,        // Scan LinkedIn
        enableIndeed: true,          // Scan Indeed
        enableExternalForms: true,   // Fill out forms on company websites
        skipApplied: true,           // Skip jobs already applied to
        sendDailyEmail: true,        // Email a daily summary
        emailTime: '18:00',          // Send daily report at 6 PM
        ...settings
      };
    },

    // ─── ADD TO APPLICATION LOG ──────────────────────────────────────────────
    // Appends one job application record to the running log.
    // @param {Object} entry - The job application record
    async addToLog(entry) {
      // Load existing log (or start with empty array)
      const log = await this.load(this.KEYS.APP_LOG, []);

      // Build a standardized log record with a timestamp
      const record = {
        id:          Date.now(),                    // Unique ID using current timestamp
        timestamp:   new Date().toISOString(),      // ISO 8601 format: "2024-01-15T14:30:00Z"
        jobTitle:    entry.jobTitle    || 'Unknown',
        company:     entry.company     || 'Unknown',
        location:    entry.location    || 'Unknown',
        source:      entry.source      || 'Unknown', // 'LinkedIn' or 'Indeed'
        applyType:   entry.applyType   || 'Unknown', // 'EasyApply' or 'External'
        url:         entry.url         || '',
        status:      entry.status      || 'applied', // 'applied', 'skipped', 'failed'
        matchScore:  entry.matchScore  || 0,         // AI relevance score 0-100
        notes:       entry.notes       || '',        // Any extra info (error messages, etc.)
      };

      // Add the new record to the beginning of the array (newest first)
      log.unshift(record);

      // Keep only the last 500 records to prevent storage from growing indefinitely
      // (chrome.storage.local limit is 5MB)
      const trimmedLog = log.slice(0, 500);

      // Save the updated log back to storage
      await this.save(this.KEYS.APP_LOG, trimmedLog);

      return record; // Return the record so the caller can use it
    },

    // ─── GET TODAY'S APPLICATION COUNT ───────────────────────────────────────
    // Tracks how many applications were submitted today to enforce daily limits.
    async getTodayCount() {
      const today = new Date().toISOString().split('T')[0]; // "2024-01-15"
      const daily = await this.load(this.KEYS.DAILY_COUNT, { date: '', count: 0 });

      // If the stored date is not today, reset the counter
      if (daily.date !== today) {
        const fresh = { date: today, count: 0 };
        await this.save(this.KEYS.DAILY_COUNT, fresh);
        return fresh;
      }
      return daily;
    },

    // ─── INCREMENT TODAY'S COUNT ─────────────────────────────────────────────
    async incrementTodayCount() {
      const daily = await this.getTodayCount();
      daily.count += 1;
      await this.save(this.KEYS.DAILY_COUNT, daily);
      return daily.count;
    },

  }; // end self.StorageUtils

} // end namespace guard
