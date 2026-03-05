# AI Job Applicant — Setup Guide

## What This Extension Does
Automatically searches LinkedIn & Indeed for Software Engineer / AI Engineer jobs
in Charlotte, NC, analyzes them against your resume using OpenAI GPT-4o,
and applies to matching jobs. Sends you a daily email report of all applications.

---

## Step 1 — Generate Icons (Required)

The browser requires icon files before loading your extension.

1. Open Chrome and go to any webpage (e.g., google.com)
2. Press **F12** to open DevTools → click the **Console** tab
3. Open the file `icons/generate-icons.js` in a text editor
4. Copy all the code and paste it into the browser console
5. Press **Enter** — three PNG files will download automatically
6. Move `icon16.png`, `icon48.png`, `icon128.png` into the `icons/` folder

---

## Step 2 — Load the Extension in Chrome

1. Open Chrome and go to: `chrome://extensions`
2. Toggle **Developer mode** ON (top-right corner)
3. Click **"Load unpacked"**
4. Select the `job-apply-extension/` folder
5. The extension icon ("AI") should appear in your toolbar

---

## Step 3 — Get Your OpenAI API Key

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Click **"Create new secret key"**
3. Copy the key (starts with `sk-proj-...`)
4. **Add credits**: Go to Billing and add at least $5 — the extension uses GPT-4o
   - Cost estimate: ~$0.01–0.05 per job analysis (analyzing 30 jobs ≈ $0.30–1.50/day)

---

## Step 4 — Set Up Email Notifications (Free)

1. Go to [emailjs.com](https://www.emailjs.com) and create a free account
2. Click **Email Services** → **Add New Service** → Choose Gmail → Connect your account
3. Note your **Service ID** (e.g., `service_abc123`)
4. Click **Email Templates** → **Create New Template**
5. Set the template subject to: `{{subject}}`
6. Set the template body to: `{{html_body}}`
7. Note your **Template ID** (e.g., `template_xyz789`)
8. Go to **Account** → **General** → Copy your **Public Key**

---

## Step 5 — Configure the Extension

Click the extension icon in the toolbar → click the ⚙️ gear icon to open Settings.

### Tab 1: API Settings
- Paste your **OpenAI API key** (click 👁️ to verify it's correct)
- Click **"Test API Key"** — should show ✅
- Enter your **EmailJS** Service ID, Template ID, Public Key
- Enter the email address where you want to receive reports
- Click **"Send Test Email"** to verify

### Tab 2: My Profile
Fill in ALL fields:
```
First Name:    [your first name]
Last Name:     [your last name]
Email:         [your email — job applications will use this]
Phone:         [your phone number]
City:          Charlotte
State:         NC
LinkedIn URL:  https://linkedin.com/in/[your-profile]
GitHub:        https://github.com/[your-username]

Citizenship:   US Citizen ← pre-selected
Work Auth:     Yes ← pre-selected
Sponsorship:   No ← pre-selected
Veteran:       I am not a protected veteran ← pre-selected
Disability:    No, I don't wish to answer ← pre-selected
```

### Tab 3: My Resume
- Open your resume in Word/PDF
- Select All (Ctrl+A) → Copy (Ctrl+C)
- Paste into the text area
- Aim for 800+ characters for best AI matching

### Tab 4: Job Preferences
```
Job Titles:
  Software Engineer
  AI Engineer
  Machine Learning Engineer
  Full Stack Engineer

Location:        Charlotte, NC
Work Model:      Remote ✓, Hybrid ✓, On-site ✓
Experience:      Mid Level ✓, Senior ✓
Match Threshold: 65% (adjust based on how selective you want to be)
```

### Tab 5: App Settings
```
Max Applications Per Day: 30
Delay Between Applications: 8 seconds
Auto-Submit: OFF (recommended — review first!)
Enable LinkedIn: ON
Enable Indeed: ON
External Forms: ON
```

---

## Step 6 — Run the Automation

### Method A: LinkedIn
1. Click the extension icon → **"Open LinkedIn Jobs"**
2. LinkedIn will open with a search for Software Engineer jobs in Charlotte, NC
3. Go back to the extension popup → Click **▶ Start**
4. The extension will scan and apply to matching jobs automatically

### Method B: Indeed
1. Click the extension icon → **"Open Indeed"**
2. Same process — click **▶ Start**

### What Happens:
1. Extension scans job listings on the page
2. Clicks each job to read the full description
3. Sends description + your resume to OpenAI for matching
4. If score ≥ threshold:
   - **LinkedIn Easy Apply**: Opens the form, fills it out, highlights Submit button
   - **External form**: Opens company website in a new tab, fills the form there
5. Logs every action (applied/skipped/failed) with timestamps
6. Sends daily email report at 6 PM

---

## Firefox Installation

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on"**
3. Select any file inside the `job-apply-extension/` folder
4. Note: Temporary add-ons are removed when Firefox restarts — install permanently via:
   - Pack as `.xpi` and install (requires Mozilla account for signing)
   - Or use Firefox Developer Edition which allows unsigned extensions

---

## Safety & Legal Notes

### What This Extension Does (Legal ✅)
- Reads publicly visible job listings (same as you browsing the page)
- Fills forms on your behalf (like an autofill tool)
- You remain in control at all times (autoSubmit is OFF by default)

### What This Extension Does NOT Do
- Store your data anywhere except your own browser's encrypted storage
- Share your data with any third party (only OpenAI & EmailJS receive data)
- Guarantee any job applications succeed
- Violate LinkedIn/Indeed terms in a way that differs from other autofill tools

### Best Practices
- Keep delays ≥ 8 seconds between applications
- Keep daily limits ≤ 30 applications
- Review applications before submitting (keep autoSubmit: OFF)
- Don't run 24/7 — use it during normal business hours

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Extension not loading | Make sure Developer Mode is ON in chrome://extensions |
| "API key invalid" | Check the key starts with `sk-` and has billing credits |
| No jobs found | Navigate to a LinkedIn/Indeed search page FIRST, then click Start |
| Form not filling | The site's UI may have changed — check console for errors |
| Email not sending | Verify all three EmailJS IDs are correct; check spam folder |
| Extension disappears | Normal in Firefox — reinstall after restart or use permanent install |

---

## File Structure

```
job-apply-extension/
├── manifest.json              ← Extension configuration (browser reads this)
├── popup/
│   ├── popup.html             ← Toolbar popup UI
│   ├── popup.css              ← Popup styles
│   └── popup.js               ← Popup behavior
├── options/
│   ├── options.html           ← Settings page
│   ├── options.css            ← Settings styles
│   └── options.js             ← Settings behavior
├── background/
│   └── background.js          ← Background service worker (orchestrator)
├── content/
│   ├── linkedin.js            ← LinkedIn automation
│   ├── indeed.js              ← Indeed automation
│   └── form-filler.js         ← Generic form filling engine
├── utils/
│   ├── storage.js             ← Chrome storage helpers
│   ├── openai.js              ← OpenAI API wrapper
│   └── email.js               ← EmailJS email sender
└── icons/
    ├── generate-icons.js      ← Run this to create icons
    ├── icon16.png             ← Required (generate first)
    ├── icon48.png             ← Required
    └── icon128.png            ← Required
```

---

## How to Update Your Resume

Go to extension Settings → Tab "My Resume" → Paste new resume → Save.
The AI will use the new resume for all future job analyses immediately.
