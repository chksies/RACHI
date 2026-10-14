import type { createOAuthClient } from "./gmail/auth.js";
import type { Db } from "./db.js";
import { fetchEmail, listJobMessageIds } from "./gmail/fetch.js";
import { processEmail, type Outcome } from "./pipeline.js";
import { sweepOpenApplications, type SweepSummary } from "./sweep.js";

type OAuth2Client = ReturnType<typeof createOAuthClient>;

export type PollSummary = Record<Outcome, number>;

/**
 * One poll cycle. The first run looks back 30 days; later runs look back a day past the
 * last successful poll. Overlap is harmless because processed_messages makes every
 * message idempotent.
 */
export async function pollOnce(db: Db, auth: OAuth2Client): Promise<PollSummary> {
  const last = db.prepare("SELECT value FROM sync_state WHERE key = 'last_poll'").get() as { value: string } | undefined;
  const days = last ? Math.max(1, Math.ceil((Date.now() - Date.parse(last.value)) / 86_400_000) + 1) : 30;

  const summary: PollSummary = { skipped: 0, noise: 0, created: 0, updated: 0, queued: 0 };
  const isSeen = db.prepare("SELECT 1 FROM processed_messages WHERE gmail_message_id = ?");

  // Skip already-handled IDs before downloading anything, and process each message as it
  // arrives so a mid-run failure keeps the progress made so far.
  for (const id of await listJobMessageIds(auth, days)) {
    if (isSeen.get(id)) {
      summary.skipped++;
      continue;
    }
    summary[processEmail(db, await fetchEmail(auth, id))]++;
    await new Promise((r) => setTimeout(r, 150));
  }

  db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_poll', ?)").run(new Date().toISOString());
  return summary;
}

/** Pass 2 is heavier (one Gmail search per open company), so it runs every few hours, not every poll. */
export async function sweepIfDue(db: Db, auth: OAuth2Client, everyHours: number): Promise<SweepSummary | null> {
  const last = db.prepare("SELECT value FROM sync_state WHERE key = 'last_sweep'").get() as { value: string } | undefined;
  if (last && Date.now() - Date.parse(last.value) < everyHours * 3_600_000) return null;
  const summary = await sweepOpenApplications(db, auth);
  db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_sweep', ?)").run(new Date().toISOString());
  return summary;
}

export function startPolling(db: Db, auth: OAuth2Client, intervalMinutes: number, log: (msg: string) => void) {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap cycles
    running = true;
    try {
      log(`poll: ${JSON.stringify(await pollOnce(db, auth))}`);
      const sweep = await sweepIfDue(db, auth, Number(process.env.SWEEP_INTERVAL_HOURS ?? 6));
      if (sweep) log(`sweep: ${JSON.stringify(sweep)}`);
    } catch (err) {
      log(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(tick, intervalMinutes * 60_000);
}
