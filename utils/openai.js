// ═══════════════════════════════════════════════════════════════════════════════
// FILE: utils/openai.js
// PURPOSE: Wrapper around the OpenAI Chat Completions API.
//          Provides two main capabilities:
//            1. analyzeJobMatch()  → Score how well a job fits your resume (0-100)
//            2. analyzeFormField() → Determine what value to enter in a form field
//
// HOW THE OPENAI API WORKS:
//   You send a POST request to https://api.openai.com/v1/chat/completions
//   with a list of "messages" (like a conversation), and the AI responds.
//   Each message has a "role" (system, user, or assistant) and "content".
//   - "system" role = instructions to the AI (its personality/task)
//   - "user"   role = what you're asking (like typing in ChatGPT)
//   - "assistant" role = previous AI replies (for multi-turn conversations)
//
//   We use GPT-4o (the fast, capable model) with JSON mode to get
//   structured, machine-readable responses instead of plain text.
// ═══════════════════════════════════════════════════════════════════════════════

if (typeof window.OpenAIUtils === 'undefined') {

  window.OpenAIUtils = {

    // ─── OPENAI API ENDPOINT ─────────────────────────────────────────────────
    // This is the URL we POST requests to. It never changes.
    API_URL: 'https://api.openai.com/v1/chat/completions',

    // ─── MODEL SELECTION ─────────────────────────────────────────────────────
    // GPT-4o balances speed, cost, and capability well for this task.
    // gpt-4o-mini is cheaper but less accurate for form analysis.
    MODEL: 'gpt-4o',

    // ─── CORE API CALL ───────────────────────────────────────────────────────
    // Makes a raw call to the OpenAI Chat Completions API.
    // This is a private-ish helper — other methods call this internally.
    //
    // @param {string}   apiKey   - Your OpenAI API secret key (sk-...)
    // @param {Array}    messages - Array of {role, content} message objects
    // @param {boolean}  jsonMode - If true, forces the AI to respond in JSON format
    // @returns {Promise<string>} - The AI's response text
    async _callAPI(apiKey, messages, jsonMode = false) {
      // ── Build the request body ──────────────────────────────────────────
      const requestBody = {
        model: this.MODEL,           // Which AI model to use
        messages: messages,          // The conversation history / prompt
        max_tokens: 1000,            // Maximum response length (1000 tokens ≈ 750 words)
        temperature: 0.1,            // Low temperature = more focused/deterministic output
                                     // 0.0 = fully deterministic, 1.0 = very creative
      };

      // If we want JSON output, add the response_format parameter.
      // JSON mode guarantees the response will be valid JSON — no extra text.
      if (jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      // ── Make the HTTP request ───────────────────────────────────────────
      // fetch() is the modern way to make HTTP requests in the browser.
      // We use async/await so we don't need nested callbacks.
      let response;
      try {
        response = await fetch(this.API_URL, {
          method: 'POST',
          headers: {
            // Content-Type tells the server we're sending JSON
            'Content-Type': 'application/json',
            // Authorization header carries your API key.
            // "Bearer" is the auth scheme OpenAI uses.
            // ⚠️ This key is NEVER sent anywhere except api.openai.com
            'Authorization': `Bearer ${apiKey}`,
          },
          // JSON.stringify() converts our JS object to a JSON string for the request body
          body: JSON.stringify(requestBody),
        });
      } catch (networkError) {
        // fetch() itself throws if there's no internet connection
        throw new Error(`Network error calling OpenAI: ${networkError.message}`);
      }

      // ── Handle HTTP errors ──────────────────────────────────────────────
      // response.ok is true for 2xx status codes (200-299)
      if (!response.ok) {
        const errorBody = await response.text(); // Read error message from response
        if (response.status === 401) {
          // 401 = Unauthorized — the API key is wrong or expired
          throw new Error('OpenAI API key is invalid. Please check your settings.');
        } else if (response.status === 429) {
          // 429 = Too Many Requests — you've hit OpenAI's rate limit
          throw new Error('OpenAI rate limit reached. The extension will wait before retrying.');
        } else if (response.status === 402) {
          // 402 = Payment Required — your OpenAI account has no credits
          throw new Error('OpenAI account has no credits. Please add credits at platform.openai.com');
        }
        throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
      }

      // ── Parse the response ──────────────────────────────────────────────
      // response.json() parses the JSON response body into a JS object
      const data = await response.json();

      // The response structure from OpenAI looks like:
      // {
      //   choices: [
      //     { message: { role: "assistant", content: "..." } }
      //   ],
      //   usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      // }
      // We extract the text content from the first (and usually only) choice.
      return data.choices[0].message.content;
    },

    // ─── JOB MATCH ANALYSIS ──────────────────────────────────────────────────
    // Compares a job description to the user's resume and returns a match score.
    //
    // @param {string} apiKey         - OpenAI API key
    // @param {string} resumeText     - The user's resume (plain text)
    // @param {string} jobTitle       - The job's title
    // @param {string} jobDescription - The full job posting text
    // @param {string} company        - Company name
    // @returns {Promise<Object>} - { score: 75, reasons: [...], missingSkills: [...], shouldApply: true }
    async analyzeJobMatch(apiKey, resumeText, jobTitle, jobDescription, company) {
      // ── System message ──────────────────────────────────────────────────
      // The system message sets the AI's role and behavior.
      // Think of it as the "instructions" you give a new employee.
      const systemMessage = {
        role: 'system',
        content: `You are an expert technical recruiter and career coach.
Your job is to analyze how well a candidate's resume matches a job posting.
Be realistic but not overly critical. Focus on transferable skills.
Always respond with valid JSON only — no extra text before or after the JSON.`
      };

      // ── User message ────────────────────────────────────────────────────
      // This is the actual question we're asking the AI.
      const userMessage = {
        role: 'user',
        content: `
Analyze how well this candidate's resume matches the job posting below.

=== RESUME ===
${resumeText}

=== JOB POSTING ===
Company: ${company}
Title: ${jobTitle}
Description: ${jobDescription}

=== YOUR TASK ===
Respond with a JSON object in exactly this format:
{
  "score": <number 0-100 representing match percentage>,
  "shouldApply": <true if score >= 60, false otherwise>,
  "matchReasons": [<list of 3-5 specific reasons this candidate is a good match>],
  "missingSkills": [<list of key skills from the job that the resume lacks, or empty array>],
  "coverLetterHint": "<one sentence about what to emphasize in a cover letter>",
  "estimatedSalary": "<salary range if you can infer it from the job post, or null>",
  "isRemote": <true/false/null if not specified>,
  "seniorityLevel": "<entry/mid/senior/lead/principal or null>"
}
`
      };

      try {
        // Call the API with JSON mode = true (guarantees JSON response)
        const responseText = await this._callAPI(apiKey, [systemMessage, userMessage], true);

        // Parse the JSON string into a JavaScript object
        const result = JSON.parse(responseText);

        // Validate that we got a score (defensive programming)
        if (typeof result.score !== 'number') {
          throw new Error('AI returned unexpected format');
        }

        return result;

      } catch (error) {
        // If AI analysis fails, log the error but return a safe default
        // This prevents one failed API call from stopping the whole automation
        console.error('[AI Job Applicant] Job match analysis failed:', error.message);
        return {
          score: 0,
          shouldApply: false,
          matchReasons: [],
          missingSkills: [],
          coverLetterHint: '',
          estimatedSalary: null,
          isRemote: null,
          seniorityLevel: null,
          error: error.message  // Include error so we can log it
        };
      }
    },

    // ─── FORM FIELD ANALYSIS ─────────────────────────────────────────────────
    // Given a form field's label and context, determines what value to fill in
    // based on the user's profile and resume.
    //
    // @param {string} apiKey       - OpenAI API key
    // @param {string} fieldLabel   - The label text next to the field (e.g., "Years of Experience")
    // @param {string} fieldType    - HTML input type ("text", "select", "radio", "checkbox")
    // @param {Array}  fieldOptions - For dropdowns/radio: list of option values to choose from
    // @param {Object} userProfile  - The user's profile data (name, email, etc.)
    // @param {string} resumeText   - User's resume for context
    // @param {string} jobTitle     - The job being applied to (for context)
    // @returns {Promise<Object>} - { value: "...", confidence: 0.9 }
    async analyzeFormField(apiKey, fieldLabel, fieldType, fieldOptions, userProfile, resumeText, jobTitle) {

      const systemMessage = {
        role: 'system',
        content: `You are an expert at filling out job application forms accurately and professionally.
Given a form field label and the user's profile, determine the best value to enter.
Always respond with valid JSON only.
Be conservative and honest — never make up credentials the user doesn't have.`
      };

      // Format the options list nicely for the prompt (if it's a dropdown/radio)
      const optionsText = fieldOptions && fieldOptions.length > 0
        ? `Available options: ${fieldOptions.map(o => `"${o}"`).join(', ')}`
        : 'This is a free-text field (type your answer)';

      const userMessage = {
        role: 'user',
        content: `
Fill in this job application form field for the candidate.

=== CANDIDATE PROFILE ===
Name: ${userProfile.firstName} ${userProfile.lastName}
Email: ${userProfile.email}
Phone: ${userProfile.phone}
Location: ${userProfile.city}, ${userProfile.state}
Work Authorization: ${userProfile.citizenStatus}
Veteran: ${userProfile.veteranStatus}
Disability: ${userProfile.disabilityStatus}
Needs Sponsorship: ${userProfile.requireSponsorship ? 'Yes' : 'No'}

=== RESUME SUMMARY ===
${resumeText ? resumeText.substring(0, 2000) : 'Not provided'}

=== JOB BEING APPLIED TO ===
${jobTitle}

=== FORM FIELD ===
Label: "${fieldLabel}"
Field Type: ${fieldType}
${optionsText}

=== YOUR TASK ===
Respond with JSON in exactly this format:
{
  "value": "<the value to enter or select>",
  "confidence": <0.0 to 1.0 — how confident you are this is correct>,
  "reasoning": "<brief explanation of why you chose this value>",
  "needsHumanReview": <true if this field needs human judgment>
}

Rules:
- For yes/no veteran questions: always answer "No" (user is not a veteran)
- For disability questions: always answer "I don't wish to answer" or "No"
- For work authorization: always answer "Yes" (user is a US Citizen)
- For sponsorship: always answer "No" (user does not need sponsorship)
- For salary: if you're unsure, suggest a range based on the job level and Charlotte, NC market
- If the field is ambiguous, set needsHumanReview: true
`
      };

      try {
        const responseText = await this._callAPI(apiKey, [systemMessage, userMessage], true);
        return JSON.parse(responseText);
      } catch (error) {
        console.error('[AI Job Applicant] Form field analysis failed:', error.message);
        // Return empty value with human review flag — the user will need to fill this manually
        return {
          value: '',
          confidence: 0,
          reasoning: `Analysis failed: ${error.message}`,
          needsHumanReview: true
        };
      }
    },

    // ─── GENERATE COVER LETTER ────────────────────────────────────────────────
    // Generates a short, personalized cover letter for a specific job.
    //
    // @param {string} apiKey         - OpenAI API key
    // @param {Object} userProfile    - User's profile
    // @param {string} resumeText     - User's resume
    // @param {string} jobTitle       - Job title
    // @param {string} company        - Company name
    // @param {string} jobDescription - Job description
    // @returns {Promise<string>} - The cover letter text
    async generateCoverLetter(apiKey, userProfile, resumeText, jobTitle, company, jobDescription) {

      const systemMessage = {
        role: 'system',
        content: `You are a professional career counselor who writes concise, compelling cover letters.
Write in a confident, professional tone. Keep it to 3 paragraphs maximum.
Do not use generic filler phrases like "I am writing to express my interest."
Be specific about the company and role.`
      };

      const userMessage = {
        role: 'user',
        content: `
Write a cover letter for this candidate applying to this job.

=== CANDIDATE ===
Name: ${userProfile.firstName} ${userProfile.lastName}
Location: Charlotte, NC
Email: ${userProfile.email}

=== RESUME ===
${resumeText ? resumeText.substring(0, 3000) : 'Not provided'}

=== JOB ===
Company: ${company}
Title: ${jobTitle}
Description: ${jobDescription ? jobDescription.substring(0, 1500) : 'Not provided'}

Write a 3-paragraph cover letter (250-350 words total).
Paragraph 1: Strong opening that references the specific role and company.
Paragraph 2: 2-3 specific accomplishments from the resume that match the job requirements.
Paragraph 3: Brief closing with enthusiasm and call to action.
Do not include "Dear Hiring Manager," or any salutation — just the body paragraphs.
`
      };

      try {
        // No JSON mode — we want a plain text cover letter
        const coverLetter = await this._callAPI(apiKey, [systemMessage, userMessage], false);
        return coverLetter.trim();
      } catch (error) {
        console.error('[AI Job Applicant] Cover letter generation failed:', error.message);
        return ''; // Return empty string — the user can write their own
      }
    },

  }; // end window.OpenAIUtils

} // end namespace guard
