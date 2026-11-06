/* Shared site menu: one bar at the top of every page with two short menus,
   "Find help" (the public tools) and "Admin" (what's happening behind the
   scenes). Plain disclosure buttons: Enter/Space opens, Escape closes and
   returns focus, clicking elsewhere closes. Include with
   <link rel="stylesheet" href="/site-menu.css"> and <script src="/site-menu.js">. */
(function () {
  "use strict";
  var MENUS = [
    { id: "help", label: "Find help", items: [
      ["/", "Directory", "Every organization, with search and filters"],
      ["/#tab-quiz", "Find services", "Answer a few questions for suggestions"],
      ["/#tab-pathways", "Pathways", "Common routes through services"],
      ["/demo/", "Talk or type", "The voice and chat assistant"],
      ["/guide.html", "How to use VISION360", "Step-by-step guide to every page"]
    ] },
    { id: "admin", label: "Admin", note: "No password needed for now.", items: [
      ["/admin/", "Dashboard", "Usage in the last 30 days"],
      ["/admin/conversations/", "Conversations", "Answers, suggestions and follow-ups"],
      ["/admin/emails/", "Email tracker", "Every plan email and its status"],
      ["/admin/workflows/", "Workflows", "Edit the questions visually"],
      ["/admin/costs/", "Estimated costs", "What the tool is costing to run"],
      ["/admin/data/", "Raw data", "The data files and JSON feeds"],
      ["/admin/requests/", "Requests", "Changes you've asked for"],
      ["/admin/changelog/", "Change log", "Everything that has changed"],
      ["/admin/settings/", "Connect Claude & ChatGPT", "MCP connector setup"]
    ] }
  ];

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) { if (k === "text") n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function norm(p) { return p.replace(/index\.html$/, "").replace(/\/+$/, "") || "/"; }
  function isCurrent(href) {
    var u = new URL(href, location.href);
    if (norm(u.pathname) !== norm(location.pathname)) return false;
    var here = location.hash;
    if (u.hash) return u.hash === here || (u.hash === "#overview" && !here);
    /* The directory page also hosts Find services and Pathways (#tab-...). */
    if (norm(u.pathname) === "/") return !here || here === "#tab-directory" || here.indexOf("#tab-") !== 0;
    return true;
  }

  var groups = [];
  var nav = el("nav", { "class": "sm", id: "site-menu", "aria-label": "Site menu" });
  var inner = el("div", { "class": "sm-inner" }, [el("a", { "class": "sm-home", href: "/", text: "Lions Services · VISION360" })]);
  nav.appendChild(inner);

  MENUS.forEach(function (m) {
    var panelId = "sm-panel-" + m.id;
    var toggle = el("button", { type: "button", "class": "sm-toggle", "aria-expanded": "false", "aria-controls": panelId }, [
      document.createTextNode(m.label), el("span", { "class": "sm-caret", "aria-hidden": "true", text: "▾" })
    ]);
    var list = el("ul");
    m.items.forEach(function (it) {
      var a = el("a", { href: it[0] }, [document.createTextNode(it[1]), el("span", { "class": "sm-desc", text: it[2] })]);
      a.addEventListener("click", function () { setTimeout(function () { closeAll(); markCurrent(); }, 0); });
      list.appendChild(el("li", null, [a]));
    });
    var panel = el("div", { "class": "sm-panel", id: panelId, hidden: "" }, [m.note ? el("p", { "class": "sm-note", text: m.note }) : null, list]);
    var g = el("div", { "class": "sm-group" }, [toggle, panel]);
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      closeAll();
      if (!open) { toggle.setAttribute("aria-expanded", "true"); panel.hidden = false; }
    });
    g.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !panel.hidden) { ev.stopPropagation(); closeAll(); toggle.focus(); }
    });
    groups.push({ toggle: toggle, panel: panel, group: g });
    inner.appendChild(g);
  });

  function closeAll() { groups.forEach(function (x) { x.toggle.setAttribute("aria-expanded", "false"); x.panel.hidden = true; }); }
  function markCurrent() {
    [].forEach.call(nav.querySelectorAll(".sm-panel a"), function (a) {
      if (isCurrent(a.getAttribute("href"))) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }
  document.addEventListener("click", function (ev) { if (!nav.contains(ev.target)) closeAll(); });
  document.addEventListener("focusin", function (ev) { if (!nav.contains(ev.target)) closeAll(); });
  window.addEventListener("hashchange", markCurrent);
  markCurrent();

  function mount() {
    /* After the skip links, before everything else. */
    var skips = document.querySelectorAll("body > .skip-link");
    var after = skips.length ? skips[skips.length - 1] : null;
    if (after) after.insertAdjacentElement("afterend", nav); else document.body.insertBefore(nav, document.body.firstChild);
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
