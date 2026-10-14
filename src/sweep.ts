import type { createOAuthClient } from "./gmail/auth.js";
import { classify } from "./classifier.js";
import type { Db } from "./db.js";
import { companyKey, nextStatus } from "./dedup.js";
import { fetchEmail, searchMessageIds } from "./gmail/fetch.js";
import { isTerminalState } from "./templates.js";
import type { Application, ApplicationStatus, RawEmail } from "./types.js";

type OAuth2Client = ReturnType<typeof createOAuthClient>;

export type SweepResult = "updated" | "queued" | "ignored";

/**
 * Pass 2 of the design. Pass 1 (the poll) is the only thing that creates applications.
 * This pass only moves existing, still-open applications forward: for every company that
 * is not in a terminal state it looks for newer mail that mentions it, which catches
 * rejections and interview invites from a real person's address that the job-mail search
 * in pass 1 would never surface.
 */
export function applyStatusMail(db: Db, candidates: Application[], email: RawEmail): SweepResult {
  const open = candidates.filter((a) => !isTerminalState(a.status));
  if (!open.length) return "ignored";

  // The company must be named by the sender or the subject, never just somewhere in the body:
  // a generic name like "Point" appears in plenty of unrelated mail. A person writing from
  // the company's own domain (margarita@mastra.ai) counts as the sender naming it.
  const haystack = ` ${companyKey(`${email.from} ${email.subject}`)} `;
  const named = open.filter((a) => a.company_key && haystack.includes(` ${a.company_key} `));
  if (!named.length) return "ignored";

  const { kind } = classify(email);
  if (kind !== "rejection" && kind !== "interview") return "ignored";
  const incoming: ApplicationStatus = kind === "rejection" ? "rejected" : "interviewing";

  // Several open roles at one company: only act if the mail names exactly one of them.
  let target: Application | undefined = named.length === 1 ? named[0] : undefined;
  if (!target) {
    const text = `${email.subject} ${email.body}`.toLowerCase();
    const byRole = named.filter((a) => a.role && text.includes(a.role.toLowerCase()));
    if (byRole.length === 1) target = byRole[0];
  }

  const date = email.date.toISOString().slice(0, 10);
  if (!target) {
    db.prepare(
      `INSERT OR IGNORE INTO review_queue (gmail_message_id, sender, subject, kind, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(email.id, email.from, email.subject, kind, email.date.toISOString());
    db.prepare("INSERT OR IGNORE INTO processed_messages (gmail_message_id, kind) VALUES (?, ?)").run(email.id, kind);
    return "queued";
  }

  const note = `${date} ${kind}: ${email.subject}`;
  db.prepare("UPDATE applications SET status = ?, notes = ? WHERE id = ?").run(
    nextStatus(target.status, incoming),
    target.notes ? `${target.notes}\n${note}` : note,
    target.id,
  );
  db.prepare("INSERT OR IGNORE INTO processed_messages (gmail_message_id, kind) VALUES (?, ?)").run(email.id, kind);
  return "updated";
}

export interface SweepSummary {
  companies: number;
  fetched: number;
  updated: number;
  queued: number;
}

const gmailQuoted = (s: string) => `"${s.replace(/["\\]/g, " ").trim()}"`;

/** One sweep over every open application, grouped by company so each company is searched once. */
export async function sweepOpenApplications(db: Db, auth: OAuth2Client): Promise<SweepSummary> {
  const open = (db.prepare("SELECT * FROM applications ORDER BY id").all() as Application[]).filter(
    (a) => !isTerminalState(a.status) && a.company_key,
  );
  const groups = new Map<string, Application[]>();
  for (const a of open) groups.set(a.company_key, [...(groups.get(a.company_key) ?? []), a]);

  const processed = db.prepare("SELECT 1 FROM processed_messages WHERE gmail_message_id = ?");
  const checked = db.prepare("SELECT 1 FROM status_checked WHERE gmail_message_id = ?");
  const markChecked = db.prepare("INSERT OR IGNORE INTO status_checked (gmail_message_id) VALUES (?)");
  const summary: SweepSummary = { companies: groups.size, fetched: 0, updated: 0, queued: 0 };

  for (const apps of groups.values()) {
    const earliest = apps.map((a) => a.date_applied).filter((d): d is string => !!d).sort()[0];
    const days = earliest ? Math.min(90, Math.max(2, Math.ceil((Date.now() - Date.parse(earliest)) / 86_400_000) + 1)) : 30;
    const ids = await searchMessageIds(auth, `${gmailQuoted(apps[0]!.company)} newer_than:${days}d -from:me`, 2);

    for (const id of ids) {
      if (processed.get(id) || checked.get(id)) continue;
      const email = await fetchEmail(auth, id);
      summary.fetched++;
      // Re-read the rows: an earlier mail in this loop may already have moved one forward.
      const fresh = db.prepare("SELECT * FROM applications WHERE company_key = ?").all(apps[0]!.company_key) as Application[];
      const result = applyStatusMail(db, fresh, email);
      if (result === "updated") summary.updated++;
      else if (result === "queued") summary.queued++;
      else markChecked.run(id);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return summary;
}
