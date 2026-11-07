/* Shared site menu: one bar at the top of every page with two tabs
   (Vision Assessment and Resource Assistant) and a ☰ "More" menu for
   everything else. The menu is a disclosure button: Enter/Space opens,
   Escape closes and returns focus, clicking elsewhere closes. Include with
   <link rel="stylesheet" href="/site-menu.css"> and <script src="/site-menu.js">. */
(function () {
  "use strict";
  var TABS = [
    ["/assessment/", "Vision Assessment"],
    ["/demo/", "Resource Assistant"]
  ];
  var MENUS = [
    { id: "more", label: "More", icon: true, items: [
      ["/", "Home", "What Vision 360 is and how to use it"],
      ["/directory/", "Org Directory", "Every organization, with search and filters"],
      ["/admin/", "Admin", "Staff sign-in"],
      ["/directory/#tab-quiz", "Find services", "Answer a few questions for suggestions"],
      ["/directory/#tab-pathways", "Pathways", "Common routes through services"],
      ["/guide.html", "How to use VISION360", "Step-by-step guide to every page"],
      ["/guide.html#privacy", "About and privacy", "What this demo saves and why"]
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
    if (norm(u.pathname) === "/directory") return !here || here === "#tab-directory" || here.indexOf("#tab-") !== 0;
    return true;
  }

  var groups = [];
  var nav = el("nav", { "class": "sm", id: "site-menu", "aria-label": "Site menu" });
  var here = norm(location.pathname);
  var onDemo = here.indexOf("/demo") === 0 || here.indexOf("/assessment") === 0 || here.indexOf("/screen-check") === 0 || here.indexOf("/f/") === 0 || here === "/" || here === "/index.html";
  /* Top corner: the official Lions Services | VISION 360 lockup on a white
     tile on the assistant pages (which have no logo strip); the eye and the
     name everywhere else. */
  var inner = el("div", { "class": "sm-inner" }, [el("a", { "class": "sm-home" + (onDemo ? " sm-home-logo" : ""), href: "/" }, onDemo ? [
    el("span", { "class": "sm-logo" }, [el("img", { src: "/brand/lions-services-vision-360.png", alt: "Lions Services | Vision 360", width: "720", height: "113" })])
  ] : [
    el("span", { "class": "sm-eye", "aria-hidden": "true" }, [el("img", { src: "/brand/eye.png", alt: "" })]),
    document.createTextNode("Lions Services · VISION 360")
  ])]);
  /* Official logo strip above the menu: CONNECT wordmark on the assistant, the
     Lions Services | VISION 360 lockup everywhere else. */
  var logoBar = el("div", { "class": "brand-bar" }, [el("div", { "class": "brand-bar-inner" }, [
    el("a", { href: "/" }, [onDemo
      ? el("img", { "class": "brand-bar-connect", src: "/brand/vision-360-connect.png", alt: "Vision 360 CONNECT", width: "720", height: "199" })
      : el("img", { src: "/brand/lions-services-vision-360.png", alt: "Lions Services | Vision 360", width: "720", height: "113" })])
  ])]);
  nav.appendChild(inner);

  TABS.forEach(function (t) {
    var a = el("a", { "class": "sm-link", href: t[0] }, [document.createTextNode(t[1])]);
    if (norm(t[0]) === here) a.setAttribute("aria-current", "page");
    inner.appendChild(a);
  });

  MENUS.forEach(function (m) {
    var panelId = "sm-panel-" + m.id;
    var toggle = el("button", { type: "button", "class": "sm-toggle" + (m.icon ? " sm-burger" : ""), "aria-expanded": "false", "aria-controls": panelId }, m.icon ? [
      el("span", { "class": "sm-bars", "aria-hidden": "true" }, [el("span"), el("span"), el("span")]), el("span", { "class": "sm-more-label", text: m.label })
    ] : [
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
    /* The assistant pages give the screen to the conversation: no logo strip. */
    if (!onDemo) nav.insertAdjacentElement("beforebegin", logoBar);
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  /* The screen settings check joins the ☰ menu once an admin switches it on. */
  if (!/^\/admin(\/|$)/.test(location.pathname)) fetch("/api/site", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
    if (!(j.features && j.features.screenCheck)) return;
    var ul = nav.querySelector("#sm-panel-more ul");
    if (!ul || ul.querySelector('a[href="/screen-check/"]')) return;
    var a = el("a", { href: "/screen-check/" }, [document.createTextNode("Screen settings check"), el("span", { "class": "sm-desc", text: "Find your best text size, colors and pointer" })]);
    var li = el("li", null, [a]);
    ul.insertBefore(li, ul.children[2] || null);
    markCurrent();
  }).catch(function () {});
})();
