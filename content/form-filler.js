// ═══════════════════════════════════════════════════════════════════════════════
// FILE: content/form-filler.js
// PURPOSE: A generic, AI-powered form filling engine that works on any job
//          application form — whether it's LinkedIn, Indeed, or an external
//          company ATS (Applicant Tracking System) like Greenhouse, Lever,
//          Workday, or BambooHR.
//
// HOW IT WORKS:
//   1. Scans the page for all visible form fields
//   2. Extracts the label text for each field
//   3. Checks if the answer is known from the user's profile (fast path)
//   4. If not, asks OpenAI to determine the best value (slow path, uses API credits)
//   5. Fills the field with the determined value
//   6. Optionally waits for human confirmation before submitting
//
// LOADED BEFORE: linkedin.js and indeed.js (they call FormFiller functions)
// ═══════════════════════════════════════════════════════════════════════════════

if (typeof window.FormFiller === 'undefined') {

  window.FormFiller = {

    // ─── STATIC ANSWER MAP ─────────────────────────────────────────────────
    // A lookup table for common questions that have predictable answers.
    // Using this avoids unnecessary OpenAI API calls (faster + cheaper).
    // Keys are lowercased label patterns; values are the answers to use.
    //
    // We use includes() checks in the code below (not exact matches)
    // so "are you authorized to work" matches "Are you legally authorized to work in the US?"
    STATIC_ANSWERS: {
      // Work authorization
      'authorized to work':         'Yes',
      'legally authorized':         'Yes',
      'require sponsorship':        'No',
      'need sponsorship':           'No',
      'visa sponsorship':           'No',
      'work authorization':         'US Citizen',
      'citizenship':                'US Citizen',
      'work in the us':             'Yes',
      // Veteran status
      'veteran':                    'No',
      'protected veteran':          'I am not a protected veteran',
      'military':                   'No',
      // Disability
      'disability':                 "No, I don't wish to answer",
      'disabled':                   "No, I don't wish to answer",
      // EEO / EEOC (Equal Employment Opportunity)
      'race':                       'Prefer not to say',
      'ethnicity':                  'Prefer not to say',
      'gender':                     'Prefer not to say',
      'sexual orientation':         'Prefer not to say',
      // Availability
      'available to start':         'Immediately',
      'start date':                 'Immediately',
      'when can you start':         'Immediately',
      // Job type
      'full-time':                  'Yes',
      'part-time':                  'No',
      // Background check
      'background check':           'Yes',
      'drug test':                  'Yes',
      // Salary
      'desired salary':             'Negotiable',
      'salary expectations':        'Negotiable',
      'compensation expectations':  'Negotiable',
    },

    // ─── FILL FORM ─────────────────────────────────────────────────────────
    // Main entry point: fills all visible form fields on the current page.
    //
    // @param {Object} config - { profile, resume, apiKey, jobTitle, company }
    // @param {boolean} autoSubmit - Submit the form after filling?
    // @returns {Promise<Object>} - { filled: number, skipped: number, needsReview: string[] }
    async fillForm(config, autoSubmit = false) {
      console.log('[AI Job Applicant] Starting form fill...');

      // Track results
      const results = {
        filled:      0,
        skipped:     0,
        needsReview: [], // Fields where AI wasn't confident enough
      };

      // ── Find all form fields on the page ────────────────────────────────
      // We look for all standard HTML form elements
      const formFields = this._findFormFields();
      console.log(`[AI Job Applicant] Found ${formFields.length} form fields`);

      // ── Process each field ───────────────────────────────────────────────
      for (const field of formFields) {
        try {
          // Get a human-readable label for this field
          const label = this._getFieldLabel(field);
          if (!label) continue; // Skip fields without labels (can't determine what they're asking)

          const labelLower = label.toLowerCase();
          console.log(`[AI Job Applicant] Processing field: "${label}"`);

          // ── Step 1: Check for profile data (instant, free) ──────────────
          const profileValue = this._getProfileValue(labelLower, config.profile);
          if (profileValue !== null) {
            await this._fillField(field, profileValue, 'profile');
            results.filled++;
            continue; // Go to next field
          }

          // ── Step 2: Check static answers (instant, free) ────────────────
          const staticValue = this._getStaticAnswer(labelLower);
          if (staticValue !== null) {
            await this._fillField(field, staticValue, 'static');
            results.filled++;
            continue;
          }

          // ── Step 3: Use OpenAI for complex/unknown fields ─────────────────
          if (config.apiKey) {
            const fieldType    = field.tagName.toLowerCase(); // "input", "select", "textarea"
            const inputType    = field.type || '';            // "text", "radio", "checkbox"
            const fieldOptions = this._getFieldOptions(field); // Options for dropdowns

            // Ask AI to determine the value
            const aiResult = await window.OpenAIUtils.analyzeFormField(
              config.apiKey,
              label,
              `${fieldType}[type=${inputType}]`,
              fieldOptions,
              config.profile,
              config.resume,
              config.jobTitle || ''
            );

            if (aiResult.value && aiResult.confidence >= 0.7) {
              // AI is confident — fill the field
              await this._fillField(field, aiResult.value, 'ai');
              results.filled++;

              if (aiResult.needsHumanReview) {
                results.needsReview.push(label);
                this._highlightField(field, 'review'); // Yellow highlight = review me
              }
            } else {
              // AI isn't confident — highlight for user to fill manually
              this._highlightField(field, 'unknown'); // Red highlight = unknown
              results.needsReview.push(label);
              results.skipped++;
            }
          } else {
            results.skipped++;
          }

          // Small delay between API calls to avoid rate limiting
          await this._sleep(300);

        } catch (fieldError) {
          console.error('[AI Job Applicant] Error filling field:', fieldError.message);
          results.skipped++;
        }
      }

      // ── Handle file upload fields (resume attachment) ───────────────────
      // Note: We can't programmatically set file inputs due to browser security.
      // We'll highlight them so the user knows to attach their resume manually.
      const fileInputs = document.querySelectorAll('input[type="file"]');
      fileInputs.forEach(fileInput => {
        this._highlightField(fileInput, 'review');
        results.needsReview.push('File upload (attach resume manually)');
      });

      // ── Handle cover letter text areas ──────────────────────────────────
      const coverLetterArea = this._findCoverLetterField();
      if (coverLetterArea && config.apiKey && config.resume) {
        try {
          const coverLetter = await window.OpenAIUtils.generateCoverLetter(
            config.apiKey,
            config.profile,
            config.resume,
            config.jobTitle   || 'Software Engineer',
            config.company    || 'the company',
            config.jobDescription || ''
          );
          if (coverLetter) {
            await this._fillField(coverLetterArea, coverLetter, 'ai');
            results.filled++;
          }
        } catch (err) {
          console.error('[AI Job Applicant] Cover letter generation failed:', err.message);
        }
      }

      console.log(`[AI Job Applicant] Form fill complete:`, results);

      // ── Auto-submit or highlight submit button ───────────────────────────
      if (autoSubmit) {
        await this._sleep(1000); // Brief pause before submitting
        const submitted = this._clickSubmitButton();
        if (!submitted) {
          console.warn('[AI Job Applicant] Could not find submit button — manual submission required');
        }
      } else {
        // Highlight the submit button in green so user can easily find it
        this._highlightSubmitButton();
      }

      return results;
    },

    // ─── FIND FORM FIELDS ──────────────────────────────────────────────────
    // Returns all visible, editable form fields on the page.
    _findFormFields() {
      // querySelectorAll() finds all elements matching a CSS selector
      // ':not([disabled])' excludes disabled fields
      // ':not([readonly])' excludes read-only fields
      // ':not([type="hidden"])' excludes hidden fields (not shown to user)
      // ':not([type="submit"])' excludes submit buttons
      const selector = `
        input:not([disabled]):not([readonly]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),
        textarea:not([disabled]):not([readonly]),
        select:not([disabled])
      `;

      const allFields = [...document.querySelectorAll(selector)];

      // Filter to only visible fields (not hidden by CSS)
      // getBoundingClientRect() returns size and position — zero size = invisible
      return allFields.filter(field => {
        const rect = field.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0; // Must have positive dimensions
      });
    },

    // ─── GET FIELD LABEL ──────────────────────────────────────────────────
    // Determines the human-readable label for a form field.
    // There are multiple ways labels can be associated with inputs in HTML.
    _getFieldLabel(field) {
      // Method 1: <label for="fieldId">Label Text</label>
      // The label's 'for' attribute matches the input's 'id'
      if (field.id) {
        const label = document.querySelector(`label[for="${field.id}"]`);
        if (label) return label.innerText.trim();
      }

      // Method 2: aria-label attribute directly on the input
      // Used by modern, accessible web apps like LinkedIn
      const ariaLabel = field.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();

      // Method 3: aria-labelledby — references another element's ID
      const labelledBy = field.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) return labelEl.innerText.trim();
      }

      // Method 4: placeholder text (not ideal but better than nothing)
      if (field.placeholder) return field.placeholder.trim();

      // Method 5: Find the closest parent that has a text node
      // Walk up the DOM tree looking for a nearby label
      let parent = field.parentElement;
      for (let i = 0; i < 5; i++) { // Check up to 5 levels up
        if (!parent) break;
        const text = parent.innerText?.trim();
        if (text && text.length < 100) { // Reasonable label length
          return text;
        }
        parent = parent.parentElement;
      }

      // Method 6: name attribute as last resort
      if (field.name) return field.name.replace(/[_-]/g, ' ').trim();

      return null; // Couldn't determine label
    },

    // ─── GET FIELD OPTIONS ────────────────────────────────────────────────
    // For <select> and radio button groups, returns the list of options
    _getFieldOptions(field) {
      if (field.tagName.toLowerCase() === 'select') {
        // Map <option> elements to their text content
        return [...field.options].map(opt => opt.text.trim()).filter(t => t);
      }
      return []; // Text inputs/textareas don't have options
    },

    // ─── GET PROFILE VALUE ────────────────────────────────────────────────
    // Checks if the field label matches a known profile field.
    // Returns the profile value if matched, null if no match.
    _getProfileValue(labelLower, profile) {
      if (!profile) return null;

      // Simple pattern matching — check if the label contains key phrases
      // The order matters: check more specific patterns first

      // Name fields
      if (labelLower.includes('first name') || labelLower === 'first')
        return profile.firstName;
      if (labelLower.includes('last name') || labelLower === 'last')
        return profile.lastName;
      if (labelLower.includes('full name') || labelLower === 'name')
        return `${profile.firstName} ${profile.lastName}`.trim();

      // Contact
      if (labelLower.includes('email'))
        return profile.email;
      if (labelLower.includes('phone') || labelLower.includes('mobile') || labelLower.includes('telephone'))
        return profile.phone;

      // Location
      if (labelLower.includes('street') || labelLower.includes('address') && !labelLower.includes('email'))
        return profile.address;
      if (labelLower === 'city' || labelLower.includes('city'))
        return profile.city || 'Charlotte';
      if (labelLower === 'state' || labelLower.includes('state'))
        return profile.state || 'NC';
      if (labelLower.includes('zip') || labelLower.includes('postal'))
        return profile.zipCode;
      if (labelLower.includes('country'))
        return 'United States';

      // Online profiles
      if (labelLower.includes('linkedin'))
        return profile.linkedin;
      if (labelLower.includes('github'))
        return profile.github;
      if (labelLower.includes('portfolio') || labelLower.includes('website') || labelLower.includes('personal site'))
        return profile.portfolio;

      return null; // No profile match
    },

    // ─── GET STATIC ANSWER ────────────────────────────────────────────────
    // Checks if the field label matches one of our static pre-defined answers
    _getStaticAnswer(labelLower) {
      for (const [pattern, answer] of Object.entries(this.STATIC_ANSWERS)) {
        if (labelLower.includes(pattern)) {
          return answer;
        }
      }
      return null;
    },

    // ─── FILL FIELD ───────────────────────────────────────────────────────
    // Sets the value of a form field, handling different field types correctly.
    // Also triggers DOM events so React/Angular/Vue apps detect the change.
    //
    // IMPORTANT: Modern JS frameworks (React, Angular) don't just read the DOM.
    // They maintain their own internal state. Simply setting element.value won't
    // trigger their state updates. We need to fire synthetic events.
    async _fillField(field, value, source) {
      if (!value) return; // Don't fill with empty value

      const tagName   = field.tagName.toLowerCase();
      const inputType = (field.type || '').toLowerCase();

      console.log(`[AI Job Applicant] Filling "${this._getFieldLabel(field)}" with "${String(value).substring(0, 50)}" (source: ${source})`);

      try {
        if (tagName === 'select') {
          // ── Dropdown <select> ──────────────────────────────────────────
          await this._fillSelectField(field, value);

        } else if (inputType === 'radio') {
          // ── Radio button group ─────────────────────────────────────────
          // Find the radio button whose label matches the value
          const name  = field.name;
          const radios = document.querySelectorAll(`input[type="radio"][name="${name}"]`);
          for (const radio of radios) {
            const radioLabel = this._getFieldLabel(radio);
            if (radioLabel && radioLabel.toLowerCase().includes(value.toLowerCase())) {
              radio.checked = true;
              this._fireEvent(radio, 'change');
              break;
            }
          }

        } else if (inputType === 'checkbox') {
          // ── Checkbox ───────────────────────────────────────────────────
          const shouldCheck = ['yes', 'true', '1', 'agree', 'i agree'].includes(String(value).toLowerCase());
          if (field.checked !== shouldCheck) {
            field.checked = shouldCheck;
            this._fireEvent(field, 'change');
            this._fireEvent(field, 'click');
          }

        } else {
          // ── Text input / Textarea ──────────────────────────────────────
          // Set the value using the native input value setter
          // This is needed for React inputs (which use a custom descriptor)
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;

          const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set;

          // Use the native setter if available, otherwise set directly
          if (tagName === 'textarea' && nativeTextareaValueSetter) {
            nativeTextareaValueSetter.call(field, value);
          } else if (nativeInputValueSetter) {
            nativeInputValueSetter.call(field, value);
          } else {
            field.value = value;
          }

          // Fire events that React/Angular/Vue listen to for state updates
          this._fireEvent(field, 'focus');
          this._fireEvent(field, 'input');
          this._fireEvent(field, 'change');
          this._fireEvent(field, 'blur');
        }

        // Add a visual "filled" indicator so user can see what was auto-filled
        this._highlightField(field, source === 'ai' ? 'ai-filled' : 'auto-filled');

      } catch (err) {
        console.error('[AI Job Applicant] Failed to fill field:', err.message);
      }
    },

    // ─── FILL SELECT FIELD ─────────────────────────────────────────────────
    // Tries multiple strategies to select the right option in a <select> element
    async _fillSelectField(selectEl, value) {
      const valueLower = String(value).toLowerCase();

      // Strategy 1: Exact text match (case-insensitive)
      for (const option of selectEl.options) {
        if (option.text.toLowerCase() === valueLower) {
          selectEl.value = option.value;
          this._fireEvent(selectEl, 'change');
          return;
        }
      }

      // Strategy 2: Partial text match (handles "Yes, I am authorized" matching "Yes")
      for (const option of selectEl.options) {
        if (option.text.toLowerCase().includes(valueLower) ||
            valueLower.includes(option.text.toLowerCase())) {
          if (option.text.toLowerCase() !== 'select' && option.value !== '') {
            selectEl.value = option.value;
            this._fireEvent(selectEl, 'change');
            return;
          }
        }
      }

      // Strategy 3: Yes/No normalization
      // Some dropdowns say "I am authorized" instead of "Yes"
      const isYes = ['yes', 'true', '1', 'agree'].includes(valueLower);
      const isNo  = ['no', 'false', '0', 'disagree'].includes(valueLower);
      for (const option of selectEl.options) {
        const optText = option.text.toLowerCase();
        if (isYes && (optText.startsWith('yes') || optText.includes('i am') || optText.includes('authorized'))) {
          selectEl.value = option.value;
          this._fireEvent(selectEl, 'change');
          return;
        }
        if (isNo && (optText.startsWith('no') || optText.includes('not') || optText.includes('i am not'))) {
          selectEl.value = option.value;
          this._fireEvent(selectEl, 'change');
          return;
        }
      }

      console.warn(`[AI Job Applicant] Could not find option matching "${value}" in select:`,
        [...selectEl.options].map(o => o.text));
    },

    // ─── FIRE DOM EVENT ───────────────────────────────────────────────────
    // Creates and dispatches a synthetic DOM event on an element.
    // This is how we "trick" React/Angular into thinking the user typed something.
    _fireEvent(element, eventName) {
      // 'bubbles: true' means the event propagates up the DOM tree
      // 'cancelable: true' means event handlers can call preventDefault()
      const event = new Event(eventName, { bubbles: true, cancelable: true });
      element.dispatchEvent(event);

      // For 'input' events, also fire an InputEvent for React compatibility
      if (eventName === 'input') {
        const inputEvent = new InputEvent('input', { bubbles: true, cancelable: true });
        element.dispatchEvent(inputEvent);
      }
    },

    // ─── HIGHLIGHT FIELD ──────────────────────────────────────────────────
    // Adds a colored border to a field to indicate its fill status
    _highlightField(field, type) {
      const colors = {
        'auto-filled': '#22c55e', // Green — filled from profile
        'ai-filled':   '#3b82f6', // Blue — filled by AI
        'review':      '#f59e0b', // Yellow — needs review
        'unknown':     '#ef4444', // Red — couldn't fill
      };
      const color = colors[type] || '#94a3b8';

      // Store the original border so we can restore it (good practice)
      if (!field.dataset.originalBorder) {
        field.dataset.originalBorder = field.style.border || '';
      }

      // Set outline instead of border to avoid affecting layout
      field.style.outline = `2px solid ${color}`;
      field.style.outlineOffset = '1px';

      // Add a small tooltip-like title attribute
      const labels = { 'auto-filled': 'Auto-filled', 'ai-filled': 'AI-filled', 'review': 'Please review', 'unknown': 'Could not fill automatically' };
      field.title = labels[type] || '';
    },

    // ─── HIGHLIGHT SUBMIT BUTTON ──────────────────────────────────────────
    // Makes the submit button more visible so the user can easily find it
    _highlightSubmitButton() {
      const submitBtn = this._findSubmitButton();
      if (submitBtn) {
        submitBtn.style.boxShadow = '0 0 0 4px #22c55e, 0 0 20px rgba(34, 197, 94, 0.4)';
        submitBtn.title = '← Click here to submit your application';
      }
    },

    // ─── CLICK SUBMIT BUTTON ─────────────────────────────────────────────
    // Automatically clicks the submit button (only when autoSubmit is enabled)
    _clickSubmitButton() {
      const submitBtn = this._findSubmitButton();
      if (submitBtn) {
        submitBtn.click();
        return true;
      }
      return false;
    },

    // ─── FIND SUBMIT BUTTON ───────────────────────────────────────────────
    // Finds the form's submit button using multiple strategies
    _findSubmitButton() {
      // Try standard submit button first
      const submitInput = document.querySelector('input[type="submit"]');
      if (submitInput) return submitInput;

      const submitBtn = document.querySelector('button[type="submit"]');
      if (submitBtn) return submitBtn;

      // Look for buttons with common submit text
      const allButtons = [...document.querySelectorAll('button, input[type="button"]')];
      const submitTexts = ['submit', 'apply', 'send application', 'submit application', 'apply now'];

      for (const btn of allButtons) {
        const text = (btn.innerText || btn.value || '').toLowerCase().trim();
        if (submitTexts.some(st => text.includes(st))) {
          return btn;
        }
      }

      return null;
    },

    // ─── FIND COVER LETTER FIELD ──────────────────────────────────────────
    // Identifies text areas that are likely asking for a cover letter
    _findCoverLetterField() {
      const textareas = [...document.querySelectorAll('textarea:not([disabled])')];

      for (const textarea of textareas) {
        const label = this._getFieldLabel(textarea)?.toLowerCase() || '';
        const placeholder = (textarea.placeholder || '').toLowerCase();

        if (label.includes('cover letter') || placeholder.includes('cover letter') ||
            label.includes('additional information') || label.includes('why are you interested')) {
          return textarea;
        }
      }
      return null;
    },

    // ─── SLEEP UTILITY ────────────────────────────────────────────────────
    // Pauses execution for a given number of milliseconds.
    // Used to space out API calls and form interactions.
    // Promises + setTimeout is the standard way to sleep in async JS code.
    _sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

  }; // end window.FormFiller

} // end namespace guard
