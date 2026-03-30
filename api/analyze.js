const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

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

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const { resume, jd } = req.body || {};

  if (!resume || !jd) {
    return res.status(400).json({ error: "Both resume and jd are required." });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY on the server." });
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
        messages: [
          {
            role: "user",
            content: buildPrompt(resume, jd)
          }
        ]
      })
    });

    const data = await openAiResponse.json();

    if (!openAiResponse.ok) {
      const message = data?.error?.message || "OpenAI request failed.";
      return res.status(openAiResponse.status).json({ error: message });
    }

    const result = data?.choices?.[0]?.message?.content;

    if (!result) {
      return res.status(502).json({ error: "OpenAI returned an empty response." });
    }

    return res.status(200).json({ result });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Unexpected server error."
    });
  }
}
