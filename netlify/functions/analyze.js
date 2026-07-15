const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Model registry. The frontend sends a short key ("haiku" / "sonnet"); the real
// model IDs and per-model request options live here so the client can never
// select an arbitrary (or expensive) model.
//
// - Haiku 4.5 is the default: fast and cheap, so a full response comfortably
//   finishes inside Netlify's 10 s free-tier function limit.
// - Sonnet 5 is the higher-quality option. It runs adaptive thinking by
//   default, which would routinely exceed 10 s, so we disable thinking to keep
//   it fast while still getting Sonnet-tier output quality.
const MODELS = {
  haiku:  { id: "claude-haiku-4-5", options: {} },
  sonnet: { id: "claude-sonnet-5",  options: { thinking: { type: "disabled" } } }
};
const DEFAULT_MODEL_KEY = "haiku";

// Overall time budget for the Anthropic call(s). Netlify's free tier hard-kills
// the function at 10 s, so we abort ourselves at 9 s and return a clean error
// instead of an opaque 502.
const DEADLINE_MS = 9000;

// Anthropic statuses worth a retry: rate limit (429), overloaded (529), and
// transient server errors. 529 in particular is a common cause of the
// "fails then works on a rerun" behavior.
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 529]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveModel(key) {
  return MODELS[key] || MODELS[DEFAULT_MODEL_KEY];
}

function extractText(data) {
  if (!data || !Array.isArray(data.content)) return "";
  const block = data.content.find((b) => b && b.type === "text" && typeof b.text === "string");
  return block ? block.text : "";
}

// Call Anthropic with a shared deadline and a single retry on transient errors.
// Each attempt's AbortController is scoped to the *remaining* budget, so the
// total wall-clock never exceeds deadlineMs — no attempt can overrun the
// platform timeout. Returns { ok, data } on success or { ok:false, status,
// message } on failure.
async function callAnthropic({ apiKey, model, maxTokens, prompt, deadlineMs }) {
  const start = Date.now();
  let attempt = 0;
  let lastErr = null;

  while (true) {
    attempt += 1;
    const remaining = deadlineMs - (Date.now() - start);
    // Don't start an attempt we can't reasonably finish.
    if (remaining <= 1500) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: model.id,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
          ...model.options
        })
      });
      clearTimeout(timer);

      if (response.ok) {
        return { ok: true, data: await response.json() };
      }

      let errBody = null;
      try { errBody = await response.json(); } catch { /* non-JSON error body */ }
      const message = errBody?.error?.message || `Anthropic request failed (${response.status}).`;

      if (RETRYABLE_STATUSES.has(response.status)) {
        lastErr = { status: response.status, message };
        const backoff = Math.min(400 * attempt, 1200);
        if (deadlineMs - (Date.now() - start) > backoff + 1500) {
          await sleep(backoff);
          continue;
        }
        break;
      }

      // Non-retryable (400/401/403/413…) — surface immediately.
      return { ok: false, status: response.status, message };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        // Out of time — a retry can't help within the budget.
        return { ok: false, status: 504, message: "The AI took too long to respond. Please try again." };
      }
      // Network-level failure — retry if the budget allows.
      lastErr = { status: 502, message: err.message || "Network error contacting the AI." };
      const backoff = Math.min(400 * attempt, 1200);
      if (deadlineMs - (Date.now() - start) > backoff + 1500) {
        await sleep(backoff);
        continue;
      }
      break;
    }
  }

  return {
    ok: false,
    status: lastErr?.status || 504,
    message: lastErr?.message || "The AI was temporarily unavailable. Please try again."
  };
}

function buildCoverLetterPrompt(coverLetter, jd, paragraphs, instructions) {
  const resumeContext =
    paragraphs && paragraphs.length
      ? `\n\nRESUME CONTEXT (use only to support or fill in accurate details already implied by the cover letter -- do not invent new experience):\n${paragraphs.filter((p) => p.trim()).join("\n")}`
      : "";

  const extraInstructions =
    instructions
      ? `\n\nADDITIONAL INSTRUCTIONS (take these into account alongside the rules above):\n${instructions}`
      : "";

  return `You are an expert cover letter writer. Adapt the cover letter below for the new job description provided.

Rules:
- Replace the target company name, role title, and any company-specific references (mission, product, team) with the equivalents from the new job description.
- Adapt the body paragraphs to highlight the candidate's most relevant experience for the new role's requirements and values.
- Do not invent experience, skills, achievements, or claims that are not present in the original cover letter or the resume context.
- Keep the same personal tone, writing style, paragraph structure, and approximate length as the original.
- Do not use em dashes anywhere in the output. Replace any em dash with a comma, semicolon, or reword the sentence.
- Return only the adapted cover letter text -- no preamble, no explanation, no JSON, no markdown formatting.${resumeContext}${extraInstructions}

ORIGINAL COVER LETTER:
${coverLetter}

NEW JOB DESCRIPTION:
${jd}`.trim();
}

