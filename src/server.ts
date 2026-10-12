import Fastify from "fastify";
import type { Db } from "./db.js";
import { findExisting } from "./dedup.js";
import type { Application } from "./types.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `<style>
  body{font:15px system-ui,sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem;color:#1a1a1a;background:#fff}
  .stats{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
  .stat{border:1px solid #ddd;border-radius:8px;padding:.5rem 1rem;color:inherit;text-decoration:none}
  a.stat:hover{background:#f5f5f5}
  table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #eee;vertical-align:top}
  input{padding:.4rem;width:100%;max-width:320px;margin-bottom:.5rem}
  button{cursor:pointer}
  .muted{color:#666}
  @media (prefers-color-scheme: dark){body{background:#111;color:#eee}.stat{border-color:#333}a.stat:hover{background:#1c1c1c}td,th{border-color:#262626}.muted{color:#999}a{color:#8ab4f8}}
</style>`;

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}${body}`;

const gmailLink = (id: string) => {
  const account = process.env.GMAIL_ACCOUNT;
  return `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : ""}#all/${encodeURIComponent(id)}`;
};

interface ReviewRow {
  gmail_message_id: string;
  sender: string | null;
  subject: string | null;
  kind: string | null;
  received_at: string | null;
}

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

    const html = page("RACHI", `
<h1>RACHI</h1>
<div class="stats">
  <div class="stat"><b>${rows.length}</b> total</div>
  ${counts.map((c) => `<div class="stat"><b>${c.n}</b> ${esc(c.status)}</div>`).join("")}
  ${review ? `<a class="stat" href="/review"><b>${review}</b> need review &rarr;</a>` : ""}
</div>
<input id="q" placeholder="Search company or role" oninput="for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase())">
<table><thead><tr><th>Company</th><th>Role</th><th>Applied</th><th>Status</th><th>Source</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.company)}</td><td>${esc(r.role)}</td><td>${esc(r.date_applied)}</td><td>${esc(r.status)}</td><td>${esc(r.source)}</td></tr>`).join("")}
</tbody></table>`);
    return reply.type("text/html").send(html);
  });

  const unresolved = () =>
    db
      .prepare("SELECT gmail_message_id, sender, subject, kind, received_at FROM review_queue WHERE resolved = 0 ORDER BY received_at DESC")
      .all() as ReviewRow[];

  app.get("/api/review", async () => unresolved());

  // Emails RACHI found job-related but could not attribute to a company.
  app.get("/review", async (_req, reply) => {
    const rows = unresolved();
    const html = page("RACHI: needs review", `
<p><a href="/">&larr; Dashboard</a></p>
<h1>Needs review</h1>
<p class="muted">Job-related emails RACHI could not match to a company. Open one in Gmail to see it, then dismiss it once handled.</p>
<div class="stats"><div class="stat"><b id="count">${rows.length}</b> to review</div></div>
<input id="q" placeholder="Search sender or subject" oninput="for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase())">
<table><thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Type</th><th></th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr id="r-${esc(r.gmail_message_id)}"><td class="muted">${esc((r.received_at ?? "").slice(0, 10))}</td><td>${esc(r.sender)}</td><td><a href="${esc(gmailLink(r.gmail_message_id))}" target="_blank" rel="noopener">${esc(r.subject)}</a></td><td>${esc(r.kind)}</td><td><button onclick="dismiss('${esc(r.gmail_message_id)}')">Dismiss</button></td></tr>`,
  )
  .join("")}
</tbody></table>
<script>
async function dismiss(id){
  const res = await fetch("/review/" + encodeURIComponent(id) + "/resolve", {method: "POST"});
  if (!res.ok) return alert("Could not dismiss that email");
  document.getElementById("r-" + id).remove();
  const c = document.getElementById("count"); c.textContent = Number(c.textContent) - 1;
}
</script>`);
    return reply.type("text/html").send(html);
  });

  app.post<{ Params: { id: string } }>("/review/:id/resolve", async (req, reply) => {
    const { changes } = db.prepare("UPDATE review_queue SET resolved = 1 WHERE gmail_message_id = ?").run(req.params.id);
    return changes ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  return app;
}
