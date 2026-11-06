# Case Companion — US re-skin

A Clocked Build Challenge entry (entries close Tue Nov 10, 2026, 11:59 PM ET).

A bank recovery officer opens a thick case file the night before a hearing.
Case Companion turns it into a **one-page hearing brief in seconds**. Every
date, amount, and order carries its source document. Missing documents are
flagged as missing — never filled in by invention. Procedural preparation
only: it prepares the officer; it does not argue the case or give legal advice.

- **Stack:** React + Vite + TypeScript + Tailwind, on Vercel. No database.
  Nothing submitted is stored.
- **Synthetic case only — no real borrower, bank, or case.**
- **Procedural preparation only — not legal advice.**

## Layout

| Path | What |
|------|------|
| `synthetic-case/` | The 4 plain-text demo documents (single source of truth) |
| `py/` | Python Clocked test: Extract → Decide → Fill + expected-value checks |
| `src/` | React app (one page, mobile-first) |
| `api/clocked.ts` | Serverless Clocked proxy — the key never reaches the browser |

> Package note: the Clocked SDKs are `clocked-sdk` on both PyPI and npm.
> `clocked` on either registry is a different, unrelated package.

## Run locally

```powershell
npm install
Copy-Item .env.local.example .env.local   # then add your CLOCKED_API_KEY
npm run dev                                # open the printed http://127.0.0.1:517x/ URL
```

Press **Load demo case**. The app runs Protect → Extract → Decide → Fill →
Verify → Compare → Rerank and renders the brief. No mocks: without a key the
pipeline reports the missing key instead of inventing results.

## Python test

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r py\requirements.txt
Copy-Item py\.env.example py\.env   # then add your CLOCKED_API_KEY
.\.venv\Scripts\python.exe py\test_clocked.py
```

Prints the full JSON of the Extract, Decide, and Fill calls and checks all 15
Extract values against the known synthetic facts (exit non-zero on mismatch).

## Deploy to Vercel

```powershell
npm i -g vercel
vercel login
vercel            # preview
vercel --prod     # production
```

Then add `CLOCKED_API_KEY` in the Vercel dashboard
(Project → Settings → Environment Variables) and redeploy. The Vite build and
the `api/` function are auto-detected; no `vercel.json` needed.

## What it does NOT do

No portfolio view, handover mode, multi-case upload, user accounts, real
PDF/photo OCR, or Guard / Inspect — deliberately out of scope.
