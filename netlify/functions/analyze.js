const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

function buildPrompt(resume, jd) {
  return `
You are an expert resume optimizer.

STEP 1: Extract the most important skills, tools, and keywords from the job description.
STEP 2: Compare those requirements against the resume.
STEP 3: Identify meaningful gaps or missing keywords.
STEP 4: Rewrite only the specific bullet points or lines that need improvement.

Rules:
- Do not rewrite the entire resume
- Keep the candidate's tone and experience level realistic
- Add metrics only when they are implied or already supported by the resume
- Avoid keyword stuffing
- Keep suggestions concise and usable

Return the response in markdown with these sections:
1. Missing Keywords
2. Suggested Bullet Edits
3. Improved Resume Section

RESUME:
${resume}

JOB DESCRIPTION:
${jd}
`.trim();
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

  const { resume, jd } = parsed;

  if (!resume || !jd) {
    return {
      statusCode: 400,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Both resume and jd are required." })
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
        messages: [{ role: "user", content: buildPrompt(resume, jd) }]
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

    const result = data?.choices?.[0]?.message?.content;

    if (!result) {
      return {
        statusCode: 502,
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "OpenAI returned an empty response." })
      };
    }

    return {
      statusCode: 200,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ result })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Unexpected server error." })
    };
  }
};
