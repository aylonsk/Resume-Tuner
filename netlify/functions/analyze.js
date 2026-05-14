const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

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

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed. Use POST." })
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body." })
    };
  }

  const { paragraphs, coverLetter, jd, instructions } = parsed;

  if (!jd) {
    return {
      statusCode: 400,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "jd is required." })
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing ANTHROPIC_API_KEY on the server." })
    };
  }

  // Abort Anthropic requests that exceed 24 s (safely under Netlify's function timeout limit)
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 24000);

  // ── Cover letter path ──────────────────────────────────────────────────────
  if (coverLetter) {
    try {
      const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          messages: [
            { role: "user", content: buildCoverLetterPrompt(coverLetter, jd, paragraphs, instructions) }
          ]
        })
      });

      clearTimeout(abortTimer);
      const data = await anthropicResponse.json();

      if (!anthropicResponse.ok) {
        const message = data?.error?.message || "Anthropic request failed.";
        return {
          statusCode: anthropicResponse.status,
          headers: { ...baseHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: message })
        };
      }

      const adaptedLetter = data?.content?.[0]?.text;

      if (!adaptedLetter) {
        return {
          statusCode: 502,
          headers: { ...baseHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Anthropic returned an empty response." })
        };
      }

      return {
        statusCode: 200,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ adaptedLetter: adaptedLetter.trim() })
      };
    } catch (err) {
      clearTimeout(abortTimer);
      const isTimeout = err.name === "AbortError";
      return {
        statusCode: isTimeout ? 504 : 500,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: isTimeout ? "The AI took too long to respond. Please try again." : (err.message || "Unexpected server error.") })
      };
    }
  }

  // ── Resume tailoring path ─────────────────────────────────────────────────
  if (!paragraphs || !Array.isArray(paragraphs) || paragraphs.length === 0) {
    return {
      statusCode: 400,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Either coverLetter or paragraphs (array) is required." })
    };
  }

  try {
    const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: buildPrompt(paragraphs, jd, instructions) }]
      })
    });

    clearTimeout(abortTimer);
    const data = await anthropicResponse.json();

    if (!anthropicResponse.ok) {
      const message = data?.error?.message || "Anthropic request failed.";
      return {
        statusCode: anthropicResponse.status,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: message })
      };
    }

    const rawContent = data?.content?.[0]?.text;

    if (!rawContent) {
      return {
        statusCode: 502,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Anthropic returned an empty response." })
      };
    }

    // Strip markdown code fences that Claude adds around JSON output
    let cleaned = rawContent.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "");
    }

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return {
        statusCode: 502,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Anthropic returned malformed JSON. Try again." })
      };
    }

    const rawChanges = Array.isArray(result.changes) ? result.changes : [];
    let summary = typeof result.summary === "string" ? result.summary : "";

    // Enforce the one-page constraint deterministically: drop any replacement
    // longer than its original, since extra characters can push the resume to
    // a second page.
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

    return {
      statusCode: 200,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ changes, summary })
    };
  } catch (err) {
    clearTimeout(abortTimer);
    const isTimeout = err.name === "AbortError";
    return {
      statusCode: isTimeout ? 504 : 500,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: isTimeout ? "The AI took too long to respond. Please try again." : (err.message || "Unexpected server error.") })
    };
  }
};
