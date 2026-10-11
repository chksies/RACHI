import Fastify from "fastify";
import type { Db } from "./db.js";
import { findExisting } from "./dedup.js";
import type { Application } from "./types.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function buildServer(db: Db) {
  const app = Fastify({ logger: true });

  // Pre-apply check: "have I already applied to this company?"
  app.get<{ Querystring: { company?: string; role?: string } }>("/check", async (req, reply) => {
    const { company, role } = req.query;
    if (!company) return reply.code(400).send({ error: "company is required" });
    const hit = findExisting(db, company, role ?? null);
    return hit
      ? { applied: true, company: hit.company, role: hit.role, date_applied: hit.date_applied, status: hit.status }
      : { applied: false };
  });

  app.get("/api/applications", async () => db.prepare("SELECT * FROM applications ORDER BY date_applied DESC, id DESC").all());

  app.get("/", async (_req, reply) => {
    const rows = db.prepare("SELECT * FROM applications ORDER BY date_applied DESC, id DESC").all() as Application[];
    const counts = db.prepare("SELECT status, COUNT(*) AS n FROM applications GROUP BY status").all() as { status: string; n: number }[];
    const review = (db.prepare("SELECT COUNT(*) AS n FROM review_queue WHERE resolved = 0").get() as { n: number }).n;

    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RACHI</title>
<style>
  body{font:15px system-ui,sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem;color:#1a1a1a}
  .stats{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
  .stat{border:1px solid #ddd;border-radius:8px;padding:.5rem 1rem}
  table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #eee}
  input{padding:.4rem;width:100%;max-width:320px;margin-bottom:.5rem}
</style>
<h1>RACHI</h1>
<div class="stats">
  <div class="stat"><b>${rows.length}</b> total</div>
  ${counts.map((c) => `<div class="stat"><b>${c.n}</b> ${esc(c.status)}</div>`).join("")}
  ${review ? `<div class="stat"><b>${review}</b> need review</div>` : ""}
</div>
<input id="q" placeholder="Search company or role" oninput="for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase())">
<table><thead><tr><th>Company</th><th>Role</th><th>Applied</th><th>Status</th><th>Source</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.company)}</td><td>${esc(r.role)}</td><td>${esc(r.date_applied)}</td><td>${esc(r.status)}</td><td>${esc(r.source)}</td></tr>`).join("")}
</tbody></table>`;
    return reply.type("text/html").send(html);
  });

  return app;
}
