/* =========================================================================
   "What's new" — shared by the public pages and the admin (the CRM's
   WhatsNew, in plain JS).

   Usage: <script src="/whats-new.js" data-page="directory|demo|admin-<page>" defer>

   - New sections get a small "New" pill until you've seen them. They come
     from NEW below (hand-written for each release) and, on admin pages, from
     change-log entries that point at this page.
   - The button starts a spotlight tour: the page dims, a ring frames the part
     being described, and a card says what it is and what it means for you.
     New items come first, then the standing tour for the page.
   - Keyboard: the card's Next button takes focus; Escape ends the tour.
   Nothing here changes records, answers or routing.
   ========================================================================= */
(function () {
  "use strict";

  var VERSION = "2026-11-07";
  var SEEN_KEY = "v360-wn-seen-items";
  var script = document.currentScript;
  var page = (script && script.getAttribute("data-page")) || "directory";
  var isAdmin = page.indexOf("admin-") === 0;

  /* New this release. `pages` lists where each one shows; `target` is a CSS
     selector or a data-tour key. */
  var NEW = [
    { id: "2026-11-09-display-bar", pages: ["demo"], target: "#display-bar", title: "Display settings on screen", body: "Text size, colors and read aloud now sit under the heading, so anyone can change them in one press. Hide folds them away to leave more room for the conversation.", how: "On a computer, press the Space bar to start talking. On a phone, Talk and Type are at the bottom of the screen." },
    { id: "2026-11-08-admin-password", pages: ["admin-settings"], target: "admin-password", title: "The admin has a password", body: "Every admin page now needs the admin password. You stay signed in for 8 hours on this device.", how: "Change the password here. Changing it signs everyone else out. Sign out is at the bottom of the sidebar." },
    { id: "2026-11-08-main-and-links", pages: ["admin-workflows", "admin-dashboard"], target: "flow-list", title: "A main workflow, and a link and QR code for every workflow", body: "The workflow marked “Main site” runs on the public home page. Every published workflow also has its own link, a QR code (SVG or PNG) and a printable flyer you can save as a PDF.", how: "Use “Make main site” to switch the home page. “+ New workflow” starts a new form; Delete asks you to type DELETE." },
    { id: "2026-11-08-conversation-filter", pages: ["admin-conversations"], target: "conversation-filter", title: "Filter and delete conversations", body: "Show all conversations or one workflow, a staff status, a stage or a date range. Conversations are now kept until you delete them, even when their workflow is deleted.", how: "Tick conversations, press Delete selected, and type DELETE to confirm. Deleting can't be undone." },
    { id: "2026-11-08-voice-switch", pages: ["admin-costs"], target: "voice-switch", title: "Natural voice switch", body: "Turn the ElevenLabs natural voice on or off here, and see how many characters it has spoken.", how: "It needs ELEVENLABS_API_KEY in Vercel first; until then the switch stays off and the assistant uses the browser's voice." },
    { id: "2026-11-07-admin-sidebar", pages: ["admin-*"], target: "#admin-nav", title: "The admin has its own sidebar", body: "Every area now has its own page: Dashboard, Conversations, Email tracker, Workflows, Raw data, Estimated costs, Requests, Change log and the Claude & ChatGPT connection.", how: "Pick any page on the left. Collapse the sidebar to an icon rail at the bottom." },
    { id: "2026-11-07-request-button", pages: ["admin-*", "directory", "demo"], target: "request", title: "Request a change from any page", body: "The round button in the corner files a request: “Change content” for questions, wording and organizations, or “Change the app” for layout and features. It's tagged with the page you're on.", how: "Claude works through requests over MCP and replies on the Requests page. On the public pages only you see it, after you've opened the admin on this device." },
    { id: "2026-11-07-workflows", pages: ["admin-workflows", "admin-dashboard"], target: "flow-list", title: "Workflows you can edit", body: "The referral questions and the new V360 TECH interest form are both editable workflows, with a visual editor, checks before publishing and a version history.", how: "Open a workflow to drag, connect and edit questions. Every publish is a version you can revert to." },
    { id: "2026-11-07-requests", pages: ["admin-requests"], target: "request-groups", title: "Your requests in one place", body: "App changes and content changes, each with a status and a thread where Claude replies.", how: "Comment on a finished request and it reopens. Done ones move to the Archive." },
    { id: "2026-11-07-changelog", pages: ["admin-changelog", "admin-dashboard"], target: "#admin-nav a[data-href='/admin/changelog/']", title: "A change log", body: "Every published workflow version and every finished request lands here, newest first, with a link to what changed.", how: "A blue count in the sidebar means there are changes you haven't looked at." },
    { id: "2026-11-07-connect", pages: ["admin-settings"], target: "mcp-url", title: "Connect Claude or ChatGPT", body: "This site now has its own MCP connector, so Claude or ChatGPT can edit workflows and work through your requests.", how: "Copy the URL and follow the steps for your app below." },
    { id: "2026-11-06-site-menu", pages: ["directory", "demo"], target: "#site-menu", title: "A menu on every page", body: "“Find help” opens the directory, Find services, Pathways, the assistant and the guide. “Admin” goes straight to the admin sign-in.", how: "It's the dark bar at the top of every page." }
  ];

  var TOURS = {
    directory: [
      { target: "#q", title: "Search everything", body: "Type an organization, a service, a county or a need. Search looks at names, services, eligibility, contacts and referral steps." },
      { target: "#views", title: "Three views", body: "Directory lists every organization. Pathways shows common routes through services. Find services asks a few questions and suggests where to start." },
      { target: "#filters", hint: "Open the Directory view to see the filters.", title: "Filter and sort", body: "Narrow the list by category, area or confidence. Nothing is ever hidden for being far away; geography only changes the order." },
      { target: "#org-list [id^='org-']", hint: "Open the Directory view to see the listings.", title: "Open a listing", body: "Expand any organization to see services, who qualifies, costs, documents, every referral step and contacts. Each listing has a link you can copy." },
      { target: "#tab-quiz", title: "Find services", body: "Answer as many questions as you like, or skip any. Results explain why each service is suggested." },
      { target: "#feedback-open", title: "Tell us what to improve", body: "This opens your email app with your feedback. Feedback is reviewed before any listing changes." }
    ],
    demo: [
      { target: "#start", hint: "This choice is at the top when you begin.", title: "Talk or type", body: "Choose Talk to use your microphone, or Type to chat. You can switch at any time. This is a demo: please use made-up details." },
      { target: "#display-bar", title: "Make it comfortable", body: "Display settings change text size, colors and contrast, and whether replies are read aloud. More settings has the voice and speaking speed." },
      { target: "#log", hint: "This appears once you start a conversation.", title: "One question at a time", body: "You can say or type: repeat, skip, I don't know, change an answer, or talk to a person." },
      { target: "#panel", hint: "The summary appears after the questions.", title: "Check the summary", body: "Nothing is suggested until you say the summary is right. Use the Change buttons, or say what to fix." },
      { target: "#end-session", hint: "This appears once you start a conversation.", title: "Stop any time", body: "End session is always there and turns the microphone off." }
    ],
    "admin-dashboard": [
      { target: "needs", title: "Needs you", body: "Anything waiting on you: requests Claude has handed back, failed emails and people who asked for staff follow-up.", how: "Click a chip to go straight there." },
      { target: "stats", title: "The last 30 days", body: "Conversations started, by voice or typing, how many confirmed their summary and got suggestions, emails sent and staff requests." },
      { target: "recent-changes", title: "Recent changes", body: "The latest entries from the change log." }
    ],
    "admin-conversations": [
      { target: "conversation-list", hint: "The list appears once it has loaded.", title: "Every conversation", body: "Newest first, with the stage, staff status, anything needing attention and the email status.", how: "Open one to see answers, suggestions with reasons, emails and follow-up requests, and to mark it reviewed." }
    ],
    "admin-emails": [
      { target: "email-filter", title: "Filter by status", body: "Show all emails, only sent, only failed or only waiting ones." },
      { target: "email-table", title: "The email list", body: "Who it went to (partly hidden), the subject, its status and attempts.", how: "Retry a failed email, or open the conversation behind it." }
    ],
    "admin-costs": [
      { target: "cost-table", title: "Running costs", body: "AI understanding, voice and email, with usage and an estimate for the last 30 days." }
    ],
    "admin-workflows": [
      { target: "flow-list", title: "Your workflows", body: "Each card shows what uses the workflow, how many questions it has and its latest version.", how: "Open one to edit it visually." }
    ],
    "admin-editor": [
      { target: "canvas", title: "The decision tree", body: "Sections run left to right; each card is a question. Lines show the order, and coloured lines show follow-ups that only appear after a certain answer.", how: "Drag cards to arrange them. Drag from an answer's dot onto a question to make it a follow-up of that answer." },
      { target: "zoom", title: "Zoom and expand", body: "+ and − zoom in and out, Fit shows everything. “Follow-ups” on a card opens or tucks away the questions that branch from it.", how: "Hold Ctrl and scroll to zoom; drag the background to move around." },
      { target: "inspector", title: "Edit a question", body: "Click a card to change its wording (on screen and spoken), type, answers, what each answer does to the suggestions, and when it's asked." },
      { target: "versions", title: "Versions", body: "Every publish is a version. Compare any two, or revert to an earlier one.", how: "Revert makes a new version, so nothing is ever lost." },
      { target: "publish", title: "Check and publish", body: "Changes save to a draft automatically. Check runs the safety checks and shows how suggestions would change; Publish makes it live.", how: "Publishing goes live in about a minute." }
    ],
    "admin-data": [
      { target: "data-files", title: "Every data file", body: "Open any file or feed, or preview the first part here." }
    ],
    "admin-requests": [
      { target: "request-groups", title: "Requests", body: "App changes and content changes, with a status for each.", how: "Add a comment to give Claude more detail; a comment on a finished request reopens it." }
    ],
    "admin-changelog": [
      { target: "changelog-filter", title: "Filter", body: "Show everything, or only workflow versions, app changes or content changes." },
      { target: "changelog-list", title: "The change log", body: "Newest first. “Show me” opens the page that changed; finished requests link back to the request." }
    ],
    "admin-settings": [
      { target: "claude-steps", title: "Claude", body: "Add the connector in Claude in about a minute." },
      { target: "chatgpt-steps", title: "ChatGPT", body: "ChatGPT needs Developer mode switched on first." },
      { target: "status", title: "Status", body: "Whether the connector works, whether edits are saved to GitHub, and whether editing is on." }
    ]
  };

  /* ---------------- helpers ---------------- */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) { var v = attrs[k]; if (v == null) continue; if (k === "text") n.textContent = v; else if (k === "onclick") n.addEventListener("click", v); else n.setAttribute(k, v); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function find(target) {
    if (!target) return null;
    try { return /^[#.\[]/.test(target) ? document.querySelector(target) : document.querySelector('[data-tour="' + target + '"]'); } catch (e) { return null; }
  }
  function visible(n) { return !!(n && (n.offsetWidth || n.offsetHeight) && n.getClientRects().length); }
  function pageMatch(list) { return list.some(function (p) { return p === page || (p === "admin-*" && isAdmin); }); }
  function seenSet() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"); } catch (e) { return []; } }
  function markSeen(ids) { try { var s = seenSet(); ids.forEach(function (id) { if (s.indexOf(id) === -1) s.push(id); }); localStorage.setItem(SEEN_KEY, JSON.stringify(s.slice(-300))); } catch (e) {} }
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- new items ---------------- */
  var newItems = NEW.filter(function (n) { return pageMatch(n.pages); });
  function unseen() { var s = seenSet(); return newItems.filter(function (n) { return s.indexOf(n.id) === -1; }); }

  function addPills() {
    [].forEach.call(document.querySelectorAll(".wn-new-pill"), function (p) { p.remove(); });
    unseen().forEach(function (n) {
      var t = find(n.target);
      if (!t || t.id === "admin-nav" || t.classList.contains("rq-btn")) return;
      var host = /^(H1|H2|H3|A|BUTTON|SUMMARY)$/.test(t.tagName) ? t : (t.querySelector("h1,h2,h3") || t);
      if (host.querySelector(":scope > .wn-new-pill")) return;
      host.appendChild(el("span", { class: "wn-new-pill", text: "New", "aria-hidden": "true" }));
    });
    var dot = button.querySelector(".wn-dot");
    if (unseen().length && !dot) button.appendChild(el("span", { class: "wn-dot", "aria-hidden": "true" }));
    if (!unseen().length && dot) dot.remove();
    button.setAttribute("aria-label", "What's new" + (unseen().length ? " (" + unseen().length + " new)" : ""));
  }

  /* Change-log entries that point at this admin page become "new" items too. */
  function loadChangelog() {
    var adminSeen = false; try { adminSeen = localStorage.getItem("v360-admin-seen") === "1"; } catch (e) {}
    if (!isAdmin && !adminSeen) return Promise.resolve();
    return fetch("/api/changelog", { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : { entries: [] }; }).then(function (j) {
      var here = location.pathname.replace(/index\.html$/, "");
      j.entries.slice(0, 20).forEach(function (e) {
        if (!e.highlight || !e.highlight.page) return;
        var parts = e.highlight.page.split("#")[0].split("?");
        if (parts[0] !== here && parts[0] + "/" !== here) return;
        if (parts[1] && location.search.replace(/^\?/, "") !== parts[1]) return;
        newItems.unshift({ id: "log-" + e.id, pages: [page], target: e.highlight.target || "main h1, main", title: e.title, body: e.summary || "Changed " + new Date(e.at).toLocaleDateString() + ".", how: "From the change log." });
      });
    }).catch(function () {});
  }

  /* ---------------- button ---------------- */
  var button = el("button", { type: "button", id: "whats-new-open", class: "wn-button", "aria-haspopup": "dialog" }, [
    el("span", { class: "wn-spark", "aria-hidden": "true", text: "✦" }), el("span", { class: "wn-long", text: "What's new" }), el("span", { class: "wn-short", text: "New", "aria-hidden": "true" })
  ]);

  /* ---------------- spotlight tour ---------------- */
  var ring = el("div", { class: "wn-ring", "aria-hidden": "true" });
  var card = el("div", { class: "wn-card", role: "dialog", "aria-modal": "false", "aria-labelledby": "wn-card-title" });
  var steps = [], idx = 0, target = null, raf = 0;

  function buildSteps() {
    var fresh = unseen();
    var out = [];
    if (fresh.length) out.push({ intro: true, title: "What's new", body: fresh.length === 1 ? "One new thing on this page." : fresh.length + " new things on this page:", list: fresh.map(function (n) { return n.title; }) });
    fresh.forEach(function (n) { out.push({ target: n.target, title: n.title, body: n.body, how: n.how, isNew: true, id: n.id }); });
    (TOURS[page] || []).forEach(function (s) { out.push(s); });
    if (!out.length) out.push({ intro: true, title: "What's new", body: "Nothing new on this page." });
    return out;
  }

  function position() {
    var s = steps[idx];
    var t = s && !s.intro ? find(s.target) : null;
    target = visible(t) ? t : null;
    var vw = window.innerWidth, vh = window.innerHeight;
    var cw = Math.min(380, vw - 32);
    card.style.width = cw + "px";
    if (!target) {
      ring.style.display = "block";
      ring.style.left = vw / 2 + "px"; ring.style.top = vh / 2 + "px"; ring.style.width = "0px"; ring.style.height = "0px"; ring.style.borderColor = "transparent";
      card.style.left = Math.max(16, (vw - cw) / 2) + "px"; card.style.top = Math.max(16, vh / 2 - card.offsetHeight / 2) + "px";
      card.removeAttribute("data-arrow");
      return;
    }
    var r = target.getBoundingClientRect();
    ring.style.display = "block"; ring.style.borderColor = "";
    ring.style.left = r.left - 6 + "px"; ring.style.top = r.top - 6 + "px"; ring.style.width = r.width + 12 + "px"; ring.style.height = r.height + 12 + "px";
    var ch = card.offsetHeight;
    var left = Math.min(Math.max(16, r.left + r.width / 2 - cw / 2), vw - cw - 16);
    var top, arrow;
    if (r.bottom + 18 + ch < vh - 8) { top = r.bottom + 18; arrow = "up"; }
    else if (r.top - 18 - ch > 8) { top = r.top - 18 - ch; arrow = "down"; }
    else { top = vh - ch - 16; arrow = null; }
    card.style.left = left + "px"; card.style.top = top + "px";
    if (arrow) { card.setAttribute("data-arrow", arrow); card.style.setProperty("--wn-arrow-x", Math.min(Math.max(18, r.left + r.width / 2 - left), cw - 18) + "px"); }
    else card.removeAttribute("data-arrow");
  }
  function follow() { cancelAnimationFrame(raf); raf = requestAnimationFrame(position); }

  function show(i) {
    idx = Math.max(0, Math.min(steps.length - 1, i));
    var s = steps[idx];
    if (s.isNew) markSeen([s.id]);
    card.textContent = "";
    card.appendChild(el("p", { class: "wn-count", role: "status", "aria-live": "polite", text: (s.isNew ? "New · " : "What's new · ") + (idx + 1) + " of " + steps.length }));
    card.appendChild(el("h2", { id: "wn-card-title", class: "wn-title", text: s.title }));
    card.appendChild(el("p", { class: "wn-body", text: s.body }));
    if (s.list) card.appendChild(el("ul", { class: "wn-list" }, s.list.map(function (t) { return el("li", { text: t }); })));
    if (s.how) card.appendChild(el("p", { class: "wn-how" }, [el("strong", { text: "What it means for you: " }), s.how]));
    var t = s.intro ? null : find(s.target);
    if (!s.intro && !visible(t)) card.appendChild(el("p", { class: "wn-how", text: s.hint || "This part isn't on the screen right now." }));
    var last = idx === steps.length - 1;
    var nextBtn = el("button", { type: "button", class: "wn-btn wn-primary", text: last ? "Finish" : "Next", onclick: function () { if (last) end(); else show(idx + 1); } });
    var backBtn = el("button", { type: "button", class: "wn-btn", text: "Back", onclick: function () { show(idx - 1); } });
    if (idx === 0) backBtn.disabled = true;
    var links = isAdmin ? el("a", { href: "/admin/changelog/", class: "wn-link", text: "Change log" }) : el("a", { href: "/guide.html", class: "wn-link", text: "Full guide" });
    card.appendChild(el("div", { class: "wn-actions" }, [backBtn, nextBtn, el("span", { class: "wn-spacer" }), links, el("button", { type: "button", class: "wn-btn wn-skip", text: "Skip", onclick: end })]));
    if (visible(t)) {
      var big = t.getBoundingClientRect().height > window.innerHeight / 2;
      t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: big ? "start" : "center" });
    }
    position(); setTimeout(position, 420);
    nextBtn.focus({ preventScroll: true });
  }

  function start() {
    steps = buildSteps();
    document.body.appendChild(ring); document.body.appendChild(card);
    document.documentElement.classList.add("wn-touring");
    window.addEventListener("scroll", follow, true); window.addEventListener("resize", follow);
    show(0);
  }
  function end() {
    window.removeEventListener("scroll", follow, true); window.removeEventListener("resize", follow);
    if (ring.parentNode) ring.remove();
    if (card.parentNode) card.remove();
    document.documentElement.classList.remove("wn-touring");
    markSeen(newItems.map(function (n) { return n.id; }));
    try { localStorage.setItem("v360-whats-new-seen", VERSION); } catch (e) {}
    addPills();
    button.focus();
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && card.parentNode) { e.preventDefault(); end(); } });
  button.addEventListener("click", function () { if (card.parentNode) end(); else start(); });

  /* ---------------- placement ---------------- */
  function reserveSpace(bar) {
    function apply() {
      var h = Math.ceil(bar.getBoundingClientRect().height) + 16;
      document.documentElement.style.scrollPaddingBottom = h + "px";
      document.body.style.paddingBottom = h + "px";
    }
    apply();
    if (window.ResizeObserver) new ResizeObserver(apply).observe(bar);
    window.addEventListener("resize", apply);
    document.addEventListener("focusin", function (ev) {
      var t = ev.target;
      if (!t || bar.contains(t) || card.contains(t)) return;
      var barTop = bar.getBoundingClientRect().top, r = t.getBoundingClientRect();
      if (r.height && r.bottom > barTop - 8) window.scrollBy({ top: r.bottom - barTop + 16, behavior: "instant" });
    });
  }

  function mount() {
    var header = document.querySelector(".top-inner");
    var dock = document.querySelector(".feedback-dock");
    if (isAdmin) {
      button.classList.add("wn-corner");
      document.body.appendChild(button);
    } else if (header) {
      button.classList.add("wn-in-header");
      var group = el("div", { class: "wn-header-actions" });
      var existing = header.lastElementChild && header.lastElementChild.tagName === "BUTTON" ? header.lastElementChild : null;
      group.appendChild(button);
      if (existing) group.appendChild(existing);
      header.appendChild(group);
    } else if (dock) {
      dock.classList.add("wn-docked");
      dock.insertBefore(button, dock.firstChild);
      reserveSpace(dock);
      var lastSkip = [].slice.call(document.querySelectorAll(".skip-link")).pop();
      if (lastSkip) lastSkip.insertAdjacentElement("afterend", el("a", { class: "skip-link", href: "#whats-new-open", text: "Skip to What's new and the tour" }));
    } else {
      button.classList.add("wn-floating");
      document.body.appendChild(button);
      reserveSpace(button);
    }
    addPills();
    loadChangelog().then(addPills);
    // Page scripts render late (lists, editor); pin the pills once they're in.
    setTimeout(addPills, 1200);
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
