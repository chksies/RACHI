import Fastify from "fastify";
import type { Db } from "./db.js";
import { findExisting } from "./dedup.js";
import { senderCompany } from "./parsers/index.js";
import { resolveReview } from "./pipeline.js";
import { pollStatus, triggerPoll } from "./poller.js";
import type { Application, ApplicationStatus } from "./types.js";
import { esc, hue, initial, page } from "./ui.js";

const REVIEW_STATUSES: ApplicationStatus[] = ["applied", "interviewing", "rejected"];

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

const SEARCH_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

const DASHBOARD_SCRIPT = `<script>
(function () {
  var tbody = document.getElementById("rows"), q = document.getElementById("q");
  var rows = [].slice.call(tbody.querySelectorAll("tr[data-status]"));
  var order = { applied: 0, interviewing: 1, offer: 2, rejected: 3, withdrawn: 4 };
  var sortKey = null, sortDir = 1;

  function rel(d) {
    if (!d) return "\\u2014";
    var days = Math.floor((Date.now() - Date.parse(d + "T00:00:00")) / 864e5);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 14) return days + " days ago";
    if (days < 60) return Math.round(days / 7) + " weeks ago";
    return Math.round(days / 30) + " months ago";
  }
  rows.forEach(function (r) { var c = r.querySelector(".date"); c.textContent = rel(r.dataset.date); c.title = r.dataset.date || ""; });

  function apply() {
    var f = location.hash.slice(1) || "all", text = q.value.toLowerCase(), shown = 0;
    rows.forEach(function (r) {
      r.hidden = (f !== "all" && r.dataset.status !== f) || r.textContent.toLowerCase().indexOf(text) < 0;
      if (!r.hidden) shown++;
    });
    document.getElementById("empty").hidden = shown > 0;
    document.getElementById("shown").textContent = shown === rows.length ? rows.length + " applications" : "Showing " + shown + " of " + rows.length;
    [].forEach.call(document.querySelectorAll("[data-f]"), function (c) { c.classList.toggle("active", c.dataset.f === f); });
  }

  function sortBy(key) {
    sortDir = sortKey === key ? -sortDir : key === "company" ? 1 : -1;
    sortKey = key;
    var val = function (r) { return key === "date" ? r.dataset.date || "" : key === "status" ? order[r.dataset.status] : r.dataset.company; };
    rows.sort(function (a, b) { var x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; });
    var empty = document.getElementById("empty");
    rows.forEach(function (r) { tbody.insertBefore(r, empty); });
    [].forEach.call(document.querySelectorAll("th[data-sort]"), function (th) {
      var on = th.dataset.sort === key;
      th.classList.toggle("sorted", on);
      th.querySelector(".arrow").textContent = on ? (sortDir > 0 ? "\\u2191" : "\\u2193") : "";
    });
  }

  [].forEach.call(document.querySelectorAll("th[data-sort]"), function (th) { th.addEventListener("click", function () { sortBy(th.dataset.sort); }); });
  addEventListener("hashchange", apply);
  q.addEventListener("input", apply);
  apply();
})();
</script>`;

const REVIEW_SCRIPT = `<script>
function bump() {
  var c = document.getElementById("count"), n = Math.max(0, Number(c.textContent) - 1);
  c.textContent = n;
  var nav = document.getElementById("nav-review"); nav.textContent = n; nav.setAttribute("data-n", n);
  if (n === 0) document.getElementById("all-clear").hidden = false;
}
function done(id) {
  var el = document.getElementById("r-" + id);
  el.classList.add("gone");
  setTimeout(function () { el.remove(); bump(); }, 250);
}
function send(url, payload, fail) {
  return fetch(url, payload ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : { method: "POST" })
    .then(function (res) { if (!res.ok) throw new Error(); }).catch(function () { alert(fail); throw 0; });
}
function file(id, status) {
  var el = document.getElementById("r-" + id);
  send("/review/" + encodeURIComponent(id) + "/apply", { company: el.querySelector(".co-in").value.trim(), role: el.querySelector(".ro-in").value.trim(), status: status }, "Could not save that one")
    .then(function () { done(id); }, function () {});
}
function dismiss(id) {
  send("/review/" + encodeURIComponent(id) + "/resolve", null, "Could not dismiss that email").then(function () { done(id); }, function () {});
}
</script>`;