function buildPrompt(paragraphs, jd, instructions) {
  const numberedList = paragraphs.map((p, i) => `${i}: ${p}`).join("\n");

  const extraInstructions =
    instructions
      ? `\n\nADDITIONAL INSTRUCTIONS (take these into account alongside the rules above):\n${instructions}`
      : "";

  return `You are an expert resume optimizer. Analyze the numbered resume paragraphs below against the job description, then return a JSON object identifying targeted improvements.

RESUME PARAGRAPHS (0-indexed):
${numberedList}

JOB DESCRIPTION:
${jd}

Rules:
- Only change bullet points and summary lines — never change contact info, section headings, company names, job titles, or date ranges.
- Keep all replacements realistic and grounded in what the resume already states.
- Add metrics only when clearly implied by existing content.
- Avoid keyword stuffing. Make every change purposeful.

ONE-PAGE CONSTRAINT (critical):
- The original resume is laid out to fit on exactly one page. Your edits must preserve that.
- Each "replacement" string MUST be no longer than its "original" string in character count. Equal or shorter only — never longer.
- This is a hard rule, not a guideline. Even a few extra characters can push a bullet onto a new line and overflow the page.
- If your best rewrite would be longer than the original, either (a) tighten it until it fits within the original character budget, or (b) skip that change entirely. Do not return a longer replacement under any circumstances.
- Prefer shorter, sharper phrasing. Cutting filler words is encouraged.${extraInstructions}

Return ONLY a JSON object with exactly these two fields:
{
  "summary": "2–3 sentence plain-English description of what was changed and why.",
  "changes": [
    { "index": <integer>, "original": "<exact original text>", "replacement": "<improved text>" }
  ]
}

If no changes are needed, return an empty changes array. Do not include any text outside the JSON object.`.trim();
}

function corsHeaders() {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

exports.handler = async (event) => {
  const baseHeaders = corsHeaders();
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  });

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed. Use POST." });
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const { paragraphs, coverLetter, jd, instructions, model: modelKey } = parsed;

  if (!jd) {
    return json(400, { error: "jd is required." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: "Missing ANTHROPIC_API_KEY on the server." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = resolveModel(modelKey);

  // ── Cover letter path ──────────────────────────────────────────────────────
  if (coverLetter) {
    const result = await callAnthropic({
      apiKey,
      model,
      maxTokens: 4096,
      deadlineMs: DEADLINE_MS,
      prompt: buildCoverLetterPrompt(coverLetter, jd, paragraphs, instructions)
    });

    if (!result.ok) {
      return json(result.status || 502, { error: result.message });
    }

    const adaptedLetter = extractText(result.data);
    if (!adaptedLetter) {
      return json(502, { error: "The AI returned an empty response. Please try again." });
    }

    return json(200, { adaptedLetter: adaptedLetter.trim() });
  }

  // ── Resume tailoring path ─────────────────────────────────────────────────
  if (!paragraphs || !Array.isArray(paragraphs) || paragraphs.length === 0) {
    return json(400, { error: "Either coverLetter or paragraphs (array) is required." });
  }

  const result = await callAnthropic({
    apiKey,
    model,
    maxTokens: 4096,
    deadlineMs: DEADLINE_MS,
    prompt: buildPrompt(paragraphs, jd, instructions)
  });

  if (!result.ok) {
    return json(result.status || 502, { error: result.message });
  }

  const rawContent = extractText(result.data);
  if (!rawContent) {
    return json(502, { error: "The AI returned an empty response. Please try again." });
  }

  // Strip markdown code fences that the model sometimes adds around JSON output.
  let cleaned = rawContent.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "");
  }

  let resultJson;
  try {
    resultJson = JSON.parse(cleaned);
  } catch {
    return json(502, { error: "The AI returned malformed JSON. Try again." });
  }

  const rawChanges = Array.isArray(resultJson.changes) ? resultJson.changes : [];
  let summary = typeof resultJson.summary === "string" ? resultJson.summary : "";

  // Enforce the one-page constraint deterministically: drop any replacement
  // longer than its original, since extra characters can push the resume to a
  // second page.
  const changes = [];
  let droppedForLength = 0;
  for (const change of rawChanges) {
    const original = typeof change?.original === "string" ? change.original : "";
    const replacement = typeof change?.replacement === "string" ? change.replacement : "";
    if (replacement.length > original.length) {
      droppedForLength += 1;
      continue;
    }
    changes.push(change);
  }
  if (droppedForLength > 0) {
    const note = `Filtered ${droppedForLength} suggested change(s) that would have exceeded the one-page limit.`;
    summary = summary ? `${summary} ${note}` : note;
  }

  return json(200, { changes, summary });
};
