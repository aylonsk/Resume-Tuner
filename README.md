# ATS Resume Tailor

## Overview
ATS Resume Tailor is a small frontend plus serverless backend for comparing a resume against a job description and generating targeted edits instead of generic rewrites.

## Features
- Cleaner single-page frontend
- Resume stored locally in the browser
- Configurable backend endpoint stored in local storage
- Serverless backend with environment-based OpenAI key
- Basic validation and error handling on both frontend and backend

## Project Structure

```text
.
|-- index.html
|-- netlify.toml
|-- netlify/
|   `-- functions/
|       `-- analyze.js
|-- api/
|   `-- analyze.js
|-- .env.example
`-- README.md
```

## Local and Deployment Setup

### Frontend
- Deploy `index.html` to GitHub Pages (static hosting).
- In the app, set **Backend Endpoint** to your Netlify function URL, for example: `https://YOUR_SITE.netlify.app/.netlify/functions/analyze`.

### Backend (Netlify)
- Import this GitHub repo as a new Netlify site. On the build settings screen, use:
  - **Base directory:** leave empty
  - **Build command:** leave empty (static site; `netlify.toml` sets publish and functions)
  - **Publish directory:** `.` (a single dot)
  - **Functions directory:** `netlify/functions` (default)
- After deploy, your analyze endpoint is: `https://YOUR_SITE.netlify.app/.netlify/functions/analyze`.
- In Netlify: **Site configuration → Environment variables**, add:
  - `OPENAI_API_KEY`
  - `ALLOWED_ORIGIN` (your GitHub Pages origin, e.g. `https://YOUR_USERNAME.github.io`)

### Backend (Vercel, optional)
- `api/analyze.js` is a Vercel-style handler if you prefer Vercel instead of Netlify.

### Environment File
- Copy `.env.example` to `.env` if your platform supports local environment files.
- Never commit your real `.env` file.

## Usage
1. Enter or confirm your backend endpoint.
2. Paste your resume and save it locally if you want to reuse it.
3. Paste a job description.
4. Click `Analyze and Tailor`.

## What You Still Need To Do
1. Rotate the OpenAI API key if it was ever exposed in the frontend.
2. Deploy this repo on Netlify with the settings above; use `netlify/functions/analyze.js` (not GitHub Pages for the API).
3. Add `OPENAI_API_KEY` and `ALLOWED_ORIGIN` in Netlify environment variables.
4. Deploy the frontend to GitHub Pages (or use Netlify for the static site too).
5. In the app, set **Backend Endpoint** to `https://YOUR_SITE.netlify.app/.netlify/functions/analyze`.

## Notes
- Resume content is stored only in browser local storage unless you add persistence yourself.
- The backend returns markdown, and the frontend renders it into the output panel.
- If you use separate frontend and backend domains, make sure `ALLOWED_ORIGIN` matches your frontend URL.