import { openDb } from "./db.js";
import { loadAuthorizedClient } from "./gmail/auth.js";
import { startPolling } from "./poller.js";
import { buildServer } from "./server.js";

const db = openDb(process.env.DATABASE_PATH ?? "data/rachi.db");
const server = buildServer(db);

await server.listen({ port: Number(process.env.PORT ?? 8000), host: "127.0.0.1" });

try {
  startPolling(db, loadAuthorizedClient(), Number(process.env.POLL_INTERVAL_MINUTES ?? 15), (m) => server.log.info(m));
} catch (err) {
  // The dashboard still works without Gmail, so run degraded rather than crash.
  server.log.warn(`Polling disabled: ${err instanceof Error ? err.message : String(err)}`);
}
