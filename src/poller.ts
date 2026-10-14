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

/** What the dashboard shows in its sync indicator. Timestamps are ISO strings. */
export interface PollStatus {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  /** Changes whenever a poll or sweep actually added or moved something, so the page can offer a refresh. */
  lastChangeAt: string | null;
  lastError: string | null;
}

export const pollStatus: PollStatus = {
  enabled: false,
  running: false,
  intervalMinutes: 15,
  lastPollAt: null,
  nextPollAt: null,
  lastChangeAt: null,
  lastError: null,
};

let runNow: (() => boolean) | null = null;

/** Start a check right now ("Check now" button). False when sync is off or a check is already running. */
export function triggerPoll(): boolean {
  return runNow ? runNow() : false;
}

/**
 * Poll, then schedule the next poll for `intervalMinutes` after this one *finishes*. Chaining
 * timeouts (instead of a fixed interval) means cycles never overlap and the countdown shown on
 * the dashboard is exact.
 */
export function startPolling(db: Db, auth: OAuth2Client, intervalMinutes: number, log: (msg: string) => void) {
  const stored = db.prepare("SELECT value FROM sync_state WHERE key = 'last_poll'").get() as { value: string } | undefined;
  Object.assign(pollStatus, { enabled: true, intervalMinutes, lastPollAt: stored?.value ?? null });

  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    clearTimeout(timer);
    pollStatus.running = true;
    try {
      const summary = await pollOnce(db, auth);
      log(`poll: ${JSON.stringify(summary)}`);
      let changed = summary.created + summary.updated + summary.queued > 0;
      const sweep = await sweepIfDue(db, auth, Number(process.env.SWEEP_INTERVAL_HOURS ?? 6));
      if (sweep) {
        log(`sweep: ${JSON.stringify(sweep)}`);
        changed ||= sweep.updated + sweep.queued > 0;
      }
      pollStatus.lastPollAt = new Date().toISOString();
      pollStatus.lastError = null;
      if (changed) pollStatus.lastChangeAt = pollStatus.lastPollAt;
    } catch (err) {
      pollStatus.lastError = err instanceof Error ? err.message : String(err);
      log(`poll failed: ${pollStatus.lastError}`);
    } finally {
      pollStatus.running = false;
      pollStatus.nextPollAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
      timer = setTimeout(() => void tick(), intervalMinutes * 60_000);
    }
  };

  runNow = () => {
    if (pollStatus.running) return false;
    void tick();
    return true;
  };

  void tick();
  return () => clearTimeout(timer);
}
