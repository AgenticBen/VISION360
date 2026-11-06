/* Admin shell: the left sidebar on every admin page, plus small helpers the
   page scripts share (window.V360Admin). Load it first, synchronously, at the
   end of <body>. Pages put their content in <main class="admin-main">. */
(function () {
  "use strict";
  var ICONS = {
    dashboard: '<path d="M3 13h8V3H3zM13 21h8v-8h-8zM3 21h8v-6H3zM13 3v8h8V3z"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    flow: '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="16" width="7" height="5" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><path d="M6.5 8v5a2 2 0 0 0 2 2H14M10 5.5h4"/>',
    data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    money: '<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    log: '<path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    collapse: '<path d="M4 6h16M4 12h10M4 18h16"/>'
  };
  var NAV = [
    { title: "Overview", items: [["/admin/", "Dashboard", "dashboard"]] },
    { title: "People", items: [["/admin/conversations/", "Conversations", "chat"], ["/admin/emails/", "Email tracker", "mail"]] },
    { title: "Build", items: [["/admin/workflows/", "Workflows", "flow"], ["/admin/data/", "Raw data", "data"]] },
    { title: "Money", items: [["/admin/costs/", "Estimated costs", "money"]] },
    { title: "Settings", items: [["/admin/requests/", "Requests", "target"], ["/admin/changelog/", "Change log", "log"], ["/admin/settings/", "Connect Claude & ChatGPT", "plug"]] }
  ];

  function svg(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>"; }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "class") n.className = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; e.code = j.code; e.body = j; throw e; } return j; }); });
  }
  function when(iso) { return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; }
  function ago(iso) {
    if (!iso) return "";
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 86400 * 7) return Math.round(s / 86400) + "d ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  /* Two-click confirm (the CRM's "armed" pattern). */
  function confirm2(btn, armedLabel, fn) {
    var label = btn.textContent, timer;
    btn.addEventListener("click", function () {
      if (btn.classList.contains("armed")) { clearTimeout(timer); btn.classList.remove("armed"); btn.textContent = label; fn(); return; }
      btn.classList.add("armed"); btn.textContent = armedLabel;
      timer = setTimeout(function () { btn.classList.remove("armed"); btn.textContent = label; }, 3500);
    });
    return btn;
  }
  function norm(p) { return p.replace(/index\.html$/, ""); }
  /* Deepest matching link wins, so /admin/workflows/edit/ lights up Workflows, not Dashboard. */
  function activeHref() {
    var here = norm(location.pathname); if (here.slice(-1) !== "/") here += "/";
    var best = null;
    NAV.forEach(function (g) { g.items.forEach(function (it) {
      if (here === it[0] || (it[0] !== "/admin/" && here.indexOf(it[0]) === 0)) { if (!best || it[0].length > best.length) best = it[0]; }
    }); });
    return best || (here.indexOf("/admin/") === 0 ? "/admin/" : null);
  }
  function pageLabel() {
    var a = activeHref(), label = "Admin";
    NAV.forEach(function (g) { g.items.forEach(function (it) { if (it[0] === a) label = "Admin › " + it[1]; }); });
    return label;
  }

  var badges = {};
  function buildNav() {
    var active = activeHref();
    var nav = el("nav", { class: "sidebar", id: "admin-nav", "aria-label": "Admin" }, [
      el("a", { class: "sb-brand", href: "/admin/" }, [el("span", { class: "sb-logo", text: "V" }), el("span", { class: "sb-name", html: "VISION360<small>Admin</small>" })])
    ]);
    NAV.forEach(function (g) {
      var box = el("div", { class: "sb-group" }, [el("div", { class: "sb-group-title", text: g.title })]);
      g.items.forEach(function (it) {
        var a = el("a", { class: "sb-link", href: it[0], title: it[1], "aria-current": it[0] === active ? "page" : null, "data-href": it[0] });
        a.innerHTML = svg(it[2]);
        a.appendChild(el("span", { class: "sb-label", text: it[1] }));
        var b = el("span", { class: "sb-badge", hidden: true });
        a.appendChild(b);
        badges[it[0]] = b;
        box.appendChild(a);
      });
      nav.appendChild(box);
    });
    var collapse = el("button", { type: "button", class: "sb-collapse", title: "Collapse sidebar", html: svg("collapse") + '<span class="sb-label">Collapse</span>' });
    collapse.addEventListener("click", function () {
      document.body.classList.toggle("nav-collapsed");
      try { localStorage.setItem("v360-admin-nav", document.body.classList.contains("nav-collapsed") ? "collapsed" : "open"); } catch (e) {}
    });
    var back = el("a", { class: "sb-link", href: "/", title: "Public site", html: svg("back") + '<span class="sb-label">Public site</span>' });
    nav.appendChild(el("div", { class: "sb-foot" }, [back, collapse]));
    return nav;
  }

  function setBadge(href, n, kind) {
    var b = badges[href]; if (!b) return;
    if (n) { b.textContent = n > 99 ? "99+" : String(n); b.hidden = false; b.className = "sb-badge" + (kind ? " " + kind : ""); }
    else b.hidden = true;
  }

  function mount() {
    try { if (localStorage.getItem("v360-admin-nav") === "collapsed") document.body.classList.add("nav-collapsed"); } catch (e) {}
    try { localStorage.setItem("v360-admin-seen", "1"); } catch (e) {}
    document.body.classList.add("admin");
    var layout = document.querySelector(".admin-layout");
    if (!layout) {
      layout = el("div", { class: "admin-layout" });
      var main = document.querySelector(".admin-main");
      document.body.insertBefore(layout, main);
      layout.appendChild(main);
    }
    var nav = buildNav();
    layout.insertBefore(nav, layout.firstChild);
    var bar = el("div", { class: "mobile-bar" }, [
      el("button", { type: "button", text: "☰ Menu", onclick: function () { document.body.classList.add("nav-open"); scrim.hidden = false; } }),
      el("strong", { text: pageLabel().replace("Admin › ", "") })
    ]);
    var scrim = el("div", { class: "nav-scrim", hidden: true, onclick: function () { document.body.classList.remove("nav-open"); scrim.hidden = true; } });
    document.body.insertBefore(bar, layout);
    document.body.appendChild(scrim);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && document.body.classList.contains("nav-open")) scrim.click(); });

    // Badges: open requests and unread change-log entries.
    api("GET", "/api/requests").then(function (j) {
      var open = j.requests.filter(function (r) { return r.status === "open" || r.status === "in_progress" || r.status === "needs_ben"; }).length;
      setBadge("/admin/requests/", open);
    }).catch(function () {});
    api("GET", "/api/changelog").then(function (j) {
      var seen = ""; try { seen = localStorage.getItem("v360-changelog-seen") || ""; } catch (e) {}
      var unread = j.entries.filter(function (e) { return e.at > seen; }).length;
      setBadge("/admin/changelog/", unread, "sky");
    }).catch(function () {});
  }

  window.V360Admin = { el: el, api: api, when: when, ago: ago, svg: svg, confirm2: confirm2, setBadge: setBadge, pageLabel: pageLabel, NAV: NAV };
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
