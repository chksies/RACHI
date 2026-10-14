import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  company TEXT NOT NULL,
  company_key TEXT NOT NULL,
  role TEXT,
  location TEXT,
  date_applied DATE,
  status TEXT NOT NULL DEFAULT 'applied',   -- applied, interviewing, rejected, offer
  source TEXT,                              -- ashby, lever, workday, ... or manual
  gmail_message_id TEXT UNIQUE,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_applications_company_key ON applications(company_key);

-- Every Gmail message we've handled, so status updates are never applied twice.
CREATE TABLE IF NOT EXISTS processed_messages (
  gmail_message_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Job-related emails no parser understood. Never silently dropped.
CREATE TABLE IF NOT EXISTS review_queue (
  gmail_message_id TEXT PRIMARY KEY,
  sender TEXT,
  subject TEXT,
  kind TEXT,
  received_at TEXT,
  resolved INTEGER NOT NULL DEFAULT 0
);

-- Mail the status sweep looked at and found nothing actionable in, so it is not fetched again.
CREATE TABLE IF NOT EXISTS status_checked (
  gmail_message_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
