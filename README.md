# RACHI

A job application tracker that keeps itself current. RACHI connects to your Gmail inbox, recognizes application confirmations and rejections, and updates your application log automatically.

## Planned architecture

- **Gmail OAuth**: read-only access to the user's inbox
- **Ingestion pipeline**: fetch, parse and classify emails (confirmation, rejection, other)
- **Dedup logic**: one application record per company and role, however many emails mention it
- **Postgres**: applications, email events, sync state
- **Background jobs**: scheduled inbox sync and retry handling

## Status

Project scaffold only. Stack to be decided.
