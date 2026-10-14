/** Shared look and feel for the dashboard and the review page: plain CSS, no libraries, no external requests. */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A stable colour per company, so the same company always gets the same badge. */
export function hue(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export const initial = (company: string) => (company.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

const STYLE = `<style>
:root{
  --bg:#f5f6f8;--surface:#fff;--text:#12151c;--muted:#667085;--border:#e5e7ec;--hover:#f0f2f6;
  --accent:#4f46e5;--accent-soft:#eef0ff;
  --applied:#2563eb;--applied-bg:#e8f0fe;
  --interviewing:#b45309;--interviewing-bg:#fef3c7;
  --rejected:#b42318;--rejected-bg:#fee4e2;
  --offer:#15803d;--offer-bg:#dcfce7;
  --withdrawn:#475467;--withdrawn-bg:#eaecf0;
  --shadow:0 1px 2px rgba(16,24,40,.06);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0e1015;--surface:#161a22;--text:#e8eaf0;--muted:#98a2b3;--border:#262c38;--hover:#1c212b;
  --accent:#8b86ff;--accent-soft:#1f2040;
  --applied:#7ab0ff;--applied-bg:rgba(59,130,246,.18);
  --interviewing:#fbbf5a;--interviewing-bg:rgba(245,158,11,.16);
  --rejected:#ff8a80;--rejected-bg:rgba(239,68,68,.17);
  --offer:#6ee7a0;--offer-bg:rgba(34,197,94,.16);
  --withdrawn:#b0b8c6;--withdrawn-bg:rgba(148,163,184,.16);
  --shadow:none;
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px 56px}
button,input{font:inherit;color:inherit}
button{cursor:pointer}

/* header + sync indicator */
.top{display:flex;align-items:center;gap:20px;padding:18px 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;letter-spacing:.04em;color:var(--text)}
.brand:hover{text-decoration:none}
.logo{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--accent);color:#fff;font-weight:800;font-size:16px;letter-spacing:0}
.nav{display:flex;gap:4px}
.nav a{padding:6px 12px;border-radius:8px;color:var(--muted);font-weight:500}
.nav a:hover{background:var(--hover);text-decoration:none;color:var(--text)}
.nav a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow);border:1px solid var(--border);padding:5px 11px}
.nav .count{margin-left:6px;padding:1px 7px;border-radius:99px;background:var(--accent);color:#fff;font-size:12px;font-weight:600}
.nav .count[data-n="0"]{display:none}
.sync{margin-left:auto;display:flex;align-items:center;gap:10px;padding:6px 8px 6px 12px;border:1px solid var(--border);border-radius:99px;background:var(--surface);box-shadow:var(--shadow);font-size:13px}
.sync .dot{width:9px;height:9px;border-radius:50%;background:var(--offer)}
.sync.running .dot{background:var(--interviewing);animation:pulse 1.2s ease-in-out infinite}
.sync.error .dot{background:var(--rejected)}
.sync.off .dot{background:var(--muted)}
.sync .sub{color:var(--muted)}
.sync button{border:0;border-radius:99px;background:var(--accent-soft);color:var(--accent);padding:4px 12px;font-weight:600;font-size:12px}
.sync button:hover{filter:brightness(.96)}
.sync button:disabled{opacity:.5;cursor:default}
.progress{height:3px;border-radius:3px;background:var(--border);overflow:hidden;margin-bottom:22px}
.progress div{height:100%;width:0;background:var(--accent);transition:width 1s linear}
.progress.running div{width:35%;animation:slide 1.3s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
@keyframes slide{0%{margin-left:-35%}100%{margin-left:100%}}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);display:flex;align-items:center;gap:14px;padding:10px 12px 10px 18px;border-radius:12px;background:var(--text);color:var(--bg);box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:5}
.toast[hidden]{display:none}
.toast button{border:0;border-radius:8px;padding:5px 12px;background:var(--bg);color:var(--text);font-weight:600}

/* stat cards */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
.card{display:flex;flex-direction:column;gap:2px;padding:14px 16px;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:var(--shadow);color:var(--text);position:relative;overflow:hidden}
.card:hover{text-decoration:none;border-color:var(--accent)}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--tone,var(--border))}
.card .num{font-size:28px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.card .lbl{color:var(--muted);font-size:13px;text-transform:capitalize}
.card.active{border-color:var(--accent);background:var(--accent-soft)}
.card.review{--tone:var(--accent)}
.card.review .lbl{color:var(--accent);font-weight:600}
.split{display:flex;height:8px;border-radius:99px;overflow:hidden;background:var(--border);margin:16px 0 22px}
.split i{display:block;height:100%}

/* toolbar + table */
.panel{border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:var(--shadow);overflow:hidden}
.tools{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.search{position:relative;flex:1;min-width:200px;max-width:380px}
.search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted)}
.search input{width:100%;padding:8px 12px 8px 34px;border:1px solid var(--border);border-radius:10px;background:var(--bg);outline:none}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.shown{color:var(--muted);font-size:13px}
.scroll{overflow:auto;max-height:70vh}
table{border-collapse:collapse;width:100%}
th{position:sticky;top:0;z-index:1;background:var(--surface);text-align:left;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:10px 14px;border-bottom:1px solid var(--border);white-space:nowrap}
th[data-sort]{cursor:pointer;user-select:none}
th[data-sort]:hover{color:var(--text)}
th .arrow{opacity:.0;margin-left:4px}th.sorted .arrow{opacity:1}
td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--hover)}
.co{display:flex;align-items:center;gap:12px;font-weight:600}
.badge{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:9px;color:#fff;font-weight:700;font-size:14px}
.role{color:var(--muted);max-width:340px}
.date{color:var(--muted);white-space:nowrap}
.src{color:var(--muted);font-size:13px}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;text-transform:capitalize;white-space:nowrap}
.pill.applied{color:var(--applied);background:var(--applied-bg)}
.pill.interviewing{color:var(--interviewing);background:var(--interviewing-bg)}
.pill.rejected{color:var(--rejected);background:var(--rejected-bg)}
.pill.offer{color:var(--offer);background:var(--offer-bg)}
.pill.withdrawn{color:var(--withdrawn);background:var(--withdrawn-bg)}
.empty{text-align:center;color:var(--muted);padding:44px 14px}

/* review cards */
h1{font-size:22px;margin:0 0 4px}
.lede{color:var(--muted);margin:0 0 18px;max-width:70ch}
.items{display:grid;gap:12px}
.item{display:grid;grid-template-columns:1fr auto;gap:14px 24px;padding:16px 18px;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:var(--shadow);transition:opacity .25s,transform .25s}
.item.gone{opacity:0;transform:translateX(24px)}
.item .subject{font-weight:600;font-size:16px;color:var(--text)}
.item .meta{color:var(--muted);font-size:13px;margin-top:2px;overflow-wrap:anywhere}
.kind{display:inline-block;margin-right:8px;padding:1px 8px;border-radius:99px;background:var(--hover);color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.fields{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.fields input{flex:1;min-width:140px;max-width:240px;padding:7px 11px;border:1px solid var(--border);border-radius:9px;background:var(--bg);outline:none}
.fields input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.actions{display:flex;flex-direction:column;gap:7px;justify-content:center;min-width:132px}
.btn{border:1px solid transparent;border-radius:9px;padding:7px 12px;font-weight:600;font-size:13px;text-align:center}
.btn:hover{filter:brightness(.95)}
.btn.applied{background:var(--applied-bg);color:var(--applied)}
.btn.interviewing{background:var(--interviewing-bg);color:var(--interviewing)}
.btn.rejected{background:var(--rejected-bg);color:var(--rejected)}
.btn.quiet{background:transparent;color:var(--muted);font-weight:500}
.btn.quiet:hover{color:var(--text);text-decoration:underline}

@media (max-width:760px){
  .col-role,.col-src{display:none}
  td,th{padding:9px 8px}
  .co{gap:8px;font-size:14px}
  .badge{width:26px;height:26px;border-radius:7px;font-size:12px}
  .date{font-size:13px}
  .sync{margin-left:0;width:100%;justify-content:space-between}
  .item{grid-template-columns:1fr}
  .actions{flex-direction:row;flex-wrap:wrap;min-width:0}
  .actions .btn{flex:1}
}
@media (max-width:480px){.badge{display:none}}
</style>`;

/** Sync indicator: counts down to the next Gmail check, resyncs with the server, offers a refresh when data changed. */
const SYNC_SCRIPT = `<script>
(function () {
  var s = null, seenChange, $ = function (id) { return document.getElementById(id); };
  function mmss(ms) { var t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); }
  function ago(iso) {
    if (!iso) return "never";
    var m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago";
  }
  function render() {
    if (!s) return;
    var box = $("sync"), text = $("sync-text"), sub = $("sync-sub"), btn = $("sync-now"), bar = $("sync-bar"), prog = $("progress");
    box.className = "sync"; prog.className = "progress"; btn.hidden = false; btn.disabled = false;
    sub.textContent = s.lastPollAt ? "Last checked " + ago(s.lastPollAt) : "";
    box.title = s.lastError ? "Last error: " + s.lastError : "";
    if (!s.enabled) {
      box.className = "sync off"; text.textContent = "Gmail sync is off"; sub.textContent = "run npm run auth"; btn.hidden = true; return;
    }
    if (s.running) {
      box.className = "sync running"; prog.className = "progress running"; text.textContent = "Checking Gmail\\u2026"; btn.disabled = true; return;
    }
    var left = s.nextPollAt ? Date.parse(s.nextPollAt) - Date.now() : 0, total = s.intervalMinutes * 60000;
    if (s.lastError) box.className = "sync error";
    text.textContent = (s.lastError ? "Last check failed \\u00b7 retry in " : "Next check in ") + (left > 0 ? mmss(left) : "a moment");
    bar.style.width = Math.min(100, Math.max(0, (1 - left / total) * 100)) + "%";
  }
  function toast() {
    var t = $("toast"); t.hidden = false;
  }
  function load() {
    fetch("/api/status").then(function (r) { return r.json(); }).then(function (j) {
      s = j;
      if (seenChange === undefined) seenChange = j.lastChangeAt;
      else if (j.lastChangeAt !== seenChange) { seenChange = j.lastChangeAt; toast(); }
      var n = $("nav-review"); if (n) { n.textContent = j.reviewCount; n.setAttribute("data-n", j.reviewCount); }
      render();
    }).catch(function () {});
  }
  $("sync-now").addEventListener("click", function () {
    this.disabled = true;
    fetch("/api/poll", { method: "POST" }).then(function () { setTimeout(load, 600); });
  });
  $("toast-refresh").addEventListener("click", function () { location.reload(); });
  setInterval(render, 1000); setInterval(load, 8000); load();
})();
</script>`;

const header = (active: "applications" | "review", reviewCount: number) => `
<header class="top">
  <a class="brand" href="/"><span class="logo">R</span>RACHI</a>
  <nav class="nav">
    <a href="/"${active === "applications" ? ' class="on"' : ""}>Applications</a>
    <a href="/review"${active === "review" ? ' class="on"' : ""}>Review<span class="count" id="nav-review" data-n="${reviewCount}">${reviewCount}</span></a>
  </nav>
  <div class="sync off" id="sync">
    <span class="dot"></span><span id="sync-text">Connecting…</span><span class="sub" id="sync-sub"></span>
    <button id="sync-now" type="button" hidden>Check now</button>
  </div>
</header>
<div class="progress" id="progress"><div id="sync-bar"></div></div>
<div class="toast" id="toast" hidden>New mail was processed <button id="toast-refresh" type="button">Refresh</button></div>`;

export function page(opts: { title: string; active: "applications" | "review"; reviewCount: number; body: string; script?: string }): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>${STYLE}
<body><div class="wrap">${header(opts.active, opts.reviewCount)}${opts.body}</div>${SYNC_SCRIPT}${opts.script ?? ""}</body></html>`;
}
