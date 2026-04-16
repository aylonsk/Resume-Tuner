const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

function buildCoverLetterPrompt(coverLetter, jd, paragraphs) {
  const resumeContext =
    paragraphs && paragraphs.length
      ? `\n\nRESUME CONTEXT (use only to support or fill in accurate details already implied by the cover letter -- do not invent new experience):\n${paragraphs.filter((p) => p.trim()).join("\n")}`
      : "";

  return `You are an expert cover letter writer. Adapt the cover letter below for the new job description provided.

Rules:
- Replace the target company name, role title, and any company-specific references (mission, product, team) with the equivalents from the new job description.
- Adapt the body paragraphs to highlight the candidate's most relevant experience for the new role's requirements and values.
- Do not invent experience, skills, achievements, or claims that are not present in the original cover letter or the resume context.
- Keep the same personal tone, writing style, paragraph structure, and approximate length as the original.
- Do not use em dashes anywhere in the output. Replace any em dash with a comma, semicolon, or reword the sentence.
- Return only the adapted cover letter text -- no preamble, no explanation, no JSON, no markdown formatting.${resumeContext}

ORIGINAL COVER LETTER:
${coverLetter}

NEW JOB DESCRIPTION:
${jd}`.trim();
}

function buildPrompt(paragraphs, jd) {
  const numberedList = paragraphs.map((p, i) => `${i}: ${p}`).join("\n");

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
- Keep replacements concise — match the length and style of the original line.

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

  const { paragraphs, coverLetter, jd } = parsed;

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

  // ── Cover letter path ──────────────────────────────────────────────────────
  if (coverLetter) {
    try {
      const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          messages: [
            { role: "user", content: buildCoverLetterPrompt(coverLetter, jd, paragraphs) }
          ]
        })
      });

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
      return {
        statusCode: 500,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: err.message || "Unexpected server error." })
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
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: buildPrompt(paragraphs, jd) }]
      })
    });

    const data = await anthropicResponse.json();

    if (!anthropicResponse.ok) {
      const message = data?.error?.message || "Anthropic request failed.";
      return {
        statusCode: anthropicResponse.status,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: message })
      };
    }

    // #region agent log - debug 811f4c
    const stopReason = data?.stop_reason;
    console.log("[debug-811f4c] stop_reason:", stopReason, "| content blocks:", data?.content?.length);
    // #endregion

    const rawContent = data?.content?.[0]?.text;

    // #region agent log - debug 811f4c
    console.log("[debug-811f4c] rawContent first 300 chars:", rawContent ? rawContent.slice(0, 300) : "EMPTY");
    // #endregion

    if (!rawContent) {
      return {
        statusCode: 502,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Anthropic returned an empty response.", debug_stop_reason: stopReason })
      };
    }

    // Strip markdown code fences that Claude adds around JSON output
    let cleaned = rawContent.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "");
    }

    // #region agent log - debug 811f4c
    console.log("[debug-811f4c] post-fix: cleaned first 100 chars:", cleaned.slice(0, 100));
    // #endregion

    let result;
    try {
      result = JSON.parse(cleaned);
      // #region agent log - debug 811f4c
      console.log("[debug-811f4c] post-fix: JSON.parse succeeded, changes count:", result?.changes?.length);
      // #endregion
    } catch {
      // #region agent log - debug 811f4c
      console.log("[debug-811f4c] post-fix: JSON.parse still failed. cleaned[:500]:", cleaned.slice(0, 500));
      // #endregion
      return {
        statusCode: 502,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Anthropic returned malformed JSON. Try again.",
          debug_stop_reason: stopReason,
          debug_raw_prefix: rawContent.slice(0, 500),
          debug_raw_suffix: rawContent.slice(-200)
        })
      };
    }

    const changes = Array.isArray(result.changes) ? result.changes : [];
    const summary = typeof result.summary === "string" ? result.summary : "";

    return {
      statusCode: 200,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ changes, summary })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Unexpected server error." })
    };
  }
};