export function buildServer(db: Db) {
  const app = Fastify({ logger: true });

  const reviewCount = () => (db.prepare("SELECT COUNT(*) AS n FROM review_queue WHERE resolved = 0").get() as { n: number }).n;

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

  // Drives the sync indicator: when the next Gmail check happens, whether one is running, and whether anything changed.
  app.get("/api/status", async (_req, reply) => reply.header("cache-control", "no-store").send({ ...pollStatus, reviewCount: reviewCount() }));

  // "Check now"
  app.post("/api/poll", async (_req, reply) => (triggerPoll() ? { started: true } : reply.code(409).send({ started: false })));

  app.get("/", async (_req, reply) => {
    const rows = db.prepare("SELECT * FROM applications ORDER BY date_applied DESC, id DESC").all() as Application[];
    const countOf = (status: string) => rows.filter((r) => r.status === status).length;
    const review = reviewCount();
    // Fixed order; "offer" and "withdrawn" only appear once there is one.
    const statuses = (["applied", "interviewing", "rejected", "offer", "withdrawn"] as const).filter(
      (s) => (s !== "offer" && s !== "withdrawn") || countOf(s) > 0,
    );

    const cards = [
      `<a class="card" href="#all" data-f="all" style="--tone:var(--accent)"><span class="num">${rows.length}</span><span class="lbl">Total</span></a>`,
      ...statuses.map(
        (s) => `<a class="card" href="#${s}" data-f="${s}" style="--tone:var(--${s})"><span class="num">${countOf(s)}</span><span class="lbl">${s}</span></a>`,
      ),
      review ? `<a class="card review" href="/review"><span class="num">${review}</span><span class="lbl">Need review &rarr;</span></a>` : "",
    ].join("");

    const split = rows.length
      ? `<div class="split">${statuses
          .filter((s) => countOf(s))
          .map((s) => `<i style="width:${(countOf(s) / rows.length) * 100}%;background:var(--${s})" title="${countOf(s)} ${s}"></i>`)
          .join("")}</div>`
      : `<div class="split"></div>`;

    const body = `
<div class="cards">${cards}</div>${split}
<div class="panel">
  <div class="tools">
    <label class="search">${SEARCH_ICON}<input id="q" placeholder="Search company or role" autocomplete="off"></label>
    <span class="shown" id="shown"></span>
  </div>
  <div class="scroll"><table>
    <thead><tr>
      <th data-sort="company">Company<span class="arrow"></span></th>
      <th class="col-role">Role</th>
      <th data-sort="date">Applied<span class="arrow"></span></th>
      <th data-sort="status">Status<span class="arrow"></span></th>
      <th class="col-src">Source</th>
    </tr></thead>
    <tbody id="rows">
${rows
  .map(
    (r) => `<tr data-status="${esc(r.status)}" data-company="${esc(r.company.toLowerCase())}" data-date="${esc(r.date_applied ?? "")}">
<td><div class="co"><span class="badge" style="background:hsl(${hue(r.company)} 52% 44%)">${esc(initial(r.company))}</span>${esc(r.company)}</div></td>
<td class="role col-role">${esc(r.role)}</td>
<td class="date">${esc(r.date_applied)}</td>
<td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
<td class="src col-src">${esc(r.source)}</td></tr>`,
  )
  .join("\n")}
<tr id="empty" hidden><td colspan="5" class="empty">No applications match.</td></tr>
    </tbody>
  </table></div>
</div>`;

    return reply.type("text/html").send(page({ title: "RACHI", active: "applications", reviewCount: review, body, script: DASHBOARD_SCRIPT }));
  });

  const unresolved = () =>
    db
      .prepare("SELECT gmail_message_id, sender, subject, kind, received_at FROM review_queue WHERE resolved = 0 ORDER BY received_at DESC")
      .all() as ReviewRow[];

  app.get("/api/review", async () => unresolved());

  // Emails RACHI found job-related but could not attribute to a company.
  app.get("/review", async (_req, reply) => {
    const rows = unresolved();
    const body = `
<h1>Needs review <span class="shown">(<span id="count">${rows.length}</span>)</span></h1>
<p class="lede">Job emails RACHI could not place. File each one as Applied, Interviewing or Rejected and RACHI works out the company itself. Type a company only to override it.</p>
<div class="items">
${rows
  .map((r) => {
    const id = esc(r.gmail_message_id);
    return `<article class="item" id="r-${id}">
  <div>
    <div><span class="kind">${esc(r.kind)}</span><span class="shown">${esc((r.received_at ?? "").slice(0, 10))}</span></div>
    <a class="subject" href="${esc(gmailLink(r.gmail_message_id))}" target="_blank" rel="noopener">${esc(r.subject || "(no subject)")}</a>
    <div class="meta">${esc(r.sender)}</div>
    <div class="fields"><input class="co-in" placeholder="Company (auto)" value="${esc(senderCompany(r.sender ?? ""))}"><input class="ro-in" placeholder="Role (optional)"></div>
  </div>
  <div class="actions">
    <button class="btn applied" onclick="file('${id}','applied')">Applied</button>
    <button class="btn interviewing" onclick="file('${id}','interviewing')">Interviewing</button>
    <button class="btn rejected" onclick="file('${id}','rejected')">Rejected</button>
    <button class="btn quiet" onclick="dismiss('${id}')">Dismiss</button>
  </div>
</article>`;
  })
  .join("\n")}
</div>
<div class="panel" id="all-clear"${rows.length ? " hidden" : ""}><div class="empty">All caught up. Nothing needs your attention.</div></div>`;

    return reply.type("text/html").send(page({ title: "RACHI: needs review", active: "review", reviewCount: rows.length, body, script: REVIEW_SCRIPT }));
  });

  // File a queued email as an application with the status the user picked.
  app.post<{ Params: { id: string }; Body: { company?: string; role?: string; status?: string } }>("/review/:id/apply", async (req, reply) => {
    const { company, role, status } = req.body ?? {};
    if (!REVIEW_STATUSES.includes(status as ApplicationStatus)) return reply.code(400).send({ error: "invalid status" });
    const outcome = resolveReview(db, req.params.id, { company, role, status: status as ApplicationStatus });
    return outcome === "not_found" ? reply.code(404).send({ error: "not found" }) : { ok: true, outcome };
  });

  app.post<{ Params: { id: string } }>("/review/:id/resolve", async (req, reply) => {
    const { changes } = db.prepare("UPDATE review_queue SET resolved = 1 WHERE gmail_message_id = ?").run(req.params.id);
    return changes ? { ok: true } : reply.code(404).send({ error: "not found" });
  });

  return app;
}
