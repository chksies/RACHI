import type { createOAuthClient } from "./gmail/auth.js";
import type { Db } from "./db.js";
import { fetchRecent } from "./gmail/fetch.js";
import { processEmail, type Outcome } from "./pipeline.js";

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

  const emails = await fetchRecent(auth, days);
  const summary: PollSummary = { skipped: 0, noise: 0, created: 0, updated: 0, queued: 0 };
  for (const email of emails) summary[processEmail(db, email)]++;

  db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_poll', ?)").run(new Date().toISOString());
  return summary;
}

export function startPolling(db: Db, auth: OAuth2Client, intervalMinutes: number, log: (msg: string) => void) {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap cycles
    running = true;
    try {
      log(`poll: ${JSON.stringify(await pollOnce(db, auth))}`);
    } catch (err) {
      log(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(tick, intervalMinutes * 60_000);
}
