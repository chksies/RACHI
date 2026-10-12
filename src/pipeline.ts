import { classify } from "./classifier.js";
import type { Db } from "./db.js";
import { companyKey, findByText, findExisting, nextStatus } from "./dedup.js";
import { parseEmail } from "./parsers/index.js";
import type { ApplicationStatus, EmailKind, RawEmail } from "./types.js";

export type Outcome = "skipped" | "noise" | "created" | "updated" | "queued";

const KIND_TO_STATUS: Partial<Record<EmailKind, ApplicationStatus>> = {
  confirmation: "applied",
  interview: "interviewing",
  rejection: "rejected",
};

function markProcessed(db: Db, id: string, kind: string) {
  db.prepare("INSERT OR IGNORE INTO processed_messages (gmail_message_id, kind) VALUES (?, ?)").run(id, kind);
}

function appendNote(existing: string | null, line: string): string {
  return existing ? `${existing}\n${line}` : line;
}

/** classify -> parse -> dedup -> write. Idempotent per Gmail message id. */
export function processEmail(db: Db, email: RawEmail): Outcome {
  const seen = db.prepare("SELECT 1 FROM processed_messages WHERE gmail_message_id = ?").get(email.id);
  if (seen) return "skipped";

  const { kind } = classify(email);
  if (kind === "noise") {
    markProcessed(db, email.id, kind);
    return "noise";
  }

  const date = email.date.toISOString().slice(0, 10);
  const status: ApplicationStatus = KIND_TO_STATUS[kind] ?? "applied";
  const parsed = parseEmail(email, kind);

  const run = db.transaction((): Outcome => {
    const existing = parsed
      ? findExisting(db, parsed.company, parsed.role)
      : findByText(db, `${email.from} ${email.subject}`);

    if (existing) {
      // A generic "status" mail carries no new information beyond a note.
      const newStatus = kind === "status" ? existing.status : nextStatus(existing.status, status);
      db.prepare(
        `UPDATE applications
         SET status = ?, role = COALESCE(role, ?), location = COALESCE(location, ?), notes = ?
         WHERE id = ?`,
      ).run(
        newStatus,
        parsed?.role ?? null,
        parsed?.location ?? null,
        appendNote(existing.notes, `${date} ${kind}: ${email.subject}`),
        existing.id,
      );
      markProcessed(db, email.id, kind);
      return "updated";
    }

    // A rejection or interview for a company we never saw means we missed the confirmation
    // (it predates the lookback window, or was sent from another address). Still log it.
    if (parsed && (kind === "confirmation" || kind === "rejection" || kind === "interview")) {
      const applied = kind === "confirmation" ? date : null;
      db.prepare(
        `INSERT INTO applications (company, company_key, role, location, date_applied, status, source, gmail_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(parsed.company, companyKey(parsed.company), parsed.role, parsed.location, applied, status, parsed.source, email.id);
      markProcessed(db, email.id, kind);
      return "created";
    }

    db.prepare(
      `INSERT OR IGNORE INTO review_queue (gmail_message_id, sender, subject, kind, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(email.id, email.from, email.subject, kind, email.date.toISOString());
    markProcessed(db, email.id, kind);
    return "queued";
  });

  return run();
}

export interface ReviewDecision {
  company: string;
  role?: string | null;
  status: ApplicationStatus;
}

/**
 * The user decided what a queued email is. Attach it to an existing application (same
 * dedup rules as the poller) or create one, set the chosen status, and close the item.
 * An explicit choice overrides the automatic status ordering.
 */
export function resolveReview(db: Db, id: string, decision: ReviewDecision): "created" | "updated" | "not_found" {
  const item = db
    .prepare("SELECT sender, subject, received_at FROM review_queue WHERE gmail_message_id = ? AND resolved = 0")
    .get(id) as { sender: string | null; subject: string | null; received_at: string | null } | undefined;
  if (!item) return "not_found";

  const company = decision.company.trim();
  const role = decision.role?.trim() || null;
  const today = new Date().toISOString().slice(0, 10);

  return db.transaction((): "created" | "updated" => {
    const existing = findExisting(db, company, role);
    let outcome: "created" | "updated";
    if (existing) {
      db.prepare("UPDATE applications SET status = ?, role = COALESCE(role, ?), notes = ? WHERE id = ?").run(
        decision.status,
        role,
        appendNote(existing.notes, `${today} manual ${decision.status}: ${item.subject ?? ""}`),
        existing.id,
      );
      outcome = "updated";
    } else {
      const applied = decision.status === "applied" ? (item.received_at ?? "").slice(0, 10) || today : null;
      db.prepare(
        `INSERT INTO applications (company, company_key, role, location, date_applied, status, source, gmail_message_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(company, companyKey(company), role, applied, decision.status, "review", id);
      outcome = "created";
    }
    db.prepare("UPDATE review_queue SET resolved = 1 WHERE gmail_message_id = ?").run(id);
    return outcome;
  })();
}
