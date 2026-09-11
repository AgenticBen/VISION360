/* =========================================================================
   Vision loss services — greater Charlotte, NC
   Everything on this page is rendered at runtime from data/organizations.json.
   No organization data lives in the markup. A correction is a JSON edit.
   ========================================================================= */
(function () {
  "use strict";

  var DATA_URL = "data/organizations.json";
  var GEO_URL  = "data/geography.json";
  var PATHS_URL = "data/pathways.json";
  var ASSESS_URL = "data/assessment.json";

  /* ---------------------------------------------------------------------
     Labels
     --------------------------------------------------------------------- */
  var CATEGORY_LABELS = {
    vision_rehab: "Vision rehabilitation",
    orientation_mobility: "Getting around safely",
    low_vision_clinic: "Low vision clinic",
    assistive_technology: "Assistive technology",
    employment: "Work and employment",
    education: "School and education",
    transportation: "Transport and rides",
    peer_support: "Peer support",
    recreation: "Recreation and sport",
    legal_advocacy: "Legal help and advocacy",
    condition_specific: "Condition specific",
    veterans: "Veterans",
    financial_assistance: "Financial help",
    library_reading: "Reading and libraries",
    guide_dogs: "Guide dogs",
    caregiver_support: "Family and caregivers",
    eye_care_access: "Getting eye care",
    deafblind: "Deaf-blind",
    housing: "Housing",
    other: "Other"
  };

  var AREA_LABELS = {
    in_area: "In area",
    partial: "Partly in area",
    statewide_travel_required: "Statewide — travel required",
    out_of_area: "Outside the area"
  };
  var AREA_ICONS = {
    in_area: "●",                     /* filled circle  */
    partial: "◐",                     /* half circle    */
    statewide_travel_required: "↗",   /* arrow          */
    out_of_area: "○"                  /* empty circle   */
  };
  var AREA_ORDER = { in_area: 0, partial: 1, statewide_travel_required: 2, out_of_area: 3 };

  var CONFIDENCE_ICONS = { high: "●●●", medium: "●●○", low: "●○○" };
  var CONFIDENCE_ORDER = { low: 0, medium: 1, high: 2 };

  var ACTOR_LABELS = { person: "The person", referrer: "You (referrer)", organization: "The organization" };

  var GAP_TEXT = "Not published — verification call required";

  /* ---------------------------------------------------------------------
     Tiny DOM helpers
     --------------------------------------------------------------------- */
  function el(tag, props, kids) {
    var n = document.createElement(tag), k;
    if (props) {
      for (k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k === "html") throw new Error("no innerHTML here");
        else if (k in n && k !== "list" && k !== "type" && k !== "form" && k !== "role") {
          try { n[k] = v; } catch (e) { n.setAttribute(k, v); }
        } else n.setAttribute(k, v === true ? "" : v);
      }
    }
    append(n, kids);
    return n;
  }
  function append(parent, kids) {
    if (kids === null || kids === undefined || kids === false) return parent;
    if (Array.isArray(kids)) { kids.forEach(function (c) { append(parent, c); }); return parent; }
    parent.appendChild(typeof kids === "string" ? document.createTextNode(kids) : kids);
    return parent;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------------
     Gaps — shown, never hidden, never replaced with a dash
     --------------------------------------------------------------------- */
  function isGap(s) {
    return typeof s === "string" && /not published|verification call required/i.test(s);
  }
  function gapBlock(text) {
    return el("p", { class: "gap" }, [
      el("span", { class: "gap-mark", "aria-hidden": "true" }, "!"),
      " ",
      text
    ]);
  }
  /* Any value: renders prose, flags it visibly when it is a known gap. */
  function valueNode(text, emptyMessage) {
    if (!text || !String(text).trim()) return gapBlock(emptyMessage || ("Nothing recorded. " + GAP_TEXT + "."));
    if (isGap(text)) return gapBlock(linkify(text));
    return el("p", null, linkify(text));
  }

  /* ---------------------------------------------------------------------
     Linkify: every phone becomes tel:, every email becomes mailto:
     --------------------------------------------------------------------- */
  var LINK_RE = new RegExp(
    "(https?:\\/\\/[^\\s<>()\\[\\]\"']+[^\\s<>()\\[\\]\"'.,;:!?])" +           /* url   */
    "|([A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,})" +                  /* email */
    "|((?:\\+?1[\\s.\\-])?(?:\\(\\d{3}\\)\\s?|\\d{3}[\\s.\\-])\\d{3}[\\s.\\-]\\d{4}(?:\\s*(?:x|ext\\.?)\\s*\\d{1,5})?)", /* phone */
    "g"
  );

  function telHref(raw) {
    var ext = null, base = raw;
    var m = raw.match(/(?:x|ext\.?)\s*(\d{1,5})\s*$/i);
    if (m) { ext = m[1]; base = raw.slice(0, m.index); }
    var digits = base.replace(/\D/g, "");
    if (digits.length === 10) digits = "1" + digits;
    return "tel:+" + digits + (ext ? ";ext=" + ext : "");
  }

  function linkify(text) {
    var frag = document.createDocumentFragment();
    if (text === null || text === undefined) return frag;
    var s = String(text), last = 0, m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(s)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      var token = m[0];
      if (m[1]) {
        /* The warning goes INSIDE the anchor. As a sibling it is not part of the
           link's accessible name, so a links list or link-by-link tabbing never
           surfaces it — only linear reading does. */
        frag.appendChild(el("a", { href: token, rel: "noopener noreferrer nofollow", target: "_blank" }, [
          token,
          el("span", { class: "visually-hidden" }, " (opens in a new tab)")
        ]));
      } else if (m[2]) {
        frag.appendChild(el("a", { href: "mailto:" + token, text: token }));
      } else {
        frag.appendChild(el("a", { href: telHref(token), text: token }));
      }
      last = m.index + token.length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    return frag;
  }

  /* ---------------------------------------------------------------------
     Derived values
     --------------------------------------------------------------------- */
  /* "Can start within about two weeks", derived from typical_wait prose.
     Derived, not published — the UI says so wherever this is used. */
  var FAST_RE = /\b(same day|same week|immediate(ly)?|walk[- ]?in|on demand|next (scheduled|weekly|weeks?)|no waitlist|no waiting list|within (a|one|1|two|2) weeks?|1[-–]2 weeks|days\b|less than 1 week|instant)/i;
  var SLOW_RE = /\b(\d+\s*(?:to\s*\d+\s*)?(?:months?|years?)|several months|\d{2,}\s*(?:calendar\s*)?days|waitlist|waiting list|paused|seasonal|between seasons|annual|next summer|not currently accepting)/i;
  var NEGATED_RE = /\bno (?:waitlist|waiting list|intake)\b/gi;

  function canStartSoon(org) {
    var w = org.typical_wait || "";
    if (isGap(w)) return false;
    /* "no waitlist" must not read as "waitlist". */
    var normalized = w.replace(NEGATED_RE, "");
    return FAST_RE.test(w) && !SLOW_RE.test(normalized);
  }

  function shortWait(org) {
    var w = org.typical_wait || "";
    if (!w.trim()) return { gap: true, text: "Wait: not recorded" };
    if (isGap(w)) return { gap: true, text: "Wait: not published" };
    return { gap: false, text: "Wait: " + truncate(w, 52) };
  }

  function truncate(s, n) {
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length <= n ? s : s.slice(0, n - 1).replace(/[\s,;.:—-]+$/, "") + "…";
  }

  /* ---------------------------------------------------------------------
     State
     --------------------------------------------------------------------- */
  var ORGS = [];
  var BY_ID = {};
  var SEARCH_INDEX = {};
  var expanded = Object.create(null);
  var built = Object.create(null);

  var state = {
    q: "",
    categories: [],
    areas: [],
    confidence: [],
    thirdParty: false,
    soon: false,
    research: false,
    /* "Mecklenburg first" is the default: the project lead named it the focus.
       It is an ORDERING, never a filter — see geoTier(). */
    sort: "meck"
  };

  /* ---------------------------------------------------------------------
     Settings (text size + high contrast), persisted defensively
     --------------------------------------------------------------------- */
  var STORE_KEY = "vrd-display-v1";
  function readSettings() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function writeSettings(s) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* private mode: ignore */ }
  }
  function applySettings(s) {
    var size = (s && (s.textsize === "125" || s.textsize === "150")) ? s.textsize : "100";
    var hc = !!(s && s.contrast === "high");
    document.documentElement.setAttribute("data-textsize", size);
    document.documentElement.setAttribute("data-contrast", hc ? "high" : "normal");
    Array.prototype.forEach.call(document.querySelectorAll("#textsize-group .seg-btn"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-size") === size ? "true" : "false");
    });
    $("contrast-toggle").setAttribute("aria-pressed", hc ? "true" : "false");
  }
  function initSettings() {
    var s = readSettings();
    applySettings(s);
    Array.prototype.forEach.call(document.querySelectorAll("#textsize-group .seg-btn"), function (b) {
      b.addEventListener("click", function () {
        var next = readSettings(); next.textsize = b.getAttribute("data-size");
        writeSettings(next); applySettings(next);
        announce("Text size " + next.textsize + " percent.");
      });
    });
    $("contrast-toggle").addEventListener("click", function () {
      var next = readSettings();
      next.contrast = next.contrast === "high" ? "normal" : "high";
      writeSettings(next); applySettings(next);
      announce("High contrast " + (next.contrast === "high" ? "on" : "off") + ".");
    });
  }

  /* "Collapse all open" is dead when nothing is open. Kept in sync from both
     render() and the disclosure toggle, which does not re-render. */
  /* ---------------------------------------------------------------------
     Tabs

     Three views of ONE dataset, so this is a real tablist rather than three
     aria-pressed toggles: a screen reader should say "Pathways, tab, 2 of 3,
     selected", not announce three unrelated buttons with no relationship
     between them.

     THE TRADEOFF, recorded deliberately. qa/accessibility.md item 10 certified
     that this file registered NO key handlers at all, and used that to argue a
     keyboard trap was structurally impossible. The listener below ends that
     claim, so it is written to be trivially auditable:
       - bound to the tablist element only, never to the document;
       - a closed allow-list of four keys;
       - preventDefault() ONLY inside that list;
       - Tab and Shift+Tab are never touched, so focus can always leave.
     If a fifth key is ever added here, item 10 must be re-verified.
     --------------------------------------------------------------------- */
  var TABS = ["directory", "pathways", "quiz"];
  var TAB_LABELS = { directory: "Directory", pathways: "Pathways", quiz: "Find services" };
  var activeTab = "directory";

  function tabBtn(name) { return $("tab-" + name); }
  function tabPanel(name) { return $("panel-" + name); }

  /* moveFocus: true when the user asked for a destination (a deep link, a skip
     link, a branch jump) rather than for the tab itself. Arrow keys and clicks
     leave focus on the tab button, per the APG. */
  function showTab(name, moveFocus) {
    if (TABS.indexOf(name) === -1 || name === activeTab) {
      if (name === activeTab && moveFocus) tabPanel(name).focus();
      return;
    }
    activeTab = name;
    TABS.forEach(function (t) {
      var b = tabBtn(t), p = tabPanel(t), on = (t === name);
      if (!b || !p) return;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      p.hidden = !on;
    });
    if (moveFocus) tabPanel(name).focus();
    return true;
  }

  /* Honest placeholder. An empty panel reads as a bug; this says what is
     coming and keeps the Directory usable meanwhile. Replaced wholesale when
     the real views land. */
  function placeholder(root, title, body) {
    var host = $(root);
    if (!host) return;
    clear(host);
    host.appendChild(el("div", { class: "not-built" }, [
      el("h3", null, title),
      el("p", null, body),
      (function () {
        var b = el("button", { type: "button", class: "btn btn-quiet" }, "Back to the directory");
        b.addEventListener("click", function () {
          if (showTab("directory", true)) announce("Directory view.");
        });
        return b;
      })()
    ]));
  }

  function initTabs() {
    var list = $("views");
    if (!list) return;

    placeholder("pathways-root", "Pathways is not built yet",
      "This view will show how the 96 organizations refer people to each other, drawn from the referral steps already in the data, with a county map for the ones that have an address. Everything in it is in the Directory today.");
    placeholder("quiz-root", "Find services is not built yet",
      "This view will ask a short set of questions, based on the Lions Services intake assessment, and narrow the directory down to the organizations that fit. Until then, the Directory filters do the same job with more clicks.");

    TABS.forEach(function (t) {
      var b = tabBtn(t);
      if (!b) return;
      b.addEventListener("click", function () {
        if (showTab(t, false)) announce(TAB_LABELS[t] + " view.");
      });
    });

    list.addEventListener("keydown", function (ev) {
      var key = ev.key;
      if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
      var i = TABS.indexOf(activeTab);
      var next = i;
      if (key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
      else if (key === "ArrowRight") next = (i + 1) % TABS.length;
      else if (key === "Home") next = 0;
      else next = TABS.length - 1;
      if (next === i) return;
      ev.preventDefault();              /* only ever inside the allow-list */
      showTab(TABS[next], false);
      tabBtn(TABS[next]).focus();       /* focus follows the tab, not the panel */
      announce(TAB_LABELS[TABS[next]] + " view.");
    });

    /* Skip links point at content that now lives inside a panel. The view has
       to give way so the target is never unreachable — the same principle
       jumpTo() already applies to filters. */
    var toDirectory = ["results", "filters"];
    [].slice.call(document.querySelectorAll(".skip-link")).forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var id = href.slice(1);
      if (toDirectory.indexOf(id) === -1) return;
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        var switched = showTab("directory", false);
        var target = $(id);
        if (target) { target.focus(); target.scrollIntoView({ block: "start" }); }
        if (switched) announce("Directory view. Moved to " + (id === "results" ? "the organization list." : "filters."));
      });
    });
  }

  /* =====================================================================
     PATHWAYS — the referral graph, as a picture and as a list

     The list IS the diagram. flowchart() established the pattern and
     qa/accessibility.md item 14 verified it: build ONE model, render it twice,
     and the visual can never drift from the text because neither is derived
     from the other.

     Nothing focusable ever goes inside the <svg>. Focus rings clip
     unpredictably inside a transformed viewBox, and item 9 certifies a visible
     ring on every focusable element. Mouse users click a transparent hit area
     that calls .click() on the real button in the list, so there is exactly one
     code path and one source of truth.
     ===================================================================== */
  var PATHWAYS = null;          /* data/pathways.json */
  var GRAPH = null;             /* { nodes, edges, byGroup, inDeg, outDeg } */
  var focusId = null;           /* selected node, or null for the overview */
  var zoom = 1;                 /* 1.0 to 3.0, never below — see below */

  var SVG_NS = "http://www.w3.org/2000/svg";

  /* el() uses createElement and cannot make SVG nodes. Same guard rails. */
  function svgEl(tag, props, kids) {
    var n = document.createElementNS(SVG_NS, tag), k;
    if (props) {
      for (k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "html") throw new Error("no innerHTML here");
        n.setAttribute(k, v === true ? "" : v);
      }
    }
    if (kids !== null && kids !== undefined) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return n;
  }

  /* A record usually carries several categories and genuinely belongs to more
     than one group: MAB Vision Rehabilitation Services is both rehabilitation
     and assistive technology, and someone browsing either should find it.
     Forcing a single home made that a coin-flip — with one priority order the
     Veterans group held 2 of its 17 records, with another the rehabilitation
     group held 2 of its 19. So a record appears under EVERY group it matches,
     and the page says so. Group totals therefore sum to more than 96, which is
     the truth rather than an artefact. */
  function groupsOf(org) {
    if (!PATHWAYS) return [];
    var cats = org.categories || [];
    var out = [];
    (PATHWAYS.groups || []).forEach(function (g) {
      for (var j = 0; j < cats.length; j++) {
        if ((g.categories || []).indexOf(cats[j]) !== -1) { out.push(g.id); return; }
      }
    });
    if (!out.length && PATHWAYS.unassigned_group) out.push(PATHWAYS.unassigned_group);
    return out;
  }

  function buildGraph() {
    if (!PATHWAYS) return null;
    var nodes = {}, edges = [], inDeg = {}, outDeg = {}, byGroup = {};

    ORGS.forEach(function (o) {
      var gs = groupsOf(o);
      nodes[o.id] = { id: o.id, name: o.name, groups: gs, org: o };
      inDeg[o.id] = 0; outDeg[o.id] = 0;
      gs.forEach(function (g) { (byGroup[g] = byGroup[g] || []).push(o.id); });
    });

    /* Edges come straight from the verified access paths. Nothing is inferred:
       an edge exists only where a human recorded a branch pointing at a record
       that still exists. */
    ORGS.forEach(function (o) {
      (o.access_path || []).forEach(function (step) {
        (step.branches || []).forEach(function (b) {
          if (!b.goto_org_id || !nodes[b.goto_org_id]) return;
          if (b.goto_org_id === o.id) return;                 /* self-loop */
          edges.push({ from: o.id, to: b.goto_org_id, condition: b.condition || "", note: b.note || "" });
          outDeg[o.id]++; inDeg[b.goto_org_id]++;
        });
      });
    });

    Object.keys(byGroup).forEach(function (g) {
      byGroup[g].sort(function (a, b) {
        var d = (GEO ? geoRank(nodes[a].org) - geoRank(nodes[b].org) : 0);
        if (d) return d;
        return nodes[a].name.localeCompare(nodes[b].name);
      });
    });

    return { nodes: nodes, edges: edges, inDeg: inDeg, outDeg: outDeg, byGroup: byGroup };
  }

  function edgesFrom(id) { return GRAPH.edges.filter(function (e) { return e.from === id; }); }
  function edgesTo(id)   { return GRAPH.edges.filter(function (e) { return e.to === id; }); }

  function groupById(id) {
    var gs = (PATHWAYS && PATHWAYS.groups) || [];
    for (var i = 0; i < gs.length; i++) if (gs[i].id === id) return gs[i];
    return null;
  }

  /* A node button. Selecting it focuses the lens; the separate directory link
     hands off to jumpTo(), which switches tab and clears filters as needed. */
  var usedNodeIds = null;    /* reset per render; the DOM is detached while building */
  function nodeButton(id, extraClass) {
    var n = GRAPH.nodes[id];
    var deg = GRAPH.inDeg[id];
    /* A record can appear in several groups, so ids must stay unique. The tree
       is still detached while it is built, so getElementById would always miss —
       track what has been issued instead. The FIRST button rendered keeps the
       canonical id, which is the one focus returns to. */
    var domId = "node-btn-" + id;
    if (usedNodeIds[domId]) {
      var k = 2;
      while (usedNodeIds["node-btn-" + id + "-" + k]) k++;
      domId = "node-btn-" + id + "-" + k;
    }
    usedNodeIds[domId] = true;
    var b = el("button", {
      type: "button",
      class: "node-btn" + (extraClass ? " " + extraClass : "") + (focusId === id ? " is-focused" : ""),
      id: domId,
      "aria-pressed": focusId === id ? "true" : "false"
    }, [
      el("span", { class: "node-name" }, n.name),
      deg ? el("span", { class: "node-deg" }, [
        el("span", { "aria-hidden": "true" }, "← "),
        String(deg) + (deg === 1 ? " organization sends people here" : " organizations send people here")
      ]) : null
    ]);
    b.addEventListener("click", function () {
      focusId = (focusId === id) ? null : id;
      renderPathways();
      var again = $("node-btn-" + id);
      if (again) again.focus();
      /* if the canonical button is gone (focus view), the heading takes focus */
      announce(focusId ? ("Showing referral routes for " + n.name + ".") : "Showing all groups.");
    });
    return b;
  }

  function directoryLink(id) {
    var b = el("button", { type: "button", class: "btn btn-quiet btn-sm" },
      "Open in the directory");
    b.addEventListener("click", function () { jumpTo(id); });
    return b;
  }

  /* ---- the text layer: the truth ---- */
  function pathwaysTextLayer() {
    var wrapEl = el("div", { class: "pw-text" });

    if (!focusId) {
      (PATHWAYS.groups || []).forEach(function (g) {
        var ids = GRAPH.byGroup[g.id] || [];
        if (!ids.length) return;                    /* never draw an empty district */
        var hubs = ids.slice().sort(function (a, b) { return GRAPH.inDeg[b] - GRAPH.inDeg[a]; })
                      .filter(function (i) { return GRAPH.inDeg[i] > 0; }).slice(0, 2);
        wrapEl.appendChild(el("section", { class: "pw-group" }, [
          el("h3", null, [
            el("span", { class: "pw-ico", "aria-hidden": "true" }, iconSvg(g.icon)),
            g.label,
            el("span", { class: "pw-count" }, " (" + ids.length + ")")
          ]),
          el("p", { class: "hint" }, g.blurb),
          hubs.length ? el("p", { class: "hint" }, "Most referred to here: " +
            hubs.map(function (i) { return GRAPH.nodes[i].name; }).join(", ") + ".") : null,
          el("ul", { class: "pw-list", role: "list" },
            ids.map(function (i) { return el("li", null, nodeButton(i)); }))
        ]));
      });
      return wrapEl;
    }

    /* Focus lens */
    var n = GRAPH.nodes[focusId];
    var out = edgesFrom(focusId), inc = edgesTo(focusId);

    function edgeList(list, emptyMsg, dir) {
      if (!list.length) return el("p", { class: "hint" }, emptyMsg);
      return el("ul", { class: "pw-edges", role: "list" }, list.map(function (e) {
        var otherId = dir === "out" ? e.to : e.from;
        var other = GRAPH.nodes[otherId];
        return el("li", null, [
          /* The condition VERBATIM — the same string flowchart() renders, so the
             two views of one fact read identically. */
          el("p", { class: "pw-cond" }, [
            el("span", { class: "pw-when" }, "When: "),
            e.condition || "(no condition recorded)"
          ]),
          el("p", { class: "pw-target" }, [
            el("span", { "aria-hidden": "true" }, dir === "out" ? "→ " : "← "),
            dir === "out" ? "Goes to " : "Comes from ",
            el("strong", null, other.name)
          ]),
          e.note ? el("p", { class: "hint" }, e.note) : null,
          nodeButton(otherId, "node-btn-inline")
        ]);
      }));
    }

    var back = el("button", { type: "button", class: "btn btn-quiet" }, "Show all groups");
    back.addEventListener("click", function () {
      focusId = null; renderPathways();
      var h = $("pw-focus-heading"); if (h) h.focus();
      announce("Showing all groups.");
    });

    wrapEl.appendChild(el("section", { class: "pw-focus" }, [
      back,
      el("h3", { id: "pw-focus-heading", tabindex: "-1" }, n.name),
      el("p", null, n.org.one_line || ""),
      directoryLink(focusId),
      el("h4", null, "Sends people to (" + out.length + ")"),
      edgeList(out, "This record does not route anyone onward.", "out"),
      el("h4", null, "Receives people from (" + inc.length + ")"),
      edgeList(inc, "No other record routes people here.", "in")
    ]));
    return wrapEl;
  }

  function iconSvg(path) {
    return svgEl("svg", {
      viewBox: "0 0 24 24", width: "1em", height: "1em",
      fill: "none", stroke: "currentColor", "stroke-width": "2",
      "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true", focusable: "false"
    }, svgEl("path", { d: path }));
  }

  /* ---- the picture: an enhancement, never the source ----
     Geometry is arithmetic. Districts sit on a plain grid; the focus lens is
     polar. No physics, no iteration, no library — there are no dependencies
     here and there will not be. */
  var VB_W = 1000, VB_H = 600;

  function pathwaysSvg() {
    var kids = [];

    if (!focusId) {
      var groups = (PATHWAYS.groups || []).filter(function (g) { return (GRAPH.byGroup[g.id] || []).length; });
      var cols = groups.length > 6 ? 3 : 2;
      var cw = VB_W / cols, rows = Math.ceil(groups.length / cols), ch = VB_H / rows;
      groups.forEach(function (g, i) {
        var cx = (i % cols) * cw + cw / 2, cy = Math.floor(i / cols) * ch + ch / 2;
        var count = (GRAPH.byGroup[g.id] || []).length;
        var r = 26 + Math.min(count, 20) * 1.6;
        kids.push(svgEl("circle", { cx: cx, cy: cy, r: r, fill: "var(--accent-wash)", stroke: "var(--accent)", "stroke-width": "2" }));
        kids.push(svgEl("text", { x: cx, y: cy + 6, "text-anchor": "middle", fill: "var(--accent)", "font-size": "26", "font-weight": "700" }, String(count)));
        kids.push(svgEl("text", { x: cx, y: cy + r + 26, "text-anchor": "middle", fill: "var(--ink)", "font-size": "19" }, g.label));
      });
    } else {
      var out = edgesFrom(focusId), inc = edgesTo(focusId);
      var cx = VB_W / 2, cy = VB_H / 2;
      var DRAW_CAP = 12;

      function ring(list, radius, dir) {
        var shown = list.slice(0, DRAW_CAP);
        shown.forEach(function (e, k) {
          var a = (-90 + k * 360 / shown.length) * Math.PI / 180;
          var x = cx + radius * Math.cos(a), y = cy + radius * Math.sin(a);
          kids.push(svgEl("line", {
            x1: cx, y1: cy, x2: x, y2: y,
            stroke: "var(--line)", "stroke-width": "2",
            "stroke-dasharray": dir === "in" ? "6 4" : null
          }));
          kids.push(svgEl("circle", { cx: x, cy: y, r: 30, fill: "var(--surface)", stroke: "var(--line)", "stroke-width": "2" }));
          var nm = GRAPH.nodes[dir === "out" ? e.to : e.from].name;
          kids.push(svgEl("text", { x: x, y: y + 48, "text-anchor": "middle", fill: "var(--ink)", "font-size": "18" },
            nm.length > 26 ? nm.slice(0, 25) + "…" : nm));
        });
      }
      ring(out, 190, "out");
      ring(inc, 265, "in");
      kids.push(svgEl("circle", { cx: cx, cy: cy, r: 46, fill: "var(--accent)", stroke: "var(--accent)", "stroke-width": "2" }));
      var fname = GRAPH.nodes[focusId].name;
      kids.push(svgEl("text", { x: cx, y: cy + 7, "text-anchor": "middle", fill: "var(--accent-ink)", "font-size": "20", "font-weight": "700" },
        fname.length > 18 ? fname.slice(0, 17) + "…" : fname));
    }

    var vbw = VB_W / zoom, vbh = VB_H / zoom;
    var svg = svgEl("svg", {
      class: "pw-svg",
      viewBox: [(VB_W - vbw) / 2, (VB_H - vbh) / 2, vbw, vbh].join(" "),
      preserveAspectRatio: "xMidYMid meet",
      /* The whole picture is decoration. Everything it shows is in the list
         below it, in words, in the same order. */
      "aria-hidden": "true",
      focusable: "false"
    }, kids);
    return svg;
  }

  function zoomControls() {
    function zbtn(label, fn, hint) {
      var b = el("button", { type: "button", class: "btn btn-quiet btn-sm" }, label);
      b.addEventListener("click", function () { fn(); renderPathways(); announce(hint); });
      return b;
    }
    return el("div", { class: "pw-zoom" }, [
      el("span", { class: "inline-label" }, "Diagram"),
      /* Zoom IN only. Zooming out shrinks the viewBox scale and would push the
         labels below the project's 18px floor, so it is not offered. */
      zbtn("Magnify", function () { zoom = Math.min(3, +(zoom + 0.5).toFixed(1)); },
        "Diagram magnified to " + Math.min(3, zoom + 0.5) + " times."),
      zbtn("Shrink", function () { zoom = Math.max(1, +(zoom - 0.5).toFixed(1)); },
        "Diagram back to " + Math.max(1, zoom - 0.5) + " times."),
      el("span", { class: "hint" }, "The picture repeats what the list below already says. It magnifies but never shrinks below readable size.")
    ]);
  }

  /* ---- county cartogram ---- */
  function countyMap() {
    var cfg = PATHWAYS.county_map;
    if (!cfg || !GEO) return null;
    var counts = {};
    ORGS.forEach(function (o) {
      ((o.service_area || {}).counties || []).forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
    });
    var noCounty = ORGS.filter(function (o) { return !(((o.service_area || {}).counties) || []).length; }).length;

    var cellW = 1000 / cfg.cols, cellH = 520 / cfg.rows;
    var tiles = cfg.tiles.map(function (t) {
      var x = t.col * cellW + 8, y = t.row * cellH + 8, w = cellW - 16, h = cellH - 16;
      var home = (t.county === GEO.home_county);
      var n = counts[t.county] || 0;
      return svgEl("g", null, [
        svgEl("rect", { x: x, y: y, width: w, height: h, rx: 8,
          fill: home ? "var(--accent)" : "var(--surface-2)",
          stroke: home ? "var(--accent)" : "var(--line)", "stroke-width": "2" }),
        svgEl("text", { x: x + w / 2, y: y + h / 2 - 4, "text-anchor": "middle",
          fill: home ? "var(--accent-ink)" : "var(--ink)", "font-size": "19", "font-weight": home ? "700" : "400" }, t.county),
        svgEl("text", { x: x + w / 2, y: y + h / 2 + 22, "text-anchor": "middle",
          fill: home ? "var(--accent-ink)" : "var(--ink-muted)", "font-size": "18" }, String(n))
      ]);
    });

    var rows = cfg.tiles.slice().sort(function (a, b) { return (counts[b.county] || 0) - (counts[a.county] || 0); });

    return el("section", { class: "pw-map" }, [
      el("h3", null, "Which counties these organizations name"),
      el("p", { class: "hint" }, cfg.caption),
      svgEl("svg", { class: "pw-svg", viewBox: "0 0 1000 520", preserveAspectRatio: "xMidYMid meet",
        "aria-hidden": "true", focusable: "false" }, tiles),
      /* The table is the real artifact. The tiles are a glance. */
      el("ul", { class: "pw-counties", role: "list" }, rows.map(function (t) {
        return el("li", null, [
          el("strong", null, t.county),
          ": " + (counts[t.county] || 0) + " organization" + ((counts[t.county] || 0) === 1 ? "" : "s") +
          (t.county === GEO.home_county ? " — the county this directory focuses on" : "")
        ]);
      })),
      el("p", { class: "gap" }, [
        el("span", { class: "gap-mark", "aria-hidden": "true" }, "!"),
        " " + noCounty + " of " + ORGS.length + " organizations name no county at all. Most are statewide or national " +
        "services you reach by phone or online — several of them the fastest help available, with nothing to visit. " +
        "A map is the wrong tool for finding those, so use the Directory or Find services instead."
      ])
    ]);
  }

  function renderPathways() {
    var root = $("pathways-root");
    if (!root) return;
    clear(root);
    usedNodeIds = Object.create(null);

    if (!PATHWAYS || !GRAPH) {
      placeholder("pathways-root", "Pathways could not load",
        "The grouping file did not load, so this view is unavailable. The Directory is unaffected.");
      return;
    }

    append(root, [
      el("h2", { class: "visually-hidden" }, "Pathways"),
      el("p", { class: "lede" },
        "How these organizations send people to each other. Every route below is a referral step recorded in the data, " +
        "shown in the organization's own words. Select any organization to see what it leads to and what leads to it. " +
        "Many appear in more than one group, because they do more than one thing."),
      zoomControls(),
      pathwaysSvg(),
      pathwaysTextLayer(),
      countyMap()
    ]);
  }

  /* =====================================================================
     FIND SERVICES — the assessment, rendered

     All logic lives in quiz-engine.js and all branching in
     site/data/assessment.json, because Lions Services is building a voice
     agent that runs this same assessment over the phone. This function only
     draws; it decides nothing.

     PRIVACY. Answers are held in memory and never persisted — not to
     localStorage, not anywhere. This page is unlisted, not private, and the
     everyday block asks about a real person's housing, food and legal
     situation. The panel says so, in words, before the first question.
     ===================================================================== */
  var ASSESS = null;        /* site/data/assessment.json */
  var QUIZ = null;          /* engine state */
  var quizDone = false;

  function QE() { return (typeof VisionAssessment !== "undefined") ? VisionAssessment : null; }

  function quizReset() {
    var E = QE();
    if (!E || !ASSESS) return;
    QUIZ = E.create(ASSESS);
    quizDone = false;
  }

  function optionControl(q, opt) {
    var multi = (q.type === "multi");
    var name = "q-" + q.id;
    var id = "opt-" + q.id + "-" + opt.value;
    var current = QUIZ.answers[q.id];
    var checked = multi
      ? (Array.isArray(current) && current.indexOf(opt.value) !== -1)
      : current === opt.value;

    var input = el("input", {
      type: multi ? "checkbox" : "radio",
      name: name, id: id, value: opt.value, checked: checked
    });
    input.addEventListener("change", function () {
      var E = QE();
      if (multi) {
        var vals = Array.isArray(QUIZ.answers[q.id]) ? QUIZ.answers[q.id].slice() : [];
        var at = vals.indexOf(opt.value);
        if (input.checked && at === -1) vals.push(opt.value);
        if (!input.checked && at !== -1) vals.splice(at, 1);
        E.answer(QUIZ, q.id, vals);
      } else {
        E.answer(QUIZ, q.id, opt.value);
      }
      renderQuiz();
    });

    /* Reuses .check, which the audit already measured at >=24px target size.
       Do not invent a new option control. */
    return el("div", { class: "check" }, [
      input,
      el("label", { "for": id }, opt.label_screen || opt.label_voice || opt.value)
    ]);
  }

  function quizQuestionCard(q) {
    var E = QE();
    var b = E.blockOf(QUIZ, q.id);
    var p = E.progress(QUIZ);

    return el("div", { class: "quiz-card" }, [
      el("p", { class: "quiz-step" }, "Question " + (p.answered + 1) + " of about " + p.askable),
      b && b.preamble ? el("div", { class: "quiz-preamble" }, [
        el("p", null, b.preamble),
        b.skippable_as_block ? (function () {
          var sk = el("button", { type: "button", class: "btn btn-quiet" }, "Skip these questions");
          sk.addEventListener("click", function () {
            E.skipBlock(QUIZ, b.id, true);
            renderQuiz();
            announce("Skipped the " + (b.title || b.id) + " questions.");
          });
          return sk;
        })() : null
      ]) : null,
      el("fieldset", { class: "quiz-q" }, [
        el("legend", null, q.prompt_screen || q.prompt_voice),
        q.help ? el("p", { class: "hint" }, q.help) : null,
        el("div", { class: "checks" }, (q.options || []).map(function (o) { return optionControl(q, o); })),
        q.type === "multi" ? el("p", { class: "hint" }, "Choose as many as apply.") : null
      ]),
      (function () {
        var row = el("div", { class: "quiz-actions" });
        if (q.type === "multi" || q.skippable !== false) {
          var next = el("button", { type: "button", class: "btn" },
            q.type === "multi" ? "Next" : "Skip this question");
          next.addEventListener("click", function () {
            if (!Object.prototype.hasOwnProperty.call(QUIZ.answers, q.id)) {
              E.answer(QUIZ, q.id, q.type === "multi" ? [] : "__skipped__");
            }
            renderQuiz();
          });
          row.appendChild(next);
        }
        var seeAll = el("button", { type: "button", class: "btn btn-quiet" }, "Stop and show results now");
        seeAll.addEventListener("click", function () { quizDone = true; renderQuiz(); });
        row.appendChild(seeAll);
        return row;
      })()
    ]);
  }

  function resultCard(entry, rank) {
    var o = entry.org;
    var why = entry.reasons.filter(function (r) { return r.weight > 0; });

    return el("li", { class: "quiz-result" }, [
      el("h4", null, [el("span", { class: "rank" }, "#" + rank + " "), o.name]),
      el("p", null, o.one_line || ""),
      badgeList(o),
      /* Why, quoting the reason back. The phone agent will say this aloud. */
      why.length ? el("div", { class: "quiz-why" }, [
        el("p", { class: "quiz-why-head" }, "Why this one:"),
        el("ul", { role: "list" }, why.slice(0, 4).map(function (r) {
          return el("li", null, r.text);
        }))
      ]) : null,
      /* Quality, stated rather than implied. 52 of 96 records are unverified. */
      entry.needs_research ? gapBlock(
        "We have not confirmed this record with the organization yet. Call before you send anyone.") : null,
      /* What they say about who qualifies — the user asked for "what the
         organizations look for", and this is it, verbatim and unstructured. */
      (o.who_qualifies || []).length ? el("details", { class: "quiz-qual" }, [
        el("summary", null, "What they say about who qualifies — read this before you call"),
        el("ul", { role: "list" }, o.who_qualifies.map(function (w) { return el("li", null, w); }))
      ]) : null,
      o.accepts_third_party_referral === "no" ? el("p", { class: "quiz-note" },
        "The person has to make contact themselves. This organization does not take referrals from anyone else.") :
      o.accepts_third_party_referral === "unclear" ? el("p", { class: "quiz-note" },
        "We could not confirm whether someone can refer on this person's behalf. Ask when you call.") : null,
      (function () { var b = directoryLink(o.id); return b; })()
    ]);
  }

  function quizResults() {
    var E = QE();
    var ranked = E.score(QUIZ, ORGS, GEO ? geoRank : null);
    var hits = ranked.filter(function (r) { return r.points > 0; });
    var top = hits.slice(0, 8);
    var handoffs = E.handoffs(QUIZ);

    var out = [el("h3", { id: "quiz-results-heading", tabindex: "-1" }, "What might fit")];

    if (!top.length) {
      out.push(el("p", null,
        "Nothing scored, which usually means too few questions were answered. Nothing has been ruled out — every organization is still in the Directory."));
    } else {
      var flagged = top.filter(function (t) { return t.needs_research; }).length;
      out.push(el("p", null,
        "These are ordered by how well they match the answers, then by how close they are. " +
        "Nothing has been ruled out: all " + ORGS.length + " organizations are still in the Directory."));
      if (flagged === top.length) {
        out.push(gapBlock("Every suggestion below is a record we have not yet confirmed with the organization. Treat all of them as leads to check, not as answers."));
      }
      out.push(el("ol", { class: "quiz-results", role: "list" },
        top.map(function (t, i) { return resultCard(t, i + 1); })));

      var rest = hits.length - top.length;
      if (rest > 0) {
        out.push(el("details", { class: "quiz-more" }, [
          el("summary", null, "Show the other " + rest + " that matched, in the same order"),
          el("ol", { class: "quiz-results", role: "list" },
            hits.slice(8).map(function (t, i) { return resultCard(t, i + 9); }))
        ]));
      }
    }

    /* The honest dead ends. These carry no score because there is nothing in
       this directory to score — saying so is the whole point. */
    if (handoffs.length) {
      out.push(el("section", { class: "quiz-handoffs" }, [
        el("h3", null, "Things this directory cannot help with"),
        el("p", { class: "hint" },
          "You told us about needs that matter, and we have nothing verified to offer for them. Rather than guess, here is what we know."),
        el("ul", { role: "list" }, handoffs.map(function (h) {
          return el("li", { class: "handoff" }, [
            el("h4", null, h.headline),
            el("p", null, h.body || ""),
            (h.refer_to || []).map(function (id) {
              var o = BY_ID[id];
              if (!o) return null;
              return el("p", null, [
                el("strong", null, o.name), ": ",
                linkify(o.contacts && o.contacts.general_phone ? o.contacts.general_phone : ""),
                " ", (function () { var b = directoryLink(id); return b; })()
              ]);
            }),
            h.missing_record_note ? gapBlock(h.missing_record_note) : null
          ]);
        }))
      ]));
    }

    var again = el("button", { type: "button", class: "btn" }, "Start again");
    again.addEventListener("click", function () {
      quizReset(); renderQuiz();
      announce("Assessment cleared. Starting again.");
    });
    out.push(el("div", { class: "quiz-actions" }, again));
    return out;
  }

  function renderQuiz() {
    var root = $("quiz-root");
    if (!root) return;
    var E = QE();

    if (!ASSESS || !E) {
      placeholder("quiz-root", "Find services is unavailable",
        "The question set did not load, so this view cannot run. The Directory is unaffected and every organization is still there.");
      var t = $("tab-quiz");
      if (t) { t.disabled = true; t.setAttribute("aria-disabled", "true"); }
      return;
    }
    if (!QUIZ) quizReset();

    clear(root);
    var q = quizDone ? null : E.nextQuestion(QUIZ);

    append(root, [
      el("h2", { class: "visually-hidden" }, "Find services"),
      el("p", { class: "lede" }, ASSESS.intro || ""),
      /* Said before anything is typed, not buried at the end. */
      el("p", { class: "quiz-privacy" }, [
        el("span", { class: "gap-mark", "aria-hidden": "true" }, "!"),
        " ",
        ASSESS.privacy_notice ||
        "Nothing you enter here is saved or sent anywhere. Do not enter a real person's details."
      ]),
      q ? quizQuestionCard(q) : quizResults()
    ]);

    if (!q && !quizDone) quizDone = true;
    var h = $("quiz-results-heading");
    if (h && quizDone) { h.focus(); }
  }

  function syncCollapseAll() {
    var b = $("collapse-all");
    if (b) b.disabled = !Object.keys(expanded).length;
  }

  function announce(msg) {
    var a = $("announce");
    a.textContent = "";
    window.setTimeout(function () { a.textContent = msg; }, 30);
  }

  /* ---------------------------------------------------------------------
     Filter rail
     --------------------------------------------------------------------- */
  function countBy(fn) {
    var out = {};
    ORGS.forEach(function (o) {
      var keys = fn(o);
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
        if (k === null || k === undefined) return;
        out[k] = (out[k] || 0) + 1;
      });
    });
    return out;
  }

  function checkbox(id, label, count, group, value) {
    var input = el("input", { type: "checkbox", id: id, value: value });
    input.setAttribute("data-group", group);
    input.addEventListener("change", function () {
      var list = state[group];
      if (input.checked) { if (list.indexOf(value) === -1) list.push(value); }
      else { var i = list.indexOf(value); if (i > -1) list.splice(i, 1); }
      render();
    });
    return el("label", { class: "check", "for": id }, [
      input,
      el("span", null, [label, count === null ? null : el("span", { class: "count" }, " (" + count + ")")])
    ]);
  }

  function toggle(id, label, key, count) {
    var input = el("input", { type: "checkbox", id: id });
    input.addEventListener("change", function () { state[key] = input.checked; render(); });
    input.setAttribute("data-toggle", key);
    return el("label", { class: "check", "for": id }, [
      input,
      el("span", null, [label, count === null ? null : el("span", { class: "count" }, " (" + count + ")")])
    ]);
  }

  function buildFilters() {
    var catCounts = countBy(function (o) { return o.categories; });
    var catBox = $("f-categories");
    Object.keys(CATEGORY_LABELS)
      .filter(function (c) { return catCounts[c]; })
      .sort(function (a, b) { return CATEGORY_LABELS[a].localeCompare(CATEGORY_LABELS[b]); })
      .forEach(function (c) {
        catBox.appendChild(checkbox("cat-" + c, CATEGORY_LABELS[c], catCounts[c], "categories", c));
      });

    var areaCounts = countBy(function (o) { return o.service_area.verdict; });
    var areaBox = $("f-areas");
    Object.keys(AREA_LABELS).forEach(function (v) {
      if (!areaCounts[v]) return;
      areaBox.appendChild(checkbox("area-" + v, AREA_LABELS[v], areaCounts[v], "areas", v));
    });

    var confCounts = countBy(function (o) { return o.confidence; });
    var confBox = $("f-confidence");
    ["low", "medium", "high"].forEach(function (c) {
      if (!confCounts[c]) return;
      confBox.appendChild(checkbox("conf-" + c, "Confidence: " + c, confCounts[c], "confidence", c));
    });

    var tBox = $("f-toggles");
    var nThird = ORGS.filter(function (o) { return o.accepts_third_party_referral === "yes"; }).length;
    var nSoon = ORGS.filter(canStartSoon).length;
    var nRes = ORGS.filter(function (o) { return o.needs_research; }).length;
    tBox.appendChild(toggle("t-third", "Accepts a referral from another agency", "thirdParty", nThird));
    tBox.appendChild(toggle("t-soon", "Can start within about two weeks", "soon", nSoon));
    tBox.appendChild(toggle("t-research", "Flagged as needing more research", "research", nRes));
    tBox.appendChild(el("p", { class: "hint" },
      "“Within about two weeks” is derived from the wait-time text, not published by the organization. " +
      "Records with no published wait are excluded from that filter — clear it to see them."));

    var q = $("q");
    var t = null;
    q.addEventListener("input", function () {
      window.clearTimeout(t);
      t = window.setTimeout(function () { state.q = q.value.trim(); render(); }, 160);
    });

    $("site-search").addEventListener("submit", function (ev) {
      ev.preventDefault();
      window.clearTimeout(t);
      state.q = q.value.trim();
      showTab("directory", false);
      render();
      $("results").focus();
      $("results").scrollIntoView({ block: "start" });
    });
    $("filters").addEventListener("submit", function (ev) { ev.preventDefault(); });
    $("clear-search").addEventListener("click", function () {
      window.clearTimeout(t);
      state.q = "";
      q.value = "";
      render();
      announce("Search cleared. Other filters are unchanged.");
      q.focus();
    });

    /* Sync the control TO the state, not the other way round: if geography.json
       failed to load, boot() has already downgraded sort away from "meck" and
       the select must not claim otherwise. */
    $("sort").value = state.sort;
    $("sort").addEventListener("change", function () { state.sort = $("sort").value; render(); });
    $("clear-all").addEventListener("click", function () { clearAllFilters(true); });
    $("collapse-all").addEventListener("click", function () {
      if (!Object.keys(expanded).length) return;      /* nothing to close, say nothing */
      expanded = Object.create(null);
      render();
      announce("All detail panels closed.");
      $("results").focus();
    });
  }

  function clearAllFilters(focusAndAnnounce) {
    state.q = ""; state.categories = []; state.areas = []; state.confidence = [];
    state.thirdParty = false; state.soon = false; state.research = false;
    $("q").value = "";
    Array.prototype.forEach.call(document.querySelectorAll("#filters input[type=checkbox]"), function (c) { c.checked = false; });
    render();
    if (focusAndAnnounce) announce("All filters cleared. Showing every record.");
  }

  /* ---------------------------------------------------------------------
     Filtering
     --------------------------------------------------------------------- */
  function normalizeSearch(text) {
    return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[’‘']/g, "").replace(/[^a-z0-9@]+/g, " ").trim();
  }

  function buildSearchIndex() {
    ORGS.forEach(function (o) {
      var bits = [o.name, o.id, (o.also_known_as || []).join(" "), o.one_line, o.is_program_of || ""];
      (o.services || []).forEach(function (s) { bits.push(s.label, s.plain_language, s.notes || ""); });
      (o.categories || []).forEach(function (c) { bits.push(CATEGORY_LABELS[c] || c); });
      /* Geography is the organising principle of this directory, so the county
         list and the service-area note have to be findable from the search box:
         "Union" and "Gastonia" returned nothing before this. */
      var sa = o.service_area || {};
      bits.push((sa.counties || []).join(" "), sa.note || "", AREA_LABELS[sa.verdict] || sa.verdict || "");
      bits.push((o.who_qualifies || []).join(" "), (o.documentation_required || []).join(" "), o.cost || "", o.typical_wait || "");
      (o.access_path || []).forEach(function (step) {
        bits.push(step.action || "", step.detail || "", (step.requires || []).join(" "));
        (step.branches || []).forEach(function (branch) { bits.push(branch.condition || "", branch.note || ""); });
      });
      var contacts = o.contacts || {};
      bits.push(contacts.address || "", contacts.general_phone || "", contacts.general_email || "", contacts.website || "");
      (contacts.named_staff || []).forEach(function (person) { bits.push(person.name || "", person.title || ""); });
      SEARCH_INDEX[o.id] = normalizeSearch(bits.join(" "));
    });
  }

  function matches(o) {
    if (state.q) {
      var terms = normalizeSearch(state.q).split(/\s+/).filter(Boolean);
      var hay = SEARCH_INDEX[o.id] || "";
      for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
    }
    if (state.categories.length && !state.categories.some(function (c) { return o.categories.indexOf(c) > -1; })) return false;
    if (state.areas.length && state.areas.indexOf(o.service_area.verdict) === -1) return false;
    if (state.confidence.length && state.confidence.indexOf(o.confidence) === -1) return false;
    if (state.thirdParty && o.accepts_third_party_referral !== "yes") return false;
    if (state.soon && !canStartSoon(o)) return false;
    if (state.research && !o.needs_research) return false;
    return true;
  }

  /* ---------------------------------------------------------------------
     Geography ranking — "Mecklenburg first"

     CLAUDE.md rule 2: geography SORTS, it never excludes, and county names
     are not hardcoded outside docs/geography-definition.md. So this reads
     every county name from data/geography.json and nothing here knows the
     word "Mecklenburg". Sorting is also why this is ordering and not a
     filter: no record is ever hidden by it.

     The load-bearing case is the empty counties array. 55 of 96 records have
     one, and 45 of those are in_area. Empty means "statewide or national, no
     county list applies" — NOT "unknown". A Mecklenburg resident can use
     those today, so they rank just below the explicitly-local records rather
     than falling to the bottom.

     Rank on (counties ∩ config) FIRST and verdict SECOND, never on counties
     alone: a county the config has never heard of (Anson and Montgomery are
     in the data and not in the doc) must not demote an in_area record.
     --------------------------------------------------------------------- */
  var GEO = null;          /* data/geography.json, or null if it failed to load */

  var GEO_RANK = {
    home: 0, statewide: 1, adjacent: 2, region: 3, travel: 4, elsewhere: 5
  };

  function tierCounties(id) {
    if (!GEO || !GEO.tiers) return [];
    for (var i = 0; i < GEO.tiers.length; i++) {
      if (GEO.tiers[i].id === id) return GEO.tiers[i].counties || [];
    }
    return [];
  }

  function intersects(counties, list) {
    for (var i = 0; i < counties.length; i++) {
      if (list.indexOf(counties[i]) !== -1) return true;
    }
    return false;
  }

  /* Returns a tier id. Kept separate from GEO_RANK so the caption lookup and
     the sort order read from the same decision. */
  function geoTier(org) {
    var area = org.service_area || {};
    var counties = area.counties || [];
    var verdict = area.verdict;

    if (GEO && counties.indexOf(GEO.home_county) !== -1) return "home";
    if (!counties.length && verdict === "in_area") return "statewide";
    if (counties.length && intersects(counties, tierCounties("adjacent"))) return "adjacent";
    if (counties.length && intersects(counties, tierCounties("region"))) return "region";
    if (verdict === "statewide_travel_required") return "travel";
    /* A county we do not recognise, or partial/out_of_area. Fall back to the
       verdict so an unlisted-county in_area record is not buried. */
    if (verdict === "in_area") return "statewide";
    return "elsewhere";
  }

  function geoRank(org) { return GEO_RANK[geoTier(org)]; }

  function sorter() {
    var s = state.sort;
    return function (a, b) {
      if (s === "meck") {
        var g = geoRank(a) - geoRank(b);
        if (g) return g;
      }
      if (s === "confidence") {
        var d = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
        if (d) return d;
      } else if (s === "questions") {
        var q = (b.open_questions || []).length - (a.open_questions || []).length;
        if (q) return q;
      } else if (s === "area") {
        var v = AREA_ORDER[a.service_area.verdict] - AREA_ORDER[b.service_area.verdict];
        if (v) return v;
      }
      return a.name.localeCompare(b.name);
    };
  }

  /* Nearest ancestor that is itself in the result set (handles 3 levels). */
  function nearestMatchedAncestor(org, matchedIds) {
    var p = org.parent_org_id;
    var guard = 0;
    while (p && guard++ < 10) {
      if (matchedIds[p]) return p;
      p = BY_ID[p] ? BY_ID[p].parent_org_id : null;
    }
    return null;
  }

  /* ---------------------------------------------------------------------
     Active filter chips
     --------------------------------------------------------------------- */
  function renderChips() {
    var box = $("active-chips");
    clear(box);
    var chips = [];

    if (state.q) chips.push({ label: "Search: “" + state.q + "”", clear: function () { state.q = ""; $("q").value = ""; } });
    state.categories.slice().forEach(function (c) {
      chips.push({ label: CATEGORY_LABELS[c] || c, clear: function () { uncheck("cat-" + c); pull(state.categories, c); } });
    });
    state.areas.slice().forEach(function (a) {
      chips.push({ label: AREA_LABELS[a] || a, clear: function () { uncheck("area-" + a); pull(state.areas, a); } });
    });
    state.confidence.slice().forEach(function (c) {
      chips.push({ label: "Confidence: " + c, clear: function () { uncheck("conf-" + c); pull(state.confidence, c); } });
    });
    if (state.thirdParty) chips.push({ label: "Accepts agency referral", clear: function () { uncheck("t-third"); state.thirdParty = false; } });
    if (state.soon) chips.push({ label: "Can start within ~2 weeks", clear: function () { uncheck("t-soon"); state.soon = false; } });
    if (state.research) chips.push({ label: "Needs more research", clear: function () { uncheck("t-research"); state.research = false; } });

    if (!chips.length) return;

    chips.forEach(function (c) {
      var b = el("button", { type: "button", class: "chip" }, [
        el("span", null, c.label),
        el("span", { class: "x", "aria-hidden": "true" }, "×"),
        el("span", { class: "visually-hidden" }, " — remove this filter")
      ]);
      b.addEventListener("click", function () {
        c.clear();
        render();
        announce("Filter removed: " + c.label + ".");
        var next = box.querySelector("button") || $("q");
        if (next) next.focus();
      });
      box.appendChild(b);
    });

    var all = el("button", { type: "button", class: "chip" }, [el("span", null, "Clear all filters")]);
    all.addEventListener("click", function () { clearAllFilters(true); $("q").focus(); });
    box.appendChild(all);

    function uncheck(id) { var n = $(id); if (n) n.checked = false; }
    function pull(list, v) { var i = list.indexOf(v); if (i > -1) list.splice(i, 1); }
  }

  /* ---------------------------------------------------------------------
     Badges
     --------------------------------------------------------------------- */
  function badge(cls, iconChar, keyText, valueText) {
    return el("li", null, el("span", { class: "badge " + cls }, [
      iconChar ? el("span", { class: "b-icon", "aria-hidden": "true" }, iconChar) : null,
      keyText ? el("span", { class: "b-key" }, keyText + " ") : null,
      el("span", null, valueText)
    ]));
  }

  function badgeList(org) {
    var ul = el("ul", { class: "badges", role: "list" });
    org.categories.forEach(function (c) {
      ul.appendChild(badge("", null, null, CATEGORY_LABELS[c] || c));
    });
    var v = org.service_area.verdict;
    ul.appendChild(badge("badge-area-" + v, AREA_ICONS[v], "Area:", AREA_LABELS[v] || v));
    ul.appendChild(badge("badge-conf-" + org.confidence, CONFIDENCE_ICONS[org.confidence], "Confidence:", org.confidence));
    var w = shortWait(org);
    ul.appendChild(badge(w.gap ? "badge-gap" : "", w.gap ? "!" : "⏱", null, w.text));
    if (org.accepts_third_party_referral === "yes") ul.appendChild(badge("", "→", null, "Takes agency referrals"));
    if (org.needs_research) ul.appendChild(badge("badge-flag", "!", null, "Needs research"));
    if ((org.open_questions || []).length) {
      ul.appendChild(badge("badge-gap", "?", null, org.open_questions.length + " open question" + (org.open_questions.length === 1 ? "" : "s")));
    }
    return ul;
  }

  /* ---------------------------------------------------------------------
     The flowchart. One component, rendered from access_path.
     The ordered list IS the diagram: the numbers, connectors and nodes are
     drawn in CSS around real <ol>/<li> semantics, so the text equivalent and
     the visual can never drift apart.
     --------------------------------------------------------------------- */
  function flowchart(org) {
    var steps = (org.access_path || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    if (!steps.length) return gapBlock("No route into this organization is recorded. " + GAP_TEXT + ".");

    /* role="list" is not decorative here: list-style:none strips list semantics
       in Safari/VoiceOver, and the step ordinals are drawn only by CSS
       counters, which are not reliably exposed. The spoken "Step N of M"
       below is the belt to that braces — the list IS the diagram. */
    var ol = el("ol", { class: "flow", role: "list" });
    var totalSteps = steps.length;
    steps.forEach(function (st, stepIndex) {
      var li = el("li", { "data-blocking": st.blocking ? "true" : "false" });

      li.appendChild(el("span", { class: "visually-hidden" },
        "Step " + (stepIndex + 1) + " of " + totalSteps + ". "));

      li.appendChild(el("p", { class: "step-action" }, [
        el("span", { class: "step-actor" }, ACTOR_LABELS[st.actor] || st.actor),
        linkify(st.action)
      ]));

      if (st.detail) li.appendChild(el("p", { class: "step-detail" }, linkify(st.detail)));

      if (st.requires && st.requires.length) {
        /* Each token already reads "Needs: X", so the visually-hidden
           "This step needs:" intro that used to sit here was a duplicate. */
        var tk = el("ul", { class: "step-tokens", role: "list" });
        st.requires.forEach(function (r) {
          tk.appendChild(el("li", { class: "token token-req" }, [
            el("span", { "aria-hidden": "true" }, "▪ "), "Needs: ", r
          ]));
        });
        li.appendChild(tk);
      }

      /* The glyphs are decoration on top of words that already say the same
         thing. Exposed, they were 389 spurious "black square"/"white square"
         announcements and 327 "stopwatch"es. Matches the badge() pattern. */
      var meta = el("p", { class: "step-meta" }, [
        el("span", { class: "step-flag" + (st.blocking ? " is-blocking" : "") }, [
          el("span", { "aria-hidden": "true" }, st.blocking ? "■ " : "□ "),
          st.blocking ? "Must be done before the next step" : "Does not block the next step"
        ])
      ]);
      if (st.duration) {
        meta.appendChild(el("span", null, [
          el("span", { "aria-hidden": "true" }, "⏱ "), "Takes: " + st.duration
        ]));
      }
      li.appendChild(meta);

      if (st.branches && st.branches.length) {
        var bl = el("ul", { class: "branches", role: "list" });
        st.branches.forEach(function (b) {
          var item = el("li", null, el("span", { class: "branch-cond" }, "If: " + b.condition));
          if (b.goto_org_id && BY_ID[b.goto_org_id]) {
            item.appendChild(el("p", { class: "branch-note" }, gotoLink(b.goto_org_id)));
          } else if (b.goto_org_id) {
            item.appendChild(el("p", { class: "branch-note" }, "Points to record “" + b.goto_org_id + "”, which is not in this file."));
          }
          if (b.note) item.appendChild(el("p", { class: "branch-note" }, linkify(b.note)));
          bl.appendChild(item);
        });
        li.appendChild(bl);
      }

      ol.appendChild(li);
    });
    return ol;
  }

  function gotoLink(id) {
    var target = BY_ID[id];
    var a = el("a", { class: "goto-link", href: "#org-" + id }, [
      el("span", { "aria-hidden": "true" }, "→ "),
      "Go to " + target.name
    ]);
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      jumpTo(id);
    });
    return a;
  }

  /* A branch target must always be reachable. If the current filters hide it,
     the filters give way — the data never becomes unreachable. */
  function jumpTo(id) {
    var org = BY_ID[id];
    if (!org) return;
    expanded[id] = true;
    /* The record lives in the Directory panel, so the view gives way first.
       Records must never become unreachable — the same invariant that makes
       this function clear filters. */
    var switchedTab = showTab("directory", false);
    var why = [];
    if (switchedTab) why.push("Directory view");
    if (!matches(org) || !document.getElementById("org-" + id)) {
      clearAllFilters(false);
      why.push("filters cleared");
    }
    /* One announcement, never two. */
    if (why.length) announce(why.join(" and ") + " so " + org.name + " could be shown.");
    render();
    var node = document.getElementById("org-" + id);
    if (node) {
      var btn = node.querySelector(".disclosure");
      if (btn) btn.focus();
      node.scrollIntoView({ block: "start" });
    }
  }

  /* ---------------------------------------------------------------------
     Verification email
     --------------------------------------------------------------------- */
  function line(key, value) { return "  " + key + ": " + value; }

  function emailText(org) {
    var missing = [];
    var L = [];

    function fieldOr(label, value, fallbackName) {
      if (!value || !String(value).trim() || isGap(value)) { missing.push(fallbackName || label); return "(we could not find this)"; }
      return truncate(value, 180);
    }

    L.push("Subject: Quick check on what we have on file for " + org.name);
    L.push("");
    L.push("Hello,");
    L.push("");
    L.push("We are putting together a referral guide for people in the greater Charlotte area who are blind, losing their sight, or living with low vision, so that when someone is sent to you it is the right person with the right paperwork in hand. You are in it because you came up as a place people are sent.");
    L.push("");
    L.push("Below is what we have on file for you today, taken from your published information. If anything is wrong, telling us so is the most useful thing you can do - a one-line reply is plenty.");
    L.push("");
    L.push(line("Organization", org.name));
    L.push(line("What we say you do", truncate(org.one_line, 180)));

    var svc = (org.services || []).slice(0, 5).map(function (s) { return s.label; }).join("; ");
    L.push(line("Services we list", svc || "(we could not find this)"));

    var who = (org.who_qualifies || []).slice(0, 4).join("; ");
    L.push(line("Who we say qualifies", who ? truncate(who, 200) : "(we could not find this)"));

    var docs = (org.documentation_required || []).filter(function (d) { return !isGap(d); });
    if (docs.length) L.push(line("What we tell people to bring", truncate(docs.slice(0, 5).join("; "), 200)));
    else { L.push(line("What we tell people to bring", "(we could not find this)")); missing.push("the documents a person must bring to their first appointment"); }

    L.push(line("Cost", fieldOr("Cost", org.cost, "what your services cost")));
    L.push(line("Typical wait to be seen", fieldOr("Wait", org.typical_wait, "your typical wait from referral to first appointment")));

    var tp = org.accepts_third_party_referral;
    L.push(line("Do you accept referrals from another agency", tp === "yes" ? "yes" : tp === "no" ? "no" : "(we could not tell)"));
    if (tp === "unclear") missing.push("whether another agency can refer someone to you, or whether the person has to call themselves");

    if (org.contacts.general_phone) L.push(line("Phone we would give out", truncate(org.contacts.general_phone, 120)));
    else missing.push("the best phone number for someone to reach you on");
    if (org.contacts.website) L.push(line("Website", org.contacts.website));
    if (org.contacts.intake_form_url) L.push(line("Referral or intake form we point people to", org.contacts.intake_form_url));

    L.push("");
    L.push("Two questions we are asking everyone:");
    L.push("  1. What services do you provide?");
    L.push("  2. What is your referral platform - how do you want referrals to reach you?");

    if (missing.length) {
      L.push("");
      L.push("And these we could not find published anywhere. Even a rough answer helps:");
      missing.slice(0, 6).forEach(function (m) { L.push("  - " + m); });
    }

    L.push("");
    L.push("Thank you. Five minutes of your time here saves a lot of people a wasted trip.");
    L.push("");
    L.push("[Your name]");
    L.push("[Your organization, phone and email]");
    return L.join("\n");
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("no clipboard api"));
  }

  function fallbackCopy(text) {
    var ta = el("textarea", { value: text, "aria-hidden": "true", tabindex: "-1" });
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyButton(org) {
    var btn = el("button", { type: "button", class: "btn" }, "Copy verification email");
    btn.addEventListener("click", function () {
      var text = emailText(org);
      var done = function () {
        btn.textContent = "✓ Copied to clipboard";
        announce("Verification email for " + org.name + " copied to the clipboard.");
        window.setTimeout(function () { btn.textContent = "Copy verification email"; }, 6000);
      };
      var failed = function () {
        if (fallbackCopy(text)) { done(); return; }
        btn.textContent = "Copy failed — select the text below";
        announce("Copying failed. The email text is now shown below the button so it can be selected and copied by hand.");
        var pre = el("textarea", { class: "manual-copy", rows: 14, readonly: true, value: text, "aria-label": "Verification email text for " + org.name });
        pre.style.width = "100%";
        pre.style.font = "inherit";
        pre.style.fontSize = "1rem";
        btn.parentNode.appendChild(pre);
        pre.focus();
        pre.select();
      };
      copyToClipboard(text).then(done, failed);
    });
    return btn;
  }

  function shareButton(org) {
    var btn = el("button", { type: "button", class: "btn btn-quiet" }, "Copy link to this organization");
    btn.addEventListener("click", function () {
      var url = new URL(window.location.pathname, window.location.origin);
      url.hash = "org-" + org.id;
      copyToClipboard(url.href).then(function () {
        announce("Link to " + org.name + " copied.");
        btn.textContent = "Link copied";
        window.setTimeout(function () { btn.textContent = "Copy link to this organization"; }, 4000);
      }, function () {
        var input = btn.parentNode.querySelector(".share-fallback");
        if (!input) {
          input = el("input", { class: "share-fallback", type: "text", readonly: true, "aria-label": "Link to " + org.name });
          btn.parentNode.appendChild(input);
        }
        input.value = url.href;
        input.focus(); input.select();
        announce("Copy the selected organization link.");
      });
    });
    return btn;
  }

  /* ---------------------------------------------------------------------
     Detail panel
     --------------------------------------------------------------------- */
  function section(heading, kids, cls) {
    return el("section", { class: cls || null }, [el("h4", null, heading)].concat(kids || []));
  }

  function listOrGap(items, emptyMessage) {
    var real = (items || []).filter(function (i) { return i && String(i).trim(); });
    if (!real.length) return gapBlock(emptyMessage);
    var ul = el("ul");
    real.forEach(function (i) {
      ul.appendChild(isGap(i) ? el("li", null, gapBlock(linkify(i))) : el("li", null, linkify(i)));
    });
    return ul;
  }

  function buildPanel(org) {
    var panel = el("div", { class: "panel", id: "panel-" + org.id, hidden: true });

    /* Copy email — the most used control, so it sits first. */
    panel.appendChild(el("div", { class: "panel-toolbar" }, [
      shareButton(org),
      copyButton(org),
      el("p", { class: "copy-note" },
        "Copies a subject line and a short email that leads with what we already have, asks the two standard questions, and names the fields we could not find. Open questions are listed at the foot of this panel if you want to add any.")
    ]));

    panel.appendChild(el("h4", { class: "before-heading" }, "Before you contact them"));
    /* Who qualifies */
    panel.appendChild(section("Who qualifies", [listOrGap(org.who_qualifies, "Eligibility is not recorded. " + GAP_TEXT + ".")]));

    /* What to bring — emphasised, it is the field that most often blocks people */
    panel.appendChild(section("What to bring", [
      listOrGap(org.documentation_required, "No document list found. " + GAP_TEXT + " — ask what a person must bring to the first appointment.")
    ], "bring"));

    /* Cost, wait, referral */
    var facts = el("dl", { class: "facts" });
    facts.appendChild(el("dt", null, "Cost"));
    facts.appendChild(el("dd", null, valueNode(org.cost)));
    facts.appendChild(el("dt", null, "Typical wait"));
    facts.appendChild(el("dd", null, [
      valueNode(org.typical_wait),
      canStartSoon(org) ? el("p", { class: "hint" }, "Derived from the wait text: likely to start within about two weeks.") : null
    ]));
    facts.appendChild(el("dt", null, "Agency referral"));
    facts.appendChild(el("dd", null,
      org.accepts_third_party_referral === "yes" ? el("p", null, "Yes — another agency can refer someone here.")
        : org.accepts_third_party_referral === "no" ? el("p", null, "No — the person has to make contact themselves.")
          : gapBlock("Unclear whether a third party can refer. " + GAP_TEXT + ".")));
    facts.appendChild(el("dt", null, "Service area"));
    facts.appendChild(el("dd", null, [
      el("p", null, AREA_LABELS[org.service_area.verdict] +
        ((org.service_area.counties || []).length ? " — " + org.service_area.counties.join(", ") : "")),
      org.service_area.note ? el("p", { class: "hint" }, org.service_area.note) : null
    ]));
    panel.appendChild(section("Cost, wait and referral", [facts]));

    /* Contacts */
    var c = org.contacts || {};
    var cl = el("ul", { class: "contact-list", role: "list" });
    function contactRow(key, value) {
      if (!value || !String(value).trim()) return;
      cl.appendChild(el("li", null, [el("span", { class: "contact-key" }, key), el("span", null, linkify(value))]));
    }
    contactRow("Phone", c.general_phone);
    contactRow("Email", c.general_email);
    contactRow("Address", c.address);
    contactRow("Website", c.website);
    contactRow("Intake or referral form", c.intake_form_url);
    if (!c.general_phone) cl.appendChild(el("li", null, gapBlock("No phone number found. " + GAP_TEXT + ".")));
    if (!c.general_email) cl.appendChild(el("li", null, gapBlock("No general email found. " + GAP_TEXT + ".")));

    var staffNodes = (c.named_staff || []).map(function (s) {
      return el("div", { class: "staff" }, [
        el("p", { class: "staff-name" }, [s.name, s.title ? el("span", { class: "staff-title" }, " — " + s.title) : null]),
        s.email ? el("p", null, linkify(s.email)) : null,
        s.phone ? el("p", null, linkify(s.phone)) : null,
        s.source_url ? el("p", { class: "hint" }, [el("span", null, "Published at "), linkify(s.source_url)]) : null
      ]);
    });
    panel.appendChild(section("Contact", [cl].concat(staffNodes.length ? [el("h4", null, "Named staff")].concat(staffNodes) : [])));

    /* What they do */
    var svcNodes = (org.services || []).map(function (s) {
      return el("div", { class: "svc" }, [
        el("p", { class: "svc-plain" }, linkify(s.plain_language || s.label)),
        s.label && s.label !== s.plain_language ? el("span", { class: "svc-label" }, "Their name for it: " + s.label) : null,
        s.notes ? el("p", { class: "svc-notes" }, linkify(s.notes)) : null
      ]);
    });
    panel.appendChild(section("What they do", svcNodes.length ? svcNodes : [gapBlock("No services recorded. " + GAP_TEXT + ".")]));

    /* Access path */
    panel.appendChild(section("How a person gets in", [
      el("p", { class: "hint" }, "Numbered steps in order. Steps marked “must be done before the next step” block everything after them."),
      flowchart(org)
    ]));

    /* Provenance */
    var prov = el("div", { class: "provenance" }, [el("h4", null, "Where this came from")]);
    var pf = el("dl", { class: "facts" });
    pf.appendChild(el("dt", null, "Last verified"));
    pf.appendChild(el("dd", null, org.last_verified || "not recorded"));
    pf.appendChild(el("dt", null, "Confidence"));
    pf.appendChild(el("dd", null, [
      el("span", null, [
        el("span", { "aria-hidden": "true" }, CONFIDENCE_ICONS[org.confidence] + " "),
        org.confidence
      ]),
      org.confidence_note ? el("p", { class: "hint" }, org.confidence_note) : null
    ]));
    pf.appendChild(el("dt", null, "Record id"));
    pf.appendChild(el("dd", null, el("code", null, org.id)));
    prov.appendChild(pf);

    if ((org.open_questions || []).length) {
      prov.appendChild(el("h4", null, "Open questions (" + org.open_questions.length + ")"));
      var ql = el("ol", { class: "q-list" });
      org.open_questions.forEach(function (q) { ql.appendChild(el("li", null, linkify(q))); });
      prov.appendChild(ql);
    } else {
      prov.appendChild(el("p", { class: "hint" }, "No open questions recorded."));
    }

    if ((org.sources || []).length) {
      prov.appendChild(el("h4", null, "Sources"));
      var sl = el("ul", { class: "sources" });
      org.sources.forEach(function (s) {
        sl.appendChild(el("li", null, [
          el("span", null, s.report + (s.heading ? " — " + s.heading : "")),
          s.url ? el("span", null, [" ", linkify(s.url)]) : null
        ]));
      });
      prov.appendChild(sl);
    }
    panel.appendChild(prov);

    return panel;
  }

  /* ---------------------------------------------------------------------
     Cards
     --------------------------------------------------------------------- */
  function card(org) {
    var li = el("li", { class: "org-item", id: "org-" + org.id });
    /* The region is named by the organization name ALONE. Pointing at the h3
       swept up the disclosure button's " — show details" state text, so every
       one of the 96 regions was called "<name> — show details". */
    var art = el("article", { class: "card" + (expanded[org.id] ? " is-open" : ""), "aria-labelledby": "name-" + org.id });

    var btn = el("button", {
      type: "button",
      class: "disclosure",
      "aria-expanded": expanded[org.id] ? "true" : "false",
      "aria-controls": "panel-" + org.id
    }, [
      el("span", { class: "caret", "aria-hidden": "true" }, "▶"),
      el("span", { class: "disclosure-name", id: "name-" + org.id }, org.name),
      el("span", { class: "visually-hidden" }, expanded[org.id] ? " — hide details" : " — show details")
    ]);

    var head = el("div", { class: "card-head" }, [
      el("h3", { id: "h-" + org.id }, btn),
      el("p", { class: "one-line" }, org.one_line)
    ]);

    /* CLAUDE.md rule 1: the umbrella a programme belongs to is the whole reason
       these records are kept separate, so it is always stated in words. It used
       to be suppressed exactly when the card was nested under its parent, which
       left the relationship carried only by indentation and a 1.38:1 border. */
    if (org.parent_org_id) {
      var parent = BY_ID[org.parent_org_id];
      if (parent) {
        var note = el("p", { class: "parent-note" }, "Part of ");
        var a = el("a", { href: "#org-" + parent.id, text: parent.name });
        a.addEventListener("click", function (ev) { ev.preventDefault(); jumpTo(parent.id); });
        note.appendChild(a);
        head.appendChild(note);
      }
    }
    if ((org.programs || []).length) {
      head.appendChild(el("p", { class: "parent-note" },
        org.programs.length + " separate programme record" + (org.programs.length === 1 ? "" : "s") +
        " sit under this one, each with its own eligibility and paperwork."));
    }

    head.appendChild(badgeList(org));
    art.appendChild(head);

    var panel;
    if (expanded[org.id]) {
      panel = built[org.id] || (built[org.id] = buildPanel(org));
      panel.hidden = false;
    } else if (built[org.id]) {
      panel = built[org.id];
      panel.hidden = true;
    } else {
      panel = el("div", { class: "panel", id: "panel-" + org.id, hidden: true });
    }
    art.appendChild(panel);

    btn.addEventListener("click", function () {
      var now = !expanded[org.id];
      if (now) expanded[org.id] = true; else delete expanded[org.id];
      if (now && !built[org.id]) {
        built[org.id] = buildPanel(org);
        art.replaceChild(built[org.id], panel);
        panel = built[org.id];
      }
      panel.hidden = !now;
      btn.setAttribute("aria-expanded", now ? "true" : "false");
      btn.lastChild.textContent = now ? " — hide details" : " — show details";
      art.className = "card" + (now ? " is-open" : "");
      syncCollapseAll();
    });

    li.appendChild(art);
    return li;
  }

  /* ---------------------------------------------------------------------
     Render
     --------------------------------------------------------------------- */
  function render() {
    var list = $("org-list");
    clear(list);

    var matched = ORGS.filter(matches);
    var matchedIds = {};
    matched.forEach(function (o) { matchedIds[o.id] = true; });

    var childrenOf = {};
    var roots = [];
    matched.forEach(function (o) {
      var anc = nearestMatchedAncestor(o, matchedIds);
      if (anc) { (childrenOf[anc] = childrenOf[anc] || []).push(o); }
      else roots.push(o);
    });

    var cmp = sorter();
    roots.sort(cmp);
    Object.keys(childrenOf).forEach(function (k) { childrenOf[k].sort(cmp); });

    function place(org, parentEl) {
      var li = card(org);
      var kids = childrenOf[org.id];
      if (kids && kids.length) {
        /* role="list" survives list-style:none; the label says whose programmes
           these are, which indentation alone never did. */
        var sub = el("ul", {
          class: "children",
          role: "list",
          "aria-label": "Programmes of " + org.name
        });
        kids.forEach(function (k) { place(k, sub); });
        li.appendChild(sub);
      }
      parentEl.appendChild(li);
    }
    /* Tier dividers. These are the "wider region" affordance and they are a
       DIVIDER, NOT A FILTER — CLAUDE.md rule 2. Nothing below one is hidden,
       collapsed or removable; the reader simply keeps scrolling. Only roots
       carry them, because a programme belongs under its parent regardless of
       geography. Captions come from geography.json, never from a literal here.
       Not a heading: h3 is already per-card and a heading would skip a level. */
    var lastTier = null;
    roots.forEach(function (r) {
      if (state.sort === "meck" && GEO) {
        var tier = geoTier(r);
        if (tier !== lastTier) {
          lastTier = tier;
          var caption = (GEO.tier_captions || {})[tier];
          if (caption) {
            list.appendChild(el("li", { class: "tier-break" }, [
              el("span", { class: "tier-break-mark", "aria-hidden": "true" }, "—"),
              el("strong", null, caption)
            ]));
          }
        }
      }
      place(r, list);
    });

    /* Result count in the live region. */
    var status = $("result-status");
    clear(status);
    if (matched.length === ORGS.length) {
      append(status, [el("span", { class: "num" }, String(ORGS.length)), " organizations — the whole directory, no filters applied."]);
    } else {
      append(status, [
        el("span", { class: "num" }, String(matched.length)),
        " of " + ORGS.length + " organizations match the current filters."
      ]);
    }

    if (!matched.length) {
      var empty = el("div", { class: "empty" }, [
        el("p", null, "Nothing matches those filters. Nothing has been removed from the data — widen the filters and it comes back."),
      ]);
      var b = el("button", { type: "button", class: "btn" }, "Clear all filters");
      b.addEventListener("click", function () { clearAllFilters(true); $("q").focus(); });
      empty.appendChild(b);
      list.appendChild(el("li", null, empty));
    }

    $("search-summary").textContent = matched.length + " of " + ORGS.length +
      " organizations match the current search and filters. Use Clear all in Directory to show every organization.";
    syncCollapseAll();
    renderChips();
  }

  /* ---------------------------------------------------------------------
     Errors
     --------------------------------------------------------------------- */
  function showError(detail) {
    var box = el("div", { class: "error-box", role: "alert", tabindex: "-1" }, [
      el("h2", null, "The directory could not be loaded"),
      el("p", null, "This page renders entirely from " + DATA_URL + ", and that file did not load, so there is nothing to show. No records have been lost — the data file is still on disk."),
      el("p", null, ["Technical detail: ", el("code", null, String(detail))]),
      el("p", null, "If you are running this locally, serve the folder over HTTP (for example: python3 -m http.server 8899 inside the site directory) rather than opening the file directly — browsers block fetch on file:// URLs."),
    ]);
    var retry = el("button", { type: "button", class: "btn" }, "Try loading again");
    retry.addEventListener("click", function () { window.location.reload(); });
    box.appendChild(retry);
    clear($("error-region"));
    $("error-region").appendChild(box);
    $("result-status").textContent = "The directory could not be loaded.";
    try { box.focus(); } catch (e) { /* focus is a courtesy, not a requirement */ }
  }

  function initFeedback() {
    var dialog = $("feedback-dialog");
    var opener = $("feedback-open");
    var message = $("feedback-message");
    var status = $("feedback-status");
    opener.addEventListener("click", function () {
      status.textContent = "";
      dialog.showModal();
      message.focus();
    });
    $("feedback-close").addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("close", function () { opener.focus(); });
    function feedbackText() {
      return "VISION360 website feedback\n\n" + message.value.trim() +
        "\n\nWebsite: https://lions-vision-referral.vercel.app/";
    }
    $("feedback-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!message.value.trim()) { message.setCustomValidity("Please describe what we can improve."); message.reportValidity(); return; }
      var href = "mailto:ben@agenticarc.ai?subject=" + encodeURIComponent("VISION360 website feedback") +
        "&body=" + encodeURIComponent(feedbackText());
      status.textContent = "Your email app should open. Send the message there to submit your feedback. If it does not open, copy your feedback and email ben@agenticarc.ai.";
      window.location.href = href;
    });
    message.addEventListener("input", function () { message.setCustomValidity(""); });
    $("feedback-copy").addEventListener("click", function () {
      if (!message.value.trim()) { message.focus(); status.textContent = "Describe what we can improve first."; return; }
      copyToClipboard(feedbackText()).then(function () {
        status.textContent = "Feedback copied. Paste it into an email to ben@agenticarc.ai and send it for review.";
      }, function () {
        message.focus(); message.select();
        status.textContent = "Copy the selected feedback and email it to ben@agenticarc.ai.";
      });
    });
  }
  // Feedback stays available even if the directory data fails to load.
  initFeedback();

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */
  function boot(data, geo, paths, assess) {
    if (!Array.isArray(data) || !data.length) throw new Error("organizations.json is not a non-empty array");
    ORGS = data;
    PATHWAYS = paths && paths.groups ? paths : null;
    ASSESS = assess && assess.questions ? assess : null;
    /* geography.json is optional. Without it geoTier() falls back to verdicts
       and "Mecklenburg first" degrades to "in_area first" — the directory
       still works, which is the point: the organizations are the product. */
    GEO = geo && geo.tiers ? geo : null;
    if (!GEO && state.sort === "meck") state.sort = "name";
    ORGS.forEach(function (o) { BY_ID[o.id] = o; });
    buildSearchIndex();
    buildFilters();
    initTabs();
    if (PATHWAYS) GRAPH = buildGraph();
    render();
    renderPathways();
    renderQuiz();

    /* Deep links. #org-<id> opens a record (switching to Directory first via
       jumpTo); #tab-<name> opens a view. Anything else is ignored, as before. */
    function routeHash(h, focusPanel) {
      if (h.indexOf("#org-") === 0) {
        var id = h.slice(5);
        if (BY_ID[id]) jumpTo(id);
      } else if (h.indexOf("#tab-") === 0) {
        var name = h.slice(5);
        if (TABS.indexOf(name) !== -1 && showTab(name, focusPanel)) {
          announce(TAB_LABELS[name] + " view.");
        }
      }
    }
    routeHash(window.location.hash, false);
    window.addEventListener("hashchange", function () {
      routeHash(window.location.hash, true);
    });
  }

  function start() {
    initSettings();
    /* The directory is REQUIRED and hard-fails into showError(). geography.json
       is OPTIONAL and resolves to null on any problem, so a missing or broken
       config can never take the directory down with it. */
    var orgs = fetch(DATA_URL, { cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText + " for " + DATA_URL);
      return res.json();
    });
    function optional(url) {
      return fetch(url, { cache: "no-cache" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; });
    }
    Promise.all([orgs, optional(GEO_URL), optional(PATHS_URL), optional(ASSESS_URL)])
      .then(function (r) { boot(r[0], r[1], r[2], r[3]); })
      .catch(function (err) { showError(err && err.message ? err.message : err); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
