// ═══════════════════════════════════════════════════════════════════════════════
// FILE: utils/email.js
// PURPOSE: Sends email notifications about job applications using EmailJS.
//
// WHAT IS EMAILJS?
//   EmailJS (emailjs.com) is a free service that lets you send emails directly
//   from the browser (no backend server needed!). You create an email template
//   on their website, and then call their API with variables to fill the template.
//
// SETUP REQUIRED (one-time):
//   1. Go to https://www.emailjs.com and create a free account
//   2. Add your Gmail (or other email) as an Email Service
//   3. Create an Email Template with the variables below
//   4. Copy your Service ID, Template ID, and Public Key into extension settings
//
// HOW EMAILJS WORKS:
//   Your browser → EmailJS API → Your email provider → Your inbox
//   (EmailJS acts as a relay — they never store your email content)
//
// EMAILJS FREE TIER:
//   200 emails/month — plenty for daily job application reports
// ═══════════════════════════════════════════════════════════════════════════════

if (typeof window.EmailUtils === 'undefined') {

  window.EmailUtils = {

    // ─── EMAILJS API ENDPOINT ──────────────────────────────────────────────
    // This is EmailJS's REST API URL. We call it with a POST request.
    // No SDK needed — we use fetch() directly.
    EMAILJS_API_URL: 'https://api.emailjs.com/api/v1.0/email/send',

    // ─── SEND EMAIL ──────────────────────────────────────────────────────────
    // Sends an email via EmailJS REST API.
    //
    // @param {Object} emailConfig - { serviceId, templateId, publicKey, toEmail }
    // @param {Object} templateVars - Variables to inject into your EmailJS template
    // @returns {Promise<boolean>} - true on success, false on failure
    async sendEmail(emailConfig, templateVars) {
      // Validate that we have all the required EmailJS configuration
      if (!emailConfig.serviceId || !emailConfig.templateId || !emailConfig.publicKey) {
        console.warn('[AI Job Applicant] EmailJS not configured — skipping email notification');
        return false;
      }

      // ── Build the EmailJS request payload ──────────────────────────────
      // This is the exact format EmailJS's API expects.
      // Your email template on emailjs.com should use {{variable_name}} syntax.
      const payload = {
        service_id:  emailConfig.serviceId,   // e.g., "service_abc123"
        template_id: emailConfig.templateId,  // e.g., "template_xyz789"
        user_id:     emailConfig.publicKey,   // Your EmailJS public key
        template_params: {
          // These variables are injected into your EmailJS email template.
          // In your template, use {{to_email}}, {{subject}}, {{body}}, etc.
          to_email:    emailConfig.toEmail,   // Recipient email address
          ...templateVars                     // Spread all template variables
        }
      };

      try {
        // ── POST request to EmailJS API ─────────────────────────────────
        const response = await fetch(this.EMAILJS_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', // Tell server we're sending JSON
            'origin': 'chrome-extension://',    // Identify ourselves as an extension
          },
          body: JSON.stringify(payload), // Convert JS object to JSON string
        });

        if (response.ok) {
          // Status 200 = email sent successfully
          console.log('[AI Job Applicant] Email notification sent successfully');
          return true;
        } else {
          // Read the error response body for debugging
          const errorText = await response.text();
          console.error(`[AI Job Applicant] EmailJS error ${response.status}: ${errorText}`);
          return false;
        }

      } catch (error) {
        // fetch() throws on network errors (no internet, etc.)
        console.error('[AI Job Applicant] Failed to send email:', error.message);
        return false;
      }
    },

    // ─── SEND DAILY REPORT ────────────────────────────────────────────────────
    // Sends a formatted daily summary of all job applications.
    //
    // @param {Object} emailConfig - EmailJS configuration
    // @param {Array}  logEntries  - Today's application log records
    // @param {Object} stats       - Summary statistics
    // @returns {Promise<boolean>}
    async sendDailyReport(emailConfig, logEntries, stats) {
      // ── Format the date nicely ──────────────────────────────────────────
      // toLocaleDateString() converts a Date to a human-readable string
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',   // "Monday"
        year: 'numeric',   // "2024"
        month: 'long',     // "January"
        day: 'numeric',    // "15"
      });

      // ── Build an HTML table of applications ────────────────────────────
      // We build the HTML as a string using template literals (backtick strings).
      // Template literals allow multi-line strings and ${variable} interpolation.
      const tableRows = logEntries
        .filter(entry => entry.status === 'applied')  // Only successful applications
        .map(entry => {
          // Format the timestamp to just show the time (not the full ISO string)
          const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
          });
          // Each row shows: time, job title, company, source, match score, type
          return `<tr>
            <td style="padding:8px;border:1px solid #ddd;">${time}</td>
            <td style="padding:8px;border:1px solid #ddd;">${this._escapeHtml(entry.jobTitle)}</td>
            <td style="padding:8px;border:1px solid #ddd;">${this._escapeHtml(entry.company)}</td>
            <td style="padding:8px;border:1px solid #ddd;">${entry.source}</td>
            <td style="padding:8px;border:1px solid #ddd;">${entry.matchScore}%</td>
            <td style="padding:8px;border:1px solid #ddd;">${entry.applyType}</td>
          </tr>`;
        }).join('\n'); // Join all rows into one string

      // ── Build the full HTML email body ──────────────────────────────────
      const htmlBody = `
<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
  <h2 style="color: #0077b5;">🤖 AI Job Applicant — Daily Report</h2>
  <p style="color: #666;">${today}</p>

  <!-- Summary Statistics Box -->
  <div style="background:#f0f7ff;padding:16px;border-radius:8px;margin-bottom:20px;">
    <h3 style="margin:0 0 12px;">Summary</h3>
    <table style="width:100%;">
      <tr>
        <td><strong>✅ Applied:</strong></td>
        <td>${stats.applied || 0}</td>
        <td><strong>⏭️ Skipped:</strong></td>
        <td>${stats.skipped || 0} (low match score)</td>
      </tr>
      <tr>
        <td><strong>❌ Failed:</strong></td>
        <td>${stats.failed || 0}</td>
        <td><strong>🎯 Avg Match:</strong></td>
        <td>${stats.avgMatchScore || 0}%</td>
      </tr>
      <tr>
        <td><strong>🏢 LinkedIn:</strong></td>
        <td>${stats.linkedInCount || 0}</td>
        <td><strong>🔍 Indeed:</strong></td>
        <td>${stats.indeedCount || 0}</td>
      </tr>
    </table>
  </div>

  <!-- Applications Table -->
  ${logEntries.length > 0 ? `
  <h3>Applications Submitted Today</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <thead>
      <tr style="background:#0077b5;color:white;">
        <th style="padding:10px;text-align:left;">Time</th>
        <th style="padding:10px;text-align:left;">Job Title</th>
        <th style="padding:10px;text-align:left;">Company</th>
        <th style="padding:10px;text-align:left;">Source</th>
        <th style="padding:10px;text-align:left;">Match</th>
        <th style="padding:10px;text-align:left;">Type</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
  ` : '<p>No applications submitted today.</p>'}

  <!-- Footer -->
  <hr style="margin:20px 0;">
  <p style="color:#999;font-size:12px;">
    This report was generated by your AI Job Applicant Chrome Extension.<br>
    To stop receiving these emails, update your settings in the extension options.
  </p>
</div>
      `.trim();

      // ── Build the plain text fallback ───────────────────────────────────
      // Some email clients don't render HTML well. We provide a plain text version too.
      const plainText = `AI Job Applicant — Daily Report
${today}

Summary:
- Applied: ${stats.applied || 0}
- Skipped: ${stats.skipped || 0} (low match score)
- Failed: ${stats.failed || 0}
- Average Match Score: ${stats.avgMatchScore || 0}%

Applications: ${logEntries.filter(e => e.status === 'applied').map(e =>
  `\n- ${e.jobTitle} at ${e.company} (${e.source}, ${e.matchScore}% match)`
).join('')}
      `.trim();

      // ── Send via EmailJS ────────────────────────────────────────────────
      return this.sendEmail(emailConfig, {
        subject:     `Job Application Report — ${stats.applied || 0} Jobs Applied — ${today}`,
        html_body:   htmlBody,      // Used by EmailJS template variable {{html_body}}
        plain_body:  plainText,     // Used by EmailJS template variable {{plain_body}}
        applied_count: stats.applied || 0,
        date:        today,
      });
    },

    // ─── SEND IMMEDIATE NOTIFICATION ─────────────────────────────────────────
    // Sends a single-job notification right after applying (optional feature).
    //
    // @param {Object} emailConfig - EmailJS configuration
    // @param {Object} jobRecord   - A single application log record
    async sendJobAppliedNotification(emailConfig, jobRecord) {
      // Only send if the user has this feature enabled (don't spam them)
      const htmlBody = `
<div style="font-family:Arial,sans-serif;">
  <h3>✅ Job Application Submitted</h3>
  <p>
    <strong>Position:</strong> ${this._escapeHtml(jobRecord.jobTitle)}<br>
    <strong>Company:</strong> ${this._escapeHtml(jobRecord.company)}<br>
    <strong>Location:</strong> ${this._escapeHtml(jobRecord.location)}<br>
    <strong>Source:</strong> ${jobRecord.source}<br>
    <strong>Match Score:</strong> ${jobRecord.matchScore}%<br>
    <strong>Applied via:</strong> ${jobRecord.applyType}<br>
    <strong>Time:</strong> ${new Date(jobRecord.timestamp).toLocaleString()}
  </p>
  ${jobRecord.url ? `<p><a href="${jobRecord.url}">View Job Posting</a></p>` : ''}
</div>
      `.trim();

      return this.sendEmail(emailConfig, {
        subject:   `Applied: ${jobRecord.jobTitle} at ${jobRecord.company}`,
        html_body: htmlBody,
        plain_body: `Applied to ${jobRecord.jobTitle} at ${jobRecord.company}. Match: ${jobRecord.matchScore}%`,
      });
    },

    // ─── HTML ESCAPE HELPER ───────────────────────────────────────────────────
    // Prevents XSS: converts special HTML characters to their safe entities.
    // For example: "<script>" becomes "&lt;script&gt;" (harmless text, not code).
    // Always escape user-provided data before inserting it into HTML!
    _escapeHtml(text) {
      if (!text) return '';
      // Replace each special character with its HTML entity equivalent
      return String(text)
        .replace(/&/g,  '&amp;')   // & must be first, or you'll double-escape
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#x27;');
    },

  }; // end window.EmailUtils

} // end namespace guard
