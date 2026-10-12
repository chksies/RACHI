import Fastify from "fastify";
import type { Db } from "./db.js";
import { findExisting } from "./dedup.js";
import { senderCompany } from "./parsers/index.js";
import { resolveReview } from "./pipeline.js";
import type { Application, ApplicationStatus } from "./types.js";

const REVIEW_STATUSES: ApplicationStatus[] = ["applied", "interviewing", "rejected"];

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `<style>
  body{font:15px system-ui,sans-serif;margin:2rem auto;max-width:1200px;padding:0 1rem;color:#1a1a1a;background:#fff}
  .stats{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
  .stat{border:1px solid #ddd;border-radius:8px;padding:.5rem 1rem;color:inherit;text-decoration:none}
  a.stat:hover{background:#f5f5f5}
  .stat.active{border-color:#4c8bf5;background:rgba(76,139,245,.14)}
  table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #eee;vertical-align:top}
  input{padding:.4rem;width:100%;max-width:320px;margin-bottom:.5rem}
  button{cursor:pointer}
  .muted{color:#666}
  .scroll{overflow-x:auto}
  td input{margin:0;min-width:7rem}
  .acts{min-width:11rem}
  .acts button{margin:0 .25rem .25rem 0;padding:.25rem .6rem}
  .quiet{opacity:.6}
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
    const countOf = (status: string) => rows.filter((r) => r.status === status).length;
    const review = (db.prepare("SELECT COUNT(*) AS n FROM review_queue WHERE resolved = 0").get() as { n: number }).n;
    // Fixed order; "offer" only appears once there is one.
    const filters = (["applied", "interviewing", "rejected", "offer"] as const).filter((s) => s !== "offer" || countOf(s) > 0);

    const html = page("RACHI", `
<h1>RACHI</h1>
<div class="stats">
  <a class="stat" href="#all" data-f="all"><b>${rows.length}</b> total</a>
  ${filters.map((s) => `<a class="stat" href="#${s}" data-f="${s}"><b>${countOf(s)}</b> ${s}</a>`).join("")}
  ${review ? `<a class="stat" href="/review"><b>${review}</b> need review &rarr;</a>` : ""}
</div>
<input id="q" placeholder="Search company or role">
<span id="shown" class="muted"></span>
<table><thead><tr><th>Company</th><th>Role</th><th>Applied</th><th>Status</th><th>Source</th></tr></thead><tbody>
${rows.map((r) => `<tr data-status="${esc(r.status)}"><td>${esc(r.company)}</td><td>${esc(r.role)}</td><td>${esc(r.date_applied)}</td><td>${esc(r.status)}</td><td>${esc(r.source)}</td></tr>`).join("")}
</tbody></table>
<script>
// Status filter lives in the URL hash (#rejected) so it survives reloads and can be bookmarked.
const rows = [...document.querySelectorAll("tbody tr")];
const q = document.getElementById("q");
function apply() {
  const f = location.hash.slice(1) || "all";
  const text = q.value.toLowerCase();
  let shown = 0;
  for (const r of rows) {
    r.hidden = (f !== "all" && r.dataset.status !== f) || !r.textContent.toLowerCase().includes(text);
    if (!r.hidden) shown++;
  }
  for (const s of document.querySelectorAll("[data-f]")) s.classList.toggle("active", s.dataset.f === f);
  document.getElementById("shown").textContent = shown === rows.length ? "" : "Showing " + shown + " of " + rows.length;
}
addEventListener("hashchange", apply);
q.addEventListener("input", apply);
apply();
</script>`);
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
<p class="muted">Job-related emails RACHI could not match to a company. File each one as Applied, Interviewing or Rejected. RACHI works out the company itself; type one in only to override it. It joins the matching application if one exists.</p>
<div class="stats"><div class="stat"><b id="count">${rows.length}</b> to review</div></div>
<input id="q" placeholder="Search sender or subject" oninput="for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase())">
<div class="scroll"><table><thead><tr><th>Received</th><th>Email</th><th>Company and role</th><th>File as</th></tr></thead><tbody>
${rows
  .map((r) => {
    const id = esc(r.gmail_message_id);
    return `<tr id="r-${id}"><td class="muted">${esc((r.received_at ?? "").slice(0, 10))}</td>
<td><a href="${esc(gmailLink(r.gmail_message_id))}" target="_blank" rel="noopener">${esc(r.subject)}</a><div class="muted">${esc(r.sender)} &middot; ${esc(r.kind)}</div></td>
<td><input class="co" placeholder="Company (auto)" value="${esc(senderCompany(r.sender ?? ""))}"><input class="ro" placeholder="Role (optional)" style="margin-top:.35rem"></td>
<td class="acts"><button onclick="file('${id}','applied')">Applied</button> <button onclick="file('${id}','interviewing')">Interviewing</button> <button onclick="file('${id}','rejected')">Rejected</button> <button class="quiet" onclick="dismiss('${id}')">Dismiss</button></td></tr>`;
  })
  .join("")}
</tbody></table></div>
<script>
function done(id){
  document.getElementById("r-" + id).remove();
  const c = document.getElementById("count"); c.textContent = Number(c.textContent) - 1;
}
async function file(id, status){
  const row = document.getElementById("r-" + id);
  const company = row.querySelector(".co").value.trim(); // blank is fine: the server works it out
  const res = await fetch("/review/" + encodeURIComponent(id) + "/apply", {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({company, role: row.querySelector(".ro").value.trim(), status})
  });
  if (!res.ok) return alert("Could not save that one");
  done(id);
}
async function dismiss(id){
  const res = await fetch("/review/" + encodeURIComponent(id) + "/resolve", {method: "POST"});
  if (!res.ok) return alert("Could not dismiss that email");
  done(id);
}
</script>`);
    return reply.type("text/html").send(html);
  });

  // File a queued email as an application with the status the user picked.
  app.post<{ Params: { id: string }; Body: { company?: string; role?: string; status?: string } }>(
    "/review/:id/apply",
    async (req, reply) => {
      const { company, role, status } = req.body ?? {};
      if (!REVIEW_STATUSES.includes(status as ApplicationStatus)) return reply.code(400).send({ error: "invalid status" });
      const outcome = resolveReview(db, req.params.id, { company, role, status: status as ApplicationStatus });
      return outcome === "not_found" ? reply.code(404).send({ error: "not found" }) : { ok: true, outcome };
    },
  );

  app.post<{ Params: { id: string } }>("/review/:id/resolve", async (req, reply) => {
    const { changes } = db.prepare("UPDATE review_queue SET resolved = 1 WHERE gmail_message_id = ?").run(req.params.id);
    return changes ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  return app;
}
