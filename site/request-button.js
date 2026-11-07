/* "Request a change" button (the CRM's request button, in plain JS).
   A round button in the bottom-right corner opens a small form:
   "Change content" (questions, wording, organizations) or "Change the app"
   (layout, buttons, features). Sending files a request tagged with the page it
   came from; nothing changes until Claude picks it up over MCP and replies on
   the admin Requests page.
   Shown on every admin page, and on public pages only on a device that has
   opened the admin side, so people using the directory never see it. */
(function () {
  "use strict";
  var isAdmin = location.pathname.indexOf("/admin/") === 0;
  var seen = false;
  try { seen = localStorage.getItem("v360-admin-seen") === "1"; } catch (e) {}
  if (!isAdmin && !seen) return;

  var CSS = [
    ".rq-btn{position:fixed;right:16px;bottom:var(--rq-bottom,16px);z-index:60;width:44px;height:44px;border-radius:50%;border:0;background:#051362;color:#fff;box-shadow:0 6px 20px rgba(5,19,98,.35);cursor:pointer;display:grid;place-items:center}",
    ".rq-btn:hover{background:#0b1f7a}.rq-btn svg{width:20px;height:20px}",
    ".rq-btn:focus-visible{outline:3px solid #25b4fa;outline-offset:2px}",
    ".rq-pop{position:fixed;right:16px;bottom:calc(var(--rq-bottom,16px) + 54px);z-index:61;width:380px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;background:#fff;color:#0f1d33;border:1px solid #e2e8ee;border-radius:16px;box-shadow:0 18px 50px rgba(5,19,98,.28);padding:16px;font:14px/1.45 'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;text-align:left}",
    ".rq-pop[hidden]{display:none}.rq-pop h2{font-size:16px;margin:0}.rq-on{color:#5b6878;font-size:12.5px;margin:2px 0 10px;overflow-wrap:anywhere}",
    ".rq-kind{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}",
    ".rq-kind button{border:1px solid #e2e8ee;background:#f8fafc;border-radius:10px;padding:8px;text-align:left;cursor:pointer;font:inherit;color:inherit}",
    ".rq-kind button[aria-pressed=true]{border-color:#25b4fa;background:#e0f2fe;box-shadow:inset 0 0 0 1px #25b4fa}",
    ".rq-kind strong{display:block;font-size:13.5px}.rq-kind span{display:block;font-size:12px;color:#5b6878}",
    ".rq-pop textarea{width:100%;box-sizing:border-box;min-height:92px;border:1px solid #cfd8e3;border-radius:10px;padding:8px 10px;font:inherit;resize:vertical}",
    ".rq-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px}",
    ".rq-send{background:#0f5d1a;color:#fff;border:0;border-radius:9px;padding:7px 14px;font:inherit;font-weight:700;cursor:pointer}.rq-send:disabled{opacity:.45;cursor:not-allowed}",
    ".rq-hint{font-size:12px;color:#5b6878}.rq-msg{margin-top:8px;font-size:13px;color:#10509c;background:#e0f2fe;border-radius:8px;padding:6px 9px}.rq-msg.err{color:#a3311f;background:#fde8e5}",
    ".rq-list{margin:12px 0 0;padding:10px 0 0;border-top:1px solid #e2e8ee;list-style:none}.rq-list li{font-size:13px;padding:4px 0;display:flex;gap:8px;justify-content:space-between}",
    ".rq-chip{font-size:11px;font-weight:700;border-radius:999px;padding:0 7px;background:#f1f5f9;color:#5b6878;white-space:nowrap;align-self:flex-start}",
    ".rq-chip.in_progress{background:#e0f2fe;color:#10509c}.rq-chip.needs_ben{background:#fef3c7;color:#92400e}.rq-chip.done{background:#d1fae5;color:#047857}",
    ".rq-all{display:inline-block;margin-top:8px;font-size:13px;color:#051362}"
  ].join("\n");
  var KINDS = {
    content: { title: "Change content", blurb: "Questions, wording, organizations", ph: "e.g. Change the county question to also list Lincoln County" },
    app: { title: "Change the app", blurb: "Layout, buttons, features", ph: "e.g. Put the email tracker's failed emails at the top" }
  };
  var STATUS = { open: "Waiting", in_progress: "In progress", needs_ben: "Needs you", done: "Done", cancelled: "Cancelled" };

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) { var v = attrs[k]; if (v == null) continue; if (k === "text") n.textContent = v; else if (k === "html") n.innerHTML = v; else n.setAttribute(k, v); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function pagePath() { return location.pathname + location.search; }
  function pageLabel() {
    var base = (window.V360Admin && window.V360Admin.pageLabel()) || document.title.replace(/\s+—.*$/, "");
    var tab = document.querySelector('main [role="tab"][aria-selected="true"]');
    var dlg = document.querySelector("dialog[open] h2, [role=dialog]:not([hidden]) h2");
    var extra = [];
    if (tab) extra.push(tab.textContent.trim());
    if (dlg && !dlg.closest(".rq-pop")) extra.push(dlg.textContent.trim());
    return [base].concat(extra).join(" › ").slice(0, 200);
  }

  var style = el("style", { text: CSS });
  var kind = "content";
  var btn = el("button", { type: "button", class: "rq-btn", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Request a change", "aria-label": "Request a change",
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>' });
  var on = el("p", { class: "rq-on" });
  var kindBox = el("div", { class: "rq-kind", role: "group", "aria-label": "Kind of change" });
  Object.keys(KINDS).forEach(function (k) {
    var b = el("button", { type: "button", "data-k": k, "aria-pressed": String(k === kind) }, [el("strong", { text: KINDS[k].title }), el("span", { text: KINDS[k].blurb })]);
    b.addEventListener("click", function () { kind = k; sync(); });
    kindBox.appendChild(b);
  });
  var ta = el("textarea", { "aria-label": "What should change?", maxlength: "4000" });
  var send = el("button", { type: "button", class: "rq-send", text: "Send", disabled: "" });
  var msg = el("p", { class: "rq-msg", hidden: "" });
  var list = el("ul", { class: "rq-list", hidden: "" });
  var pop = el("div", { class: "rq-pop", role: "dialog", "aria-label": "Request a change", hidden: "" }, [
    el("h2", { text: "Request a change" }), on, kindBox, ta,
    el("div", { class: "rq-row" }, [el("span", { class: "rq-hint", text: "Nothing changes until Claude picks it up. Ctrl/⌘+Enter sends." }), send]),
    msg, list, el("a", { class: "rq-all", href: "/admin/requests/", text: "All requests →" })
  ]);

  function sync() {
    [].forEach.call(kindBox.children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-k") === kind)); });
    ta.placeholder = KINDS[kind].ph;
    if (ta.value.trim()) send.removeAttribute("disabled"); else send.setAttribute("disabled", "");
  }
  function loadMine() {
    fetch("/api/requests?page=" + encodeURIComponent(pagePath()), { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { requests: [] }; })
      .then(function (j) {
        list.textContent = "";
        if (!j.requests.length) { list.hidden = true; return; }
        list.hidden = false;
        list.appendChild(el("li", null, [el("strong", { text: "Sent from this page" })]));
        j.requests.forEach(function (r) { list.appendChild(el("li", null, [el("span", { text: r.title }), el("span", { class: "rq-chip " + r.status, text: STATUS[r.status] || r.status })])); });
      }).catch(function () {});
  }
  function open() {
    on.innerHTML = ""; on.appendChild(document.createTextNode("On ")); on.appendChild(el("strong", { text: pageLabel() })); on.appendChild(document.createTextNode(" · " + pagePath()));
    pop.hidden = false; btn.setAttribute("aria-expanded", "true"); msg.hidden = true; sync(); loadMine();
    setTimeout(function () { ta.focus(); }, 0);
  }
  function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); }
  function submit() {
    var body = ta.value.trim(); if (!body) return;
    send.setAttribute("disabled", "");
    fetch("/api/requests", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: kind, body: body, page_path: pagePath(), page_label: pageLabel() }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
      .then(function () {
        ta.value = ""; msg.className = "rq-msg"; msg.textContent = "Sent. Claude will pick this up and reply on the Requests page."; msg.hidden = false; loadMine();
        if (window.V360Admin) window.V360Admin.api("GET", "/api/requests").then(function (j) { window.V360Admin.setBadge("/admin/requests/", j.requests.filter(function (r) { return r.status === "open" || r.status === "in_progress" || r.status === "needs_ben"; }).length); }).catch(function () {});
        document.dispatchEvent(new CustomEvent("v360:request-sent"));
      })
      .catch(function (e) { msg.className = "rq-msg err"; msg.textContent = "Couldn't send: " + e.message; msg.hidden = false; })
      .finally(sync);
  }
  btn.addEventListener("click", function () { if (pop.hidden) open(); else close(); });
  ta.addEventListener("input", sync);
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
  send.addEventListener("click", submit);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !pop.hidden) { close(); btn.focus(); } });
  document.addEventListener("click", function (e) { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(); });

  function place() {
    var bottom = 16;
    if (isAdmin) bottom = 68; // above the What's new pill
    var dock = document.querySelector(".feedback-dock");
    if (dock) bottom = Math.ceil(dock.getBoundingClientRect().height) + 12;
    document.documentElement.style.setProperty("--rq-bottom", bottom + "px");
  }
  function mount() {
    document.head.appendChild(style);
    btn.setAttribute("data-tour", "request");
    document.body.appendChild(btn); document.body.appendChild(pop);
    place(); window.addEventListener("resize", place); setTimeout(place, 500);
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
