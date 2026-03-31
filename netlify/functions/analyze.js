const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

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

  const { paragraphs, jd } = parsed;

  if (!paragraphs || !Array.isArray(paragraphs) || paragraphs.length === 0) {
    return {
      statusCode: 400,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "paragraphs (array) and jd are required." })
    };
  }

  if (!jd) {
    return {
      statusCode: 400,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "jd is required." })
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing OPENAI_API_KEY on the server." })
    };
  }

  try {
    const openAiResponse = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildPrompt(paragraphs, jd) }]
      })
    });

    const data = await openAiResponse.json();

    if (!openAiResponse.ok) {
      const message = data?.error?.message || "OpenAI request failed.";
      return {
        statusCode: openAiResponse.status,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: message })
      };
    }

    const rawContent = data?.choices?.[0]?.message?.content;

    if (!rawContent) {
      return {
        statusCode: 502,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "OpenAI returned an empty response." })
      };
    }

    let result;
    try {
      result = JSON.parse(rawContent);
    } catch {
      return {
        statusCode: 502,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "OpenAI returned malformed JSON. Try again." })
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
