# RACHI

A job application tracker that keeps itself current. RACHI reads your Gmail inbox, recognizes application confirmations, interview invites and rejections, and updates your application log automatically.

**Stack:** TypeScript, Fastify, SQLite (better-sqlite3), Gmail API (`googleapis`), Vitest.

## How it works

Every 15 minutes the poller runs this loop:

1. **Fetch.** `users.messages.list` with `newer_than:Nd`, then `users.messages.get` for each message.
2. **Classify.** Rule-based scoring: confirmation, rejection, interview, status, or noise. Mail from known ATS domains is job-related by definition.
3. **Parse.** One small parser per ATS (Ashby, Greenhouse, Lever, iCIMS, Workday) returns `{company, role, location, source}` or `null`.
4. **Dedup.** Company names are normalized (`Greenhouse Software, Inc.` and `greenhouse` match). A match updates the existing row; no match on a confirmation creates one.
5. **Review queue.** Job-related mail that no parser understood is stored, never dropped.

Every Gmail message ID is recorded in `processed_messages`, so re-polling is idempotent. `applications.gmail_message_id` is `UNIQUE` as a second layer against duplicates.

## Auth and privacy

OAuth 2.0 with the `gmail.readonly` scope. The app can read mail but cannot send, modify or delete it. Tokens live in `token.json` on your machine (git-ignored) and refresh automatically.

## Setup

1. In Google Cloud Console, enable the Gmail API and create an OAuth client (Desktop app). Add `http://localhost:3001/oauth2callback` as a redirect URI.
2. `cp .env.example .env` and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
3. `npm install`
4. `npm run auth` and open the printed URL to grant read-only access (one time).
5. `npm run dev`, then open http://localhost:8000.

## Endpoints

- `GET /`: dashboard with totals, status breakdown and a searchable table
- `GET /check?company=Stripe&role=...`: "have I already applied?"
- `GET /api/applications`: JSON list

## Scripts

`npm run dev`, `npm run build`, `npm start`, `npm test`, `npm run typecheck`, `npm run auth`

## Roadmap

- Fuzzy company matching
- More ATS parsers, driven by real inbox samples
- Review-queue UI for resolving unparsed emails
- Optional ML classifier (v2)
- Windows Task Scheduler / service wrapper
