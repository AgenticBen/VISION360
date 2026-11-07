/* Visual workflow editor.
   - Canvas: sections are columns, questions are cards. Grey lines show the
     order; blue lines run from an answer's dot to a follow-up question that is
     only asked after that answer.
   - Drag a card to move it in the order (it snaps into place). Drag from an
     answer's dot onto another card to make that card a follow-up of the answer.
     Click a blue line to remove the link.
   - "Follow-ups (n)" on a card shows or tucks away the questions that branch
     from it. + / − zoom, Fit shows everything; drag the background to pan.
   - Edits save to a draft automatically. Check runs the publish checks and
     shows how suggestions would change; Publish makes a new version.
   Nothing here talks to anything but /api/flows. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var flowId = new URLSearchParams(location.search).get("flow") || "referral";
  var root = document.getElementById("editor-root");

  var TYPES = { single: "Choose one", multi: "Choose any", yes_no: "Yes / no", text: "Short text", long_text: "Long text", email: "Email", phone: "Phone", address: "Address", date: "Date", consent: "Consent" };
  var CHOICE = ["single", "multi", "yes_no", "consent"];
  var NODE_W = 260, FOLLOW_DX = 300, ROW_GAP = 26, COL_GAP = 90, TOP = 70, LEFT = 50;

  var S = {
    meta: null, published: null, flow: null, versions: [], version: 1, draftRevision: 0, hasDraft: false,
    selected: null, expanded: {}, zoom: 0.8, panX: 20, panY: 10, nodes: {}, frames: [], issues: {},
    undo: [], saveTimer: null, saving: false, dirty: false, stale: false, editsOn: true, orgs: null, viewing: null
  };
  var name = ""; try { name = localStorage.getItem("v360-editor-name") || ""; } catch (e) {}

  /* ---------------------------------------------------------------- data */
  function qById(id) { return S.flow.questions.find(function (q) { return q.id === id; }); }
  function blockOf(id) { return S.flow.blocks.find(function (b) { return b.questions.indexOf(id) !== -1; }); }
  function leaves(c, out) {
    out = out || [];
    if (!c) return out;
    if (c.all || c.any) (c.all || c.any).forEach(function (x) { leaves(x, out); });
    else if (c.not) leaves(c.not, out);
    else if (c.q) out.push(c);
    return out;
  }
  function simpleCond(q) { return q.ask_if && q.ask_if.q && Array.isArray(q.ask_if["in"]) ? q.ask_if : null; }
  function parentId(q) { var l = leaves(q.ask_if); return l.length ? l[0].q : null; }
  function children(id) { return S.flow.questions.filter(function (q) { return parentId(q) === id; }); }
  function descendants(id) { var out = []; children(id).forEach(function (c) { out.push(c.id); out = out.concat(descendants(c.id)); }); return out; }
  function isFollow(q) { var p = parentId(q); return !!(p && blockOf(p) === blockOf(q.id)); }
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "q_$1").slice(0, 40) || "item"; }
  function uniqueId(base, taken) { var id = base, n = 2; while (taken(id)) id = base + "_" + n++; return id; }

  /* --------------------------------------------------------------- edits */
  function edit(label, fn, opts) {
    if (!S.editsOn || S.viewing) { toast(S.viewing ? "You're looking at an old version. Go back to the draft to edit." : "Editing is switched off on this site."); return; }
    S.undo.push(JSON.stringify(S.flow)); if (S.undo.length > 60) S.undo.shift();
    fn();
    S.dirty = true;
    setStatus("Unsaved changes", "amber");
    scheduleSave();
    render();
    if (!opts || opts.inspector !== false) renderInspector();
  }
  function undo() {
    if (!S.undo.length) return;
    S.flow = JSON.parse(S.undo.pop());
    if (S.selected && S.selected.type === "q" && !qById(S.selected.id)) S.selected = null;
    S.dirty = true; scheduleSave(); render(); renderInspector();
  }
  function scheduleSave() { clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 1200); }
  function save() {
    if (!S.dirty || S.saving || S.stale) return Promise.resolve();
    S.saving = true; S.dirty = false; setStatus("Saving…", "sky");
    return A.api("PUT", "/api/flows/" + flowId + "/draft", { flow: S.flow, draftRevision: S.draftRevision, author: name || "Someone" })
      .then(function (r) {
        S.draftRevision = r.draftRevision;
        if (!S.hasDraft) { S.hasDraft = true; document.getElementById("discard").hidden = false; renderRail(); }
        setIssues(r.checks);
        setStatus(r.checks.ok ? "Draft saved" : "Draft saved · " + r.checks.errors.length + " issue" + (r.checks.errors.length === 1 ? "" : "s"), r.checks.ok ? "ok" : "bad");
      })
      .catch(function (e) {
        if (e.status === 409) { S.stale = true; setStatus("Out of date — reload", "bad"); banner("Someone else changed this draft. Reload to see their version (your last edits won't be saved).", "Reload", function () { location.reload(); }); }
        else { S.dirty = true; setStatus("Couldn't save: " + e.message, "bad"); }
      })
      .finally(function () { S.saving = false; if (S.dirty) scheduleSave(); });
  }
  function setIssues(checks) {
    S.issues = {};
    (checks.errors || []).forEach(function (e) { var m = /^question:([^:]+)/.exec(e.where); if (m) (S.issues[m[1]] = S.issues[m[1]] || []).push(e.message); });
    render();
    if (S.selected && S.selected.type === "q") renderInspectorIssues();
  }

  /* ------------------------------------------------------------- shell */
  var status, canvas, world, svg, insp, rail, pct;
  function build() {
    root.textContent = "";
    root.className = "ed";
    status = el("span", { class: "chip", text: "Loading…" });
    var nameIn = el("input", { class: "inp name", placeholder: "Your name", value: name, "aria-label": "Your name (shown on versions)" });
    nameIn.addEventListener("change", function () { name = nameIn.value.trim(); try { localStorage.setItem("v360-editor-name", name); } catch (e) {} });
    var top = el("div", { class: "ed-top" }, [
      el("a", { class: "btn sm", href: "/admin/workflows/", text: "← Workflows" }),
      el("h1", { text: S.meta.title }),
      el("span", { class: "chip sky", id: "ver-chip", text: "v" + S.version + " live" }),
      status,
      el("span", { class: "grow" }),
      el("button", { type: "button", class: "btn sm", text: "Versions", onclick: function () { root.classList.toggle("no-rail"); root.classList.toggle("show-rail"); } }),
      el("button", { type: "button", class: "btn sm", title: "Undo (Ctrl+Z)", text: "↶ Undo", onclick: undo }),
      nameIn,
      el("button", { type: "button", class: "btn sm", id: "discard", text: "Discard draft" }),
      el("button", { type: "button", class: "btn", text: "Check", onclick: openCheck }),
      el("button", { type: "button", class: "btn primary", "data-tour": "publish", text: "Publish…", onclick: openPublish })
    ]);
    A.confirm2(top.querySelector("#discard"), "Yes, discard", function () {
      A.api("DELETE", "/api/flows/" + flowId + "/draft").then(function () { location.reload(); });
    });
    rail = el("aside", { class: "ed-rail", "data-tour": "versions" });
    canvas = el("div", { class: "ed-canvas", "data-tour": "canvas", tabindex: "0", "aria-label": "Workflow canvas" });
    world = el("div", { class: "ed-world" });
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ed-edges");
    world.appendChild(svg);
    canvas.appendChild(world);
    pct = el("span", { class: "pct", text: "80%" });
    canvas.appendChild(el("div", { class: "ed-tools", "data-tour": "zoom" }, [
      el("div", { class: "grp" }, [el("button", { type: "button", title: "Zoom out", text: "−", onclick: function () { zoomBy(1 / 1.2); } }), pct, el("button", { type: "button", title: "Zoom in", text: "+", onclick: function () { zoomBy(1.2); } }), el("button", { type: "button", text: "Fit", onclick: fit })]),
      el("div", { class: "grp" }, [el("button", { type: "button", text: "Expand all", onclick: function () { S.flow.questions.forEach(function (q) { if (children(q.id).length) S.expanded[q.id] = true; }); render(); } }), el("button", { type: "button", text: "Collapse all", onclick: function () { S.expanded = {}; render(); } })]),
      el("div", { class: "grp" }, [el("button", { type: "button", text: "+ Question", onclick: addQuestion }), el("button", { type: "button", text: "+ Section", onclick: addSection })])
    ]));
    canvas.appendChild(el("div", { class: "ed-legend" }, ["Order", el("i"), "Follow-up", el("i", { class: "sky" }), "Next section", el("i", { class: "dash" })]));
    insp = el("aside", { class: "ed-insp", "data-tour": "inspector" });
    root.appendChild(top);
    root.appendChild(el("div", { class: "ed-body" }, [rail, canvas, insp]));
    wireCanvas();
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
    });
    window.addEventListener("beforeunload", function (e) { if (S.dirty || S.saving) { save(); e.preventDefault(); e.returnValue = ""; } });
  }
  function setStatus(t, kind) { status.textContent = t; status.className = "chip " + (kind || ""); }
  var bannerEl = null;
  function banner(text, btnText, fn) {
    if (bannerEl) bannerEl.remove();
    bannerEl = el("div", { class: "ed-banner note" }, [text, btnText ? el("button", { type: "button", class: "btn sm", style: "margin-left:8px", text: btnText, onclick: fn }) : null]);
    canvas.appendChild(bannerEl);
  }
  function toast(t) { var x = el("div", { class: "toast", role: "status", text: t }); document.body.appendChild(x); setTimeout(function () { x.remove(); }, 3200); }

  /* ------------------------------------------------------------ canvas */
  function applyView() { world.style.transform = "translate(" + S.panX + "px," + S.panY + "px) scale(" + S.zoom + ")"; pct.textContent = Math.round(S.zoom * 100) + "%"; }
  function zoomBy(f, cx, cy) {
    var r = canvas.getBoundingClientRect();
    cx = cx == null ? r.width / 2 : cx; cy = cy == null ? r.height / 2 : cy;
    var z = Math.min(2, Math.max(0.25, S.zoom * f));
    S.panX = cx - (cx - S.panX) * (z / S.zoom); S.panY = cy - (cy - S.panY) * (z / S.zoom); S.zoom = z; applyView();
  }
  function fit() {
    var b = bounds(); if (!b) return;
    var r = canvas.getBoundingClientRect();
    S.zoom = Math.min(1.2, Math.max(0.25, Math.min((r.width - 40) / b.w, (r.height - 80) / b.h)));
    S.panX = 20 - b.x * S.zoom; S.panY = 60 - b.y * S.zoom; applyView();
  }
  function bounds() {
    if (!S.frames.length) return null;
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    S.frames.forEach(function (f) { x1 = Math.min(x1, f.x); y1 = Math.min(y1, f.y); x2 = Math.max(x2, f.x + f.w); y2 = Math.max(y2, f.y + f.h); });
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function toWorld(ev) { var r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - S.panX) / S.zoom, y: (ev.clientY - r.top - S.panY) / S.zoom }; }

  function wireCanvas() {
    var pan = null;
    canvas.addEventListener("mousedown", function (e) {
      if (e.target !== canvas && e.target !== world && e.target !== svg && !e.target.classList.contains("ed-frame")) return;
      pan = { x: e.clientX, y: e.clientY, px: S.panX, py: S.panY, moved: false };
      canvas.classList.add("panning");
    });
    window.addEventListener("mousemove", function (e) {
      if (!pan) return;
      if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 3) pan.moved = true;
      S.panX = pan.px + e.clientX - pan.x; S.panY = pan.py + e.clientY - pan.y; applyView();
    });
    window.addEventListener("mouseup", function () {
      if (pan && !pan.moved) { S.selected = null; renderSelection(); renderInspector(); closePop(); }
      pan = null; canvas.classList.remove("panning");
    });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
      else { S.panX -= e.deltaX; S.panY -= e.deltaY; applyView(); }
    }, { passive: false });
  }

  function nodeEl(q) {
    var kids = children(q.id);
    var issues = S.issues[q.id] || [];
    var n = el("div", { class: "ed-node" + (isFollow(q) ? " follow" : "") + (issues.length ? " err" : ""), "data-q": q.id });
    var flags = el("span", { class: "flags" }, [
      q.required ? el("span", { class: "flag req", text: "Required" }) : null,
      q.sensitive ? el("span", { class: "flag", text: "Sensitive" }) : null,
      issues.length ? el("span", { class: "flag errc", title: issues.join("\n"), text: "!" + issues.length }) : null
    ]);
    n.appendChild(el("div", { class: "nh" }, [el("span", { class: "ty", text: TYPES[q.type] || q.type }), el("span", { class: "id", text: q.id }), flags]));
    n.appendChild(el("div", { class: "nt", text: q.prompt_screen || "(no wording yet)" }));
    if (CHOICE.indexOf(q.type) !== -1) {
      var ul = el("ul", { class: "nopts" });
      (q.options || []).forEach(function (o) {
        var fx = o.effects || [];
        var up = fx.filter(function (f) { return f.op === "boost"; }).length, down = fx.length - up;
        var linked = S.flow.questions.some(function (c) { return leaves(c.ask_if).some(function (l) { return l.q === q.id && (l["in"] || []).indexOf(o.value) !== -1; }); });
        var port = el("span", { class: "port" + (linked ? " linked" : ""), title: "Drag onto a question to ask it only after “" + o.label_screen + "”", "data-port": o.value });
        ul.appendChild(el("li", { "data-opt": o.value }, [el("span", { text: o.label_screen }), fx.length ? el("span", { class: "fx", text: (up ? "↑" + up : "") + (down ? " ↓" + down : "") }) : null, port]));
      });
      n.appendChild(ul);
    } else {
      n.appendChild(el("div", { class: "ntyped", text: "Typed answer: " + (TYPES[q.type] || q.type).toLowerCase() }));
    }
    if (kids.length) {
      var open = !!S.expanded[q.id];
      n.appendChild(el("div", { class: "nfoot" }, [el("button", { type: "button", "data-toggle": q.id, "aria-expanded": String(open), text: (open ? "▾ " : "▸ ") + "Follow-ups (" + kids.length + ")" + (open ? "" : ": " + kids.map(function (k) { return k.prompt_screen; }).join(" · ").slice(0, 60)) })]));
    }
    return n;
  }

  function visibleQ(q) {
    var p = parentId(q);
    var guard = 0;
    while (p && isFollow(q) && guard++ < 20) {
      if (!S.expanded[p]) return false;
      q = qById(p); if (!q) return true; p = parentId(q);
    }
    return true;
  }

  function render() {
    // Remove old nodes and frames, keep the svg.
    [].slice.call(world.children).forEach(function (c) { if (c !== svg) c.remove(); });
    S.nodes = {};
    var x0 = LEFT;
    S.frames = [];
    var place = {};
    // Pass 1: create nodes so we can measure them.
    S.flow.questions.forEach(function (q) {
      if (!blockOf(q.id) || !visibleQ(q)) return;
      var n = nodeEl(q); n.style.left = "-9999px"; world.appendChild(n); S.nodes[q.id] = { el: n, h: n.offsetHeight };
    });
    S.flow.blocks.forEach(function (b, bi) {
      var y = TOP, maxDepth = 0;
      var mains = b.questions.filter(function (id) { var q = qById(id); return q && !isFollow(q) && S.nodes[id]; });
      function placeKids(pid, depth, yStart) {
        var yy = yStart;
        children(pid).filter(function (c) { return S.nodes[c.id] && blockOf(c.id) === b; }).forEach(function (c) {
          place[c.id] = { x: x0 + depth * FOLLOW_DX, y: yy };
          maxDepth = Math.max(maxDepth, depth);
          var bottom = Math.max(yy + S.nodes[c.id].h, placeKids(c.id, depth + 1, yy));
          yy = bottom + ROW_GAP;
        });
        return yy - ROW_GAP;
      }
      mains.forEach(function (id) {
        place[id] = { x: x0, y: y };
        var bottom = y + S.nodes[id].h;
        if (S.expanded[id]) bottom = Math.max(bottom, placeKids(id, 1, y));
        y = bottom + ROW_GAP;
      });
      var w = maxDepth * FOLLOW_DX + NODE_W;
      var frame = { id: b.id, x: x0 - 18, y: TOP - 34, w: w + 36, h: Math.max(120, y - TOP + 34 - ROW_GAP + 22), block: b, index: bi };
      S.frames.push(frame);
      var fe = el("div", { class: "ed-frame", "data-block": b.id, style: "left:" + frame.x + "px;top:" + frame.y + "px;width:" + frame.w + "px;height:" + frame.h + "px" }, [
        el("span", { class: "ft", title: "Edit this section", text: (bi + 1) + ". " + b.title + " · " + b.questions.length })
      ]);
      fe.querySelector(".ft").addEventListener("click", function (e) { e.stopPropagation(); S.selected = { type: "block", id: b.id }; renderSelection(); renderInspector(); });
      world.insertBefore(fe, svg);
      x0 += frame.w + COL_GAP;
    });
    Object.keys(S.nodes).forEach(function (id) {
      var p = place[id], n = S.nodes[id];
      if (!p) { n.el.remove(); delete S.nodes[id]; return; }
      n.x = p.x; n.y = p.y; n.el.style.left = p.x + "px"; n.el.style.top = p.y + "px";
      wireNode(id, n.el);
    });
    drawEdges();
    renderSelection();
  }

  function portPos(qid, value) {
    var n = S.nodes[qid]; if (!n) return null;
    var li = n.el.querySelector('li[data-opt="' + CSS.escape(value) + '"]');
    if (!li) return { x: n.x + NODE_W, y: n.y + n.h / 2 };
    return { x: n.x + NODE_W + 1, y: n.y + li.offsetTop + li.offsetHeight / 2 };
  }
  function curve(a, b) { var dx = Math.max(40, Math.abs(b.x - a.x) / 2); return "M" + a.x + "," + a.y + " C" + (a.x + dx) + "," + a.y + " " + (b.x - dx) + "," + b.y + " " + b.x + "," + b.y; }
  function drawEdges() {
    var NS = "http://www.w3.org/2000/svg";
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var b = bounds() || { x: 0, y: 0, w: 1000, h: 800 };
    svg.setAttribute("width", b.x + b.w + 400); svg.setAttribute("height", b.y + b.h + 400);
    var defs = document.createElementNS(NS, "defs");
    defs.innerHTML = '<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#9fb3cc"/></marker><marker id="arrs" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#25b4fa"/></marker>';
    svg.appendChild(defs);
    function path(d, stroke, dash, marker, hit) {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", stroke); p.setAttribute("stroke-width", "2");
      if (dash) p.setAttribute("stroke-dasharray", "6 5");
      if (marker) p.setAttribute("marker-end", "url(#" + marker + ")");
      svg.appendChild(p);
      if (hit) { var h = document.createElementNS(NS, "path"); h.setAttribute("d", d); h.setAttribute("fill", "none"); h.setAttribute("stroke", "transparent"); h.setAttribute("stroke-width", "14"); h.setAttribute("class", "hit"); h.addEventListener("click", hit); svg.appendChild(h); }
    }
    var lastOfPrev = null;
    S.flow.blocks.forEach(function (bl) {
      var mains = bl.questions.filter(function (id) { var q = qById(id); return q && !isFollow(q) && S.nodes[id]; });
      if (lastOfPrev && mains.length) {
        var a = S.nodes[lastOfPrev], c = S.nodes[mains[0]];
        path(curve({ x: a.x + NODE_W, y: a.y + 24 }, { x: c.x - 2, y: c.y + 24 }), "#9fb3cc", true, "arr");
      }
      for (var i = 1; i < mains.length; i++) {
        var p1 = S.nodes[mains[i - 1]], p2 = S.nodes[mains[i]];
        var sx = p1.x + 40;
        path("M" + sx + "," + (p1.y + p1.h) + " L" + sx + "," + (p2.y - 2), "#9fb3cc", false, "arr");
      }
      if (mains.length) lastOfPrev = mains[mains.length - 1];
    });
    S.flow.questions.forEach(function (c) {
      if (!S.nodes[c.id]) return;
      leaves(c.ask_if).forEach(function (l) {
        if (!S.nodes[l.q]) return;
        (l["in"] || []).forEach(function (v) {
          var a = portPos(l.q, v); if (!a) return;
          var t = S.nodes[c.id];
          path(curve(a, { x: t.x - 2, y: t.y + 22 }), "#25b4fa", false, "arrs", function (ev) {
            ev.stopPropagation();
            var parent = qById(l.q), opt = (parent.options || []).find(function (o) { return o.value === v; });
            showPop(ev, "“" + (opt ? opt.label_screen : v) + "” → " + (c.prompt_screen || c.id), "Remove link", function () { unlink(c.id, l.q, v); });
          });
        });
      });
    });
  }

  var pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function showPop(ev, text, btn, fn) {
    closePop();
    var r = canvas.getBoundingClientRect();
    pop = el("div", { class: "ed-pop", style: "left:" + (ev.clientX - r.left + 8) + "px;top:" + (ev.clientY - r.top + 8) + "px" }, [text, el("button", { type: "button", class: "btn sm danger", text: btn, onclick: function () { closePop(); fn(); } })]);
    canvas.appendChild(pop);
  }

  function renderSelection() {
    Object.keys(S.nodes).forEach(function (id) { S.nodes[id].el.classList.toggle("sel", !!(S.selected && S.selected.type === "q" && S.selected.id === id)); });
  }

  /* --------------------------------------------------- node interactions */
  function wireNode(id, n) {
    n.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      var t = e.target;
      if (t.closest("[data-toggle]")) return;
      if (t.classList.contains("port")) { e.stopPropagation(); startLink(e, id, t.getAttribute("data-port")); return; }
      e.stopPropagation();
      startDrag(e, id);
    });
    var tog = n.querySelector("[data-toggle]");
    if (tog) tog.addEventListener("click", function (e) { e.stopPropagation(); S.expanded[id] = !S.expanded[id]; render(); });
  }

  function startDrag(e, id) {
    var node = S.nodes[id], start = toWorld(e), moved = false;
    var q = qById(id);
    function move(ev) {
      var p = toWorld(ev);
      if (!moved && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) < 5) return;
      moved = true;
      node.el.classList.add("dragging");
      node.el.style.left = node.x + p.x - start.x + "px"; node.el.style.top = node.y + p.y - start.y + "px";
    }
    function up(ev) {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      node.el.classList.remove("dragging");
      if (!moved) { S.selected = { type: "q", id: id }; renderSelection(); renderInspector(); return; }
      var p = toWorld(ev), cx = node.x + p.x - start.x + NODE_W / 2, cy = node.y + p.y - start.y + 30;
      if (isFollow(q)) { toast("Follow-ups sit next to the question they follow. Remove its link to move it on its own."); render(); return; }
      var frame = S.frames.find(function (f) { return cx >= f.x && cx <= f.x + f.w + COL_GAP / 2 && cy >= f.y - 40 && cy <= f.y + f.h + 200; });
      if (!frame) { render(); return; }
      moveQuestion(id, frame.block.id, cy);
    }
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }

  function moveQuestion(id, blockId, dropY) {
    var group = [id].concat(descendants(id).filter(function (d) { return blockOf(d) === blockOf(id); }));
    var target = S.flow.blocks.find(function (b) { return b.id === blockId; });
    var mains = target.questions.filter(function (qid) { var q = qById(qid); return q && !isFollow(q) && group.indexOf(qid) === -1 && S.nodes[qid]; });
    var before = mains.find(function (qid) { var n = S.nodes[qid]; return n.y + n.h / 2 > dropY; });
    var oldBlock = blockOf(id), oldIndex = oldBlock.questions.indexOf(id);
    edit("Move question", function () {
      S.flow.blocks.forEach(function (b) { b.questions = b.questions.filter(function (qid) { return group.indexOf(qid) === -1; }); });
      var at = before ? target.questions.indexOf(before) : target.questions.length;
      target.questions.splice.apply(target.questions, [at, 0].concat(group));
    });
    if (oldBlock === target && target.questions.indexOf(id) === oldIndex) { S.undo.pop(); }
  }

  function startLink(e, fromId, value) {
    var a = portPos(fromId, value);
    var NS = "http://www.w3.org/2000/svg";
    var tmp = document.createElementNS(NS, "path");
    tmp.setAttribute("fill", "none"); tmp.setAttribute("stroke", "#25b4fa"); tmp.setAttribute("stroke-width", "2.5"); tmp.setAttribute("stroke-dasharray", "5 4");
    svg.appendChild(tmp);
    var over = null;
    function move(ev) {
      var p = toWorld(ev); tmp.setAttribute("d", curve(a, p));
      var hit = document.elementFromPoint(ev.clientX, ev.clientY);
      var n = hit && hit.closest && hit.closest(".ed-node");
      if (over && over !== n) over.classList.remove("drop-ok");
      over = n && n.getAttribute("data-q") !== fromId ? n : null;
      if (over) over.classList.add("drop-ok");
    }
    function up() {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      tmp.remove();
      if (over) { over.classList.remove("drop-ok"); link(over.getAttribute("data-q"), fromId, value); }
    }
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }

  function link(childId, parentQ, value) {
    var c = qById(childId);
    if (descendants(childId).indexOf(parentQ) !== -1) { toast("That would make a loop: the question you linked from already follows this one."); return; }
    var cur = simpleCond(c);
    if (c.ask_if && !(cur && cur.q === parentQ)) {
      if (!window.confirm("“" + c.prompt_screen + "” already has a different condition. Replace it?")) return;
    }
    edit("Link follow-up", function () {
      if (cur && cur.q === parentQ) { if (cur["in"].indexOf(value) === -1) cur["in"].push(value); }
      else c.ask_if = { q: parentQ, "in": [value] };
      // A follow-up must come after the question it follows: put it (and its own follow-ups) right after the parent's group.
      var pb = blockOf(parentQ);
      var group = [childId].concat(descendants(childId));
      S.flow.blocks.forEach(function (b) { b.questions = b.questions.filter(function (q) { return group.indexOf(q) === -1; }); });
      var afterIds = [parentQ].concat(descendants(parentQ));
      var last = Math.max.apply(null, afterIds.map(function (id) { return pb.questions.indexOf(id); }));
      pb.questions.splice.apply(pb.questions, [last + 1, 0].concat(group));
      S.expanded[parentQ] = true;
    });
    S.selected = { type: "q", id: childId }; renderSelection(); renderInspector();
  }

  function unlink(childId, parentQ, value) {
    var c = qById(childId);
    edit("Remove follow-up link", function () {
      var cur = simpleCond(c);
      if (cur && cur.q === parentQ) {
        cur["in"] = cur["in"].filter(function (v) { return v !== value; });
        if (!cur["in"].length) c.ask_if = null;
      } else c.ask_if = null;
    });
  }

  function addQuestion() {
    var b;
    if (S.selected && S.selected.type === "q") b = blockOf(S.selected.id);
    else if (S.selected && S.selected.type === "block") b = S.flow.blocks.find(function (x) { return x.id === S.selected.id; });
    b = b || S.flow.blocks[S.flow.blocks.length - 1];
    var id = uniqueId("new_question", function (x) { return !!qById(x); });
    edit("Add question", function () {
      S.flow.questions.push({ id: id, domain: b.id, type: "single", prompt_screen: "New question", prompt_voice: "New question", voice_template: null, recap_label: "New question", topic_words: [], help: null, required: false, sensitive: false, skippable: true, ask_if: null,
        options: [{ value: "yes", label_screen: "Yes", label_voice: "yes", aliases: [], effects: [] }, { value: "no", label_screen: "No", label_voice: "no", aliases: [], effects: [] }] });
      var at = S.selected && S.selected.type === "q" ? b.questions.indexOf(S.selected.id) + 1 : b.questions.length;
      b.questions.splice(at, 0, id);
    });
    S.selected = { type: "q", id: id }; renderSelection(); renderInspector();
  }
  function addSection() {
    var id = uniqueId("section", function (x) { return S.flow.blocks.some(function (b) { return b.id === x; }); });
    edit("Add section", function () { S.flow.blocks.push({ id: id, title: "New section", skippable_as_block: false, preamble: null, questions: [] }); });
    S.selected = { type: "block", id: id }; renderInspector();
  }

  /* ---------------------------------------------------------- inspector */
  function field(label, input, hint) { return el("div", null, [el("label", { class: "fl", text: label }), input, hint ? el("p", { class: "hint", style: "margin:3px 0 0", text: hint }) : null]); }
  function textIn(value, onchange, opts) {
    var i = el(opts && opts.area ? "textarea" : "input", { class: "inp", value: opts && opts.area ? null : (value || ""), placeholder: (opts && opts.ph) || "" });
    if (opts && opts.area) i.value = value || "";
    i.addEventListener("change", function () { onchange(i.value); });
    return i;
  }
  function renderInspectorIssues() {
    var box = insp.querySelector("#issues"); if (!box || !S.selected) return;
    box.textContent = "";
    (S.issues[S.selected.id] || []).forEach(function (m) { box.appendChild(el("div", { class: "issue", text: m })); });
  }

  function renderInspector() {
    if (!insp) return;
    insp.textContent = "";
    if (S.viewing) { insp.appendChild(el("h2", { text: "Viewing v" + S.viewing.version })); insp.appendChild(el("p", { text: "This is an old version, shown read-only." })); insp.appendChild(el("button", { type: "button", class: "btn primary", text: "Back to the draft", onclick: stopViewing })); return; }
    var sel = S.selected;
    if (sel && sel.type === "q" && qById(sel.id)) return inspectQuestion(qById(sel.id));
    if (sel && sel.type === "block") { var b = S.flow.blocks.find(function (x) { return x.id === sel.id; }); if (b) return inspectBlock(b); }
    inspectFlow();
  }

  function inspectFlow() {
    insp.appendChild(el("h2", { text: "Workflow" }));
    insp.appendChild(el("p", { class: "hint", text: "Click a question card to edit it, or a section's name to edit the section. Drag cards to reorder; drag an answer's dot onto a card to make a follow-up." }));
    insp.appendChild(el("dl", { class: "kv", style: "font-size:14px" }, [
      el("dt", { text: "Sections" }), el("dd", { text: String(S.flow.blocks.length) }),
      el("dt", { text: "Questions" }), el("dd", { text: String(S.flow.questions.length) }),
      el("dt", { text: "Follow-ups" }), el("dd", { text: String(S.flow.questions.filter(function (q) { return q.ask_if; }).length) }),
      el("dt", { text: "Used by" }), el("dd", { text: S.meta.usedBy.join(", ") || "Nothing live yet" })
    ]));
    if (S.flow.intro != null) insp.appendChild(field("Introduction", textIn(S.flow.intro, function (v) { edit("Edit intro", function () { S.flow.intro = v; }, { inspector: false }); }, { area: true })));
    if (S.flow.privacy_notice != null) insp.appendChild(field("Privacy notice", textIn(S.flow.privacy_notice, function (v) { edit("Edit privacy notice", function () { S.flow.privacy_notice = v; }, { inspector: false }); }, { area: true })));
    if (S.meta.routing) inspectHandoffs();
  }

  function inspectHandoffs() {
    var box = el("details", null, [el("summary", { text: "Handoffs: outside-the-directory help (" + (S.flow.handoffs || []).length + ")" })]);
    (S.flow.handoffs || []).forEach(function (h, i) {
      var c = simpleCond({ ask_if: h.trigger });
      var trig = c ? "When “" + ((qById(c.q) || {}).prompt_screen || c.q) + "” is " + c["in"].join(" or ") : "Custom condition";
      box.appendChild(el("div", { class: "opt" }, [
        el("div", { class: "hint", text: trig }),
        field("Headline", textIn(h.headline, function (v) { edit("Edit handoff", function () { S.flow.handoffs[i].headline = v; }, { inspector: false }); })),
        field("Message", textIn(h.body, function (v) { edit("Edit handoff", function () { S.flow.handoffs[i].body = v; }, { inspector: false }); }, { area: true }))
      ]));
    });
    insp.appendChild(box);
  }

  function inspectBlock(b) {
    insp.appendChild(el("h2", { text: "Section" }));
    insp.appendChild(field("Title", textIn(b.title, function (v) { edit("Rename section", function () { b.title = v; }); })));
    insp.appendChild(field("Said before the section (optional)", textIn(b.preamble, function (v) { edit("Edit section intro", function () { b.preamble = v || null; }, { inspector: false }); }, { area: true })));
    var cb = el("input", { type: "checkbox" }); cb.checked = !!b.skippable_as_block;
    cb.addEventListener("change", function () { edit("Section skippable", function () { b.skippable_as_block = cb.checked; }, { inspector: false }); });
    insp.appendChild(el("div", { class: "checks" }, [el("label", null, [cb, " People can skip the whole section"])]));
    var i = S.flow.blocks.indexOf(b);
    insp.appendChild(el("div", { class: "req-actions" }, [
      el("button", { type: "button", class: "btn sm", text: "← Move earlier", disabled: i === 0 ? "" : null, onclick: function () { edit("Move section", function () { S.flow.blocks.splice(i, 1); S.flow.blocks.splice(i - 1, 0, b); }); } }),
      el("button", { type: "button", class: "btn sm", text: "Move later →", disabled: i === S.flow.blocks.length - 1 ? "" : null, onclick: function () { edit("Move section", function () { S.flow.blocks.splice(i, 1); S.flow.blocks.splice(i + 1, 0, b); }); } })
    ]));
    if (!b.questions.length) {
      var del = A.confirm2(el("button", { type: "button", class: "btn sm danger", text: "Delete empty section" }), "Yes, delete", function () { edit("Delete section", function () { S.flow.blocks.splice(S.flow.blocks.indexOf(b), 1); }); S.selected = null; renderInspector(); });
      insp.appendChild(el("p", null, [del]));
    } else insp.appendChild(el("p", { class: "hint", text: "Move or delete its " + b.questions.length + " questions to delete this section." }));
  }

  function inspectQuestion(q) {
    insp.appendChild(el("h2", { text: "Question" }));
    insp.appendChild(el("div", { id: "issues" }));
    renderInspectorIssues();
    insp.appendChild(el("p", { class: "hint", style: "margin:0", text: "id " + q.id + " · in " + blockOf(q.id).title }));
    insp.appendChild(field("On screen", textIn(q.prompt_screen, function (v) { edit("Edit wording", function () { q.prompt_screen = v; }, { inspector: false }); }, { area: true })));
    if (q.voice_template != null) {
      insp.appendChild(field("Spoken by the assistant", textIn(q.voice_template, function (v) { edit("Edit spoken wording", function () { q.voice_template = v; q.prompt_voice = v.replace(/\{(\w+)\}/g, function (m, k) { return ({ S: "the person", Sc: "The person", pos: "their", obj: "them", Do: "Does", do: "does", Be: "Is", be: "is", Have: "Has", have: "has", s: "s", re: "they're" })[k] || m; }); }, { inspector: false }); }, { area: true }),
        "{S} becomes “you”, “they” or the person's name; {pos} their, {obj} them, {do}/{Do}, {be}/{Be}, {have}/{Have}."));
    } else {
      insp.appendChild(field("Spoken by the assistant", textIn(q.prompt_voice, function (v) { edit("Edit spoken wording", function () { q.prompt_voice = v; }, { inspector: false }); }, { area: true })));
    }
    if (S.meta.routing) {
      insp.appendChild(field("Recap label", textIn(q.recap_label, function (v) { edit("Edit recap label", function () { q.recap_label = v; }, { inspector: false }); }), "A few words the assistant uses when it reads the answers back, e.g. “Last eye exam”."));
      insp.appendChild(field("Topic words", textIn((q.topic_words || []).join(", "), function (v) { edit("Edit topic words", function () { q.topic_words = v.split(",").map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean); }, { inspector: false }); }), "Comma-separated words that mean this question, so people can correct it (“my age is…”)."));
    }
    insp.appendChild(field("Help text (optional)", textIn(q.help, function (v) { edit("Edit help", function () { q.help = v || null; }, { inspector: false }); }, { area: true })));
    var type = el("select", { class: "inp" }, Object.keys(TYPES).map(function (k) { var o = el("option", { value: k, text: TYPES[k] }); if (k === q.type) o.selected = true; return o; }));
    type.addEventListener("change", function () {
      var t = type.value;
      if (CHOICE.indexOf(t) === -1 && (q.options || []).length && !window.confirm("A typed answer has no answer options. Remove this question's " + q.options.length + " answers?")) { type.value = q.type; return; }
      edit("Change type", function () {
        q.type = t;
        if (CHOICE.indexOf(t) === -1) q.options = [];
        else if (t === "consent") q.options = [{ value: "yes", label_screen: "Yes, I agree", label_voice: "yes", aliases: [], effects: [] }];
        else if (!q.options.length) q.options = [{ value: "yes", label_screen: "Yes", label_voice: "yes", aliases: [], effects: [] }, { value: "no", label_screen: "No", label_voice: "no", aliases: [], effects: [] }];
      });
    });
    insp.appendChild(field("Answer type", type));
    function flag(key, label, after) {
      var cb = el("input", { type: "checkbox" }); cb.checked = !!q[key];
      cb.addEventListener("change", function () { edit("Change " + key, function () { q[key] = cb.checked; if (after) after(cb.checked); }, { inspector: false }); });
      return el("label", null, [cb, " " + label]);
    }
    insp.appendChild(el("div", { class: "checks" }, [flag("required", "Required", function (v) { q.skippable = !v; }), flag("sensitive", "Sensitive"), flag("skippable", "Can skip")]));

    // When it's asked
    var cond = simpleCond(q);
    var condBox = el("div", { class: "opt" }, [el("strong", { text: "When it's asked" })]);
    var earlier = [];
    S.flow.blocks.some(function (b) { return b.questions.some(function (id) { if (id === q.id) return true; var x = qById(id); if (x && CHOICE.indexOf(x.type) !== -1) earlier.push(x); return false; }); });
    if (q.ask_if && !cond) condBox.appendChild(el("p", { class: "hint", text: "A combined condition: " + JSON.stringify(q.ask_if) }));
    var pick = el("select", { class: "inp" }, [el("option", { value: "", text: "Always" })].concat(earlier.map(function (x) { var o = el("option", { value: x.id, text: "Only if “" + x.prompt_screen.slice(0, 50) + "” is…" }); if (cond && cond.q === x.id) o.selected = true; return o; })));
    pick.addEventListener("change", function () {
      edit("Change condition", function () {
        if (!pick.value) q.ask_if = null;
        else { var p = qById(pick.value); q.ask_if = { q: p.id, "in": [p.options[0].value] }; }
      });
    });
    condBox.appendChild(pick);
    if (cond && qById(cond.q)) {
      var vals = el("div", { class: "checks" });
      qById(cond.q).options.forEach(function (o) {
        var cb = el("input", { type: "checkbox" }); cb.checked = cond["in"].indexOf(o.value) !== -1;
        cb.addEventListener("change", function () { edit("Change condition", function () { cond["in"] = cond["in"].filter(function (v) { return v !== o.value; }); if (cb.checked) cond["in"].push(o.value); if (!cond["in"].length) q.ask_if = null; }); });
        vals.appendChild(el("label", null, [cb, " " + o.label_screen]));
      });
      condBox.appendChild(vals);
    }
    insp.appendChild(condBox);

    if (CHOICE.indexOf(q.type) !== -1) inspectOptions(q);

    var moveTo = el("select", { class: "inp" }, S.flow.blocks.map(function (b) { var o = el("option", { value: b.id, text: b.title }); if (b === blockOf(q.id)) o.selected = true; return o; }));
    moveTo.addEventListener("change", function () { moveQuestion(q.id, moveTo.value, Infinity); });
    insp.appendChild(field("Section", moveTo));

    var deps = S.flow.questions.filter(function (x) { return leaves(x.ask_if).some(function (l) { return l.q === q.id; }); });
    var hand = (S.flow.handoffs || []).filter(function (h) { return leaves(h.trigger).some(function (l) { return l.q === q.id; }); });
    var del = A.confirm2(el("button", { type: "button", class: "btn sm danger", text: "Delete question" }), deps.length || hand.length ? "Delete and unlink " + (deps.length + hand.length) : "Yes, delete", function () {
      edit("Delete question", function () {
        deps.forEach(function (d) { d.ask_if = null; });
        S.flow.handoffs = (S.flow.handoffs || []).filter(function (h) { return hand.indexOf(h) === -1; });
        S.flow.questions = S.flow.questions.filter(function (x) { return x !== q; });
        S.flow.blocks.forEach(function (b) { b.questions = b.questions.filter(function (id) { return id !== q.id; }); });
      });
      S.selected = null; renderInspector();
    });
    insp.appendChild(el("p", { style: "margin-top:14px" }, [del, deps.length || hand.length ? el("span", { class: "hint", style: "margin-left:8px", text: (deps.length ? deps.length + " follow-up(s) become always-asked. " : "") + (hand.length ? hand.length + " handoff(s) are removed." : "") }) : null]));
  }

  function inspectOptions(q) {
    var box = el("div", { style: "margin-top:12px" }, [el("strong", { text: "Answers (" + q.options.length + ")" })]);
    q.options.forEach(function (o, i) {
      var row = el("div", { class: "opt" });
      var label = textIn(o.label_screen, function (v) { edit("Edit answer", function () { o.label_screen = v; if (!o.label_voice || o.label_voice === o._lv) o.label_voice = v.toLowerCase(); }); });
      row.appendChild(el("div", { class: "row" }, [label,
        el("button", { type: "button", class: "iconbtn", title: "Move up", text: "↑", disabled: i === 0 ? "" : null, onclick: function () { edit("Reorder answers", function () { q.options.splice(i, 1); q.options.splice(i - 1, 0, o); }); } }),
        el("button", { type: "button", class: "iconbtn", title: "Move down", text: "↓", disabled: i === q.options.length - 1 ? "" : null, onclick: function () { edit("Reorder answers", function () { q.options.splice(i, 1); q.options.splice(i + 1, 0, o); }); } }),
        el("button", { type: "button", class: "iconbtn", title: "Remove answer", text: "✕", onclick: function () {
          var used = S.flow.questions.some(function (x) { return leaves(x.ask_if).some(function (l) { return l.q === q.id && l["in"].indexOf(o.value) !== -1; }); });
          if (used && !window.confirm("A follow-up depends on this answer. Remove it and its links?")) return;
          edit("Remove answer", function () {
            q.options.splice(i, 1);
            S.flow.questions.forEach(function (x) { leaves(x.ask_if).forEach(function (l) { if (l.q === q.id) l["in"] = l["in"].filter(function (v) { return v !== o.value; }); }); var c = simpleCond(x); if (c && !c["in"].length) x.ask_if = null; });
          });
        } })
      ]));
      var more = el("details", null, [el("summary", { text: "Spoken label, other phrasings" + (S.meta.routing ? ", effects (" + (o.effects || []).length + ")" : "") })]);
      more.appendChild(el("p", { class: "hint", style: "margin:4px 0 0", text: "Value: " + o.value }));
      more.appendChild(field("Spoken label", textIn(o.label_voice, function (v) { edit("Edit answer", function () { o.label_voice = v; }, { inspector: false }); })));
      more.appendChild(field("Other ways people say it (comma separated)", textIn((o.aliases || []).join(", "), function (v) { edit("Edit phrasings", function () { o.aliases = v.split(",").map(function (s) { return s.trim(); }).filter(Boolean); }, { inspector: false }); })));
      if (S.meta.routing) inspectEffects(o, more);
      row.appendChild(more);
      box.appendChild(row);
    });
    box.appendChild(el("button", { type: "button", class: "btn sm", style: "margin-top:8px", text: "+ Add answer", onclick: function () {
      var label = window.prompt("New answer:"); if (!label) return;
      var v = uniqueId(slug(label), function (x) { return q.options.some(function (o) { return o.value === x; }); });
      edit("Add answer", function () { q.options.push({ value: v, label_screen: label, label_voice: label.toLowerCase(), aliases: [], effects: [] }); });
    } }));
    insp.appendChild(box);
  }

  function inspectEffects(o, box) {
    var orgs = S.orgs || { list: [], byId: {}, cats: [] };
    (o.effects || []).forEach(function (f, i) {
      var who = f.target === "org" ? ((orgs.byId[f.id] || {}).name || f.id) : "all “" + f.id + "” services";
      var e = el("div", { class: "eff" });
      var op = el("select", { class: "inp" }, [el("option", { value: "boost", text: "Raise" }), el("option", { value: "suppress", text: "Lower" })]); op.value = f.op;
      op.addEventListener("change", function () { edit("Edit effect", function () { f.op = op.value; f.weight = (op.value === "suppress" ? -1 : 1) * Math.abs(f.weight); }); });
      var w = el("input", { class: "inp", type: "number", min: "0", max: "100", value: String(Math.abs(f.weight)), style: "max-width:80px" });
      w.addEventListener("change", function () { edit("Edit effect", function () { f.weight = (f.op === "suppress" ? -1 : 1) * Math.min(100, Math.abs(Number(w.value) || 0)); }, { inspector: false }); });
      e.appendChild(el("div", { class: "row" }, [op, w, el("button", { type: "button", class: "iconbtn", text: "✕", title: "Remove effect", onclick: function () { edit("Remove effect", function () { o.effects.splice(i, 1); }); } })]));
      e.appendChild(el("div", { class: "hint", text: who }));
      e.appendChild(field("Reason people see", textIn(f.because, function (v) { edit("Edit reason", function () { f.because = v; }, { inspector: false }); }, { area: true })));
      e.appendChild(el("div", { class: "hint", text: "Evidence: " + (f.evidence ? ((orgs.byId[f.evidence.org_id] || {}).name || f.evidence.org_id) + " — “" + f.evidence.branch_condition + "”" : "none") }));
      box.appendChild(e);
    });
    box.appendChild(el("button", { type: "button", class: "btn sm", style: "margin-top:6px", text: "+ Add effect", onclick: function () { openEffectPicker(o); } }));
  }

  function openEffectPicker(o) {
    var orgs = S.orgs;
    if (!orgs) { toast("Still loading organizations…"); return; }
    var target = el("input", { class: "inp", list: "org-list", placeholder: "Type an organization or category" });
    var dl = el("datalist", { id: "org-list" }, orgs.list.map(function (x) { return el("option", { value: x.name }); }).concat(orgs.cats.map(function (c) { return el("option", { value: "Category: " + c }); })));
    var op = el("select", { class: "inp" }, [el("option", { value: "boost", text: "Raise" }), el("option", { value: "suppress", text: "Lower" })]);
    var weight = el("input", { class: "inp", type: "number", value: "25", min: "1", max: "100" });
    var because = el("textarea", { class: "inp", placeholder: "Why this answer matters, in words the person will see" });
    var evOrg = el("select", { class: "inp" }, [el("option", { value: "", text: "Choose the organization whose record supports this" })].concat(orgs.list.filter(function (x) { return x.conditions.length; }).map(function (x) { return el("option", { value: x.id, text: x.name }); })));
    var evCond = el("select", { class: "inp" });
    function fillConds() { evCond.textContent = ""; var x = orgs.byId[evOrg.value]; (x ? x.conditions : []).forEach(function (c) { evCond.appendChild(el("option", { value: c, text: c })); }); }
    evOrg.addEventListener("change", fillConds);
    target.addEventListener("change", function () { var x = orgs.list.find(function (y) { return y.name === target.value; }); if (x && x.conditions.length) { evOrg.value = x.id; fillConds(); } });
    var err = el("p", { class: "issue", hidden: "" });
    modal("Add an effect", [
      el("p", { class: "hint", text: "Effects move organizations up or down the suggestions when someone gives this answer. Each one must cite a referral condition already verified in an organization's record." }),
      field("Organization or category", target), dl,
      el("div", { class: "row", style: "display:flex;gap:8px" }, [field("Raise or lower", op), field("Weight (1–100)", weight)]),
      field("Reason people see", because), field("Evidence from", evOrg), field("Verified condition", evCond), err
    ], "Add effect", function (close) {
      var val = target.value.trim(), t, id;
      if (/^Category: /.test(val)) { t = "category"; id = val.slice(10); if (orgs.cats.indexOf(id) === -1) id = null; }
      else { t = "org"; var x = orgs.list.find(function (y) { return y.name === val || y.id === val; }); id = x ? x.id : null; }
      if (!id) { err.hidden = false; err.textContent = "Pick an organization or category from the list."; return; }
      if (!because.value.trim() || !evOrg.value || !evCond.value) { err.hidden = false; err.textContent = "Add a reason and choose the evidence."; return; }
      var w = Math.min(100, Math.abs(Number(weight.value) || 0));
      edit("Add effect", function () { o.effects = o.effects || []; o.effects.push({ op: op.value, target: t, id: id, weight: op.value === "suppress" ? -w : w, because: because.value.trim(), evidence: { org_id: evOrg.value, branch_condition: evCond.value } }); });
      close();
    });
  }

  /* ------------------------------------------------------------ modals */
  function modal(title, body, okText, onOk) {
    var back = el("div", { class: "modal-back" });
    function close() { back.remove(); document.removeEventListener("keydown", esc); }
    function esc(e) { if (e.key === "Escape") close(); }
    var ok = okText ? el("button", { type: "button", class: "btn primary", text: okText, onclick: function () { onOk(close, ok); } }) : null;
    back.appendChild(el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [el("h2", { text: title })].concat(body).concat([el("div", { class: "foot" }, [el("button", { type: "button", class: "btn", text: okText ? "Cancel" : "Close", onclick: close }), ok])])));
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.addEventListener("keydown", esc);
    document.body.appendChild(back);
    var first = back.querySelector("input, textarea, select, .btn.primary"); if (first) first.focus();
    return close;
  }

  function checkBody(r) {
    var out = [];
    var c = r.checks;
    out.push(el("p", null, [el("span", { class: "chip " + (c.ok ? "ok" : "bad"), text: c.ok ? "Ready to publish" : c.errors.length + " issue" + (c.errors.length === 1 ? "" : "s") + " to fix" })]));
    if (c.errors.length) out.push(el("ul", { class: "issue-list" }, c.errors.map(function (e) {
      var li = el("li", { text: e.message });
      li.addEventListener("click", function () { var m = /^question:([^:]+)/.exec(e.where); if (m && qById(m[1])) { document.querySelector(".modal-back").remove(); S.selected = { type: "q", id: m[1] }; revealQ(m[1]); renderInspector(); } });
      return li;
    })));
    if (c.warnings.length) out.push(el("details", null, [el("summary", { text: c.warnings.length + " note" + (c.warnings.length === 1 ? "" : "s") }), el("ul", null, c.warnings.map(function (w) { return el("li", { class: "hint", text: w.message }); }))]));
    if (r.impact) {
      var im = r.impact;
      out.push(el("h3", { text: "Effect on suggestions" }));
      out.push(el("p", { class: "hint", text: im.changed + " of " + im.personas + " test people would get different suggestions." }));
      var name2 = function (id) { return ((S.orgs && S.orgs.byId[id]) || {}).name || id; };
      out.push(el("div", { class: "table-wrap" }, [el("table", { class: "t" }, [el("thead", null, [el("tr", null, [el("th", { text: "Test person" }), el("th", { text: "What changes" })])]), el("tbody", null, im.rows.map(function (x) {
        var what = !x.changed ? [el("span", { class: "muted", text: "No change" })] : [].concat(x.added.map(function (id) { return el("div", { class: "diff-add", text: "+ " + name2(id) }); }), x.removed.map(function (id) { return el("div", { class: "diff-del", text: name2(id) }); }), x.reordered ? [el("div", { text: "Same services, new order" })] : []);
        return el("tr", null, [el("td", { text: x.label }), el("td", null, what)]);
      }))])]));
    }
    return out;
  }
  function openCheck() {
    save().then(function () { return A.api("POST", "/api/flows/" + flowId + "/check", { flow: S.flow }); }).then(function (r) { setIssues(r.checks); modal("Check", checkBody(r)); }).catch(function (e) { toast("Couldn't check: " + e.message); });
  }
  function openPublish() {
    if (!S.hasDraft && !S.dirty) { toast("No changes to publish yet."); return; }
    save().then(function () { return A.api("POST", "/api/flows/" + flowId + "/check", { flow: S.flow }); }).then(function (r) {
      setIssues(r.checks);
      var who = el("input", { class: "inp", value: name, placeholder: "Your name" });
      var note = el("textarea", { class: "inp", placeholder: "What changed and why (shown in the version log and change log)" });
      modal("Publish v" + (S.version + 1), [
        el("p", { text: "Publishing makes this draft the live version" + (S.meta.usedBy.length ? " for: " + S.meta.usedBy.join(", ") : "") + ". It's checked automatically and goes live in about 3–5 minutes. You can always revert." }),
        field("Your name", who), field("Note", note)
      ].concat(checkBody(r)), r.checks.ok ? "Publish" : null, function (close, btn) {
        name = who.value.trim(); try { localStorage.setItem("v360-editor-name", name); } catch (e) {}
        btn.disabled = true; btn.textContent = "Publishing…";
        A.api("POST", "/api/flows/" + flowId + "/publish", { name: name || "Someone", note: note.value }).then(function (res) {
          close(); toast("v" + res.version + (res.state === "proposed" ? " sent. " : " published. ") + res.live); setTimeout(function () { location.reload(); }, 1800);
        }).catch(function (e) { btn.disabled = false; btn.textContent = "Publish"; toast("Couldn't publish: " + e.message); });
      });
    }).catch(function (e) { toast("Couldn't check: " + e.message); });
  }

  /* ---------------------------------------------------------- versions */
  function renderRail() {
    rail.textContent = "";
    rail.appendChild(el("h2", { text: "Versions" }));
    if (S.hasDraft) rail.appendChild(el("div", { class: "ver current" }, [el("div", { class: "v", text: "Draft" }), el("div", { class: "meta", text: "Not published yet" })]));
    S.versions.forEach(function (v, i) {
      var acts = el("div", { class: "acts" }, [
        el("button", { type: "button", class: "btn sm", text: "View", onclick: function () { viewVersion(v); } }),
        el("button", { type: "button", class: "btn sm", text: "Compare", onclick: function () { compare(v); } })
      ]);
      if (i > 0) acts.appendChild(A.confirm2(el("button", { type: "button", class: "btn sm", text: "Revert to v" + v.version }), "Yes, revert", function () {
        A.api("POST", "/api/flows/" + flowId + "/revert", { version: v.version, name: name || "Someone" }).then(function (r) { toast("Reverted: now v" + r.version + ". " + r.live); setTimeout(function () { location.reload(); }, 1600); }).catch(function (e) { toast("Couldn't revert: " + e.message); });
      }));
      rail.appendChild(el("div", { class: "ver" + (i === 0 && !S.hasDraft ? " current" : "") }, [
        el("div", { class: "v", text: "v" + v.version + (i === 0 ? " · live" : "") }),
        el("div", { class: "meta", text: [v.date ? A.ago(v.date) : "", v.author ? "by " + v.author : ""].filter(Boolean).join(" ") }),
        v.note ? el("div", { class: "meta", text: v.note }) : null,
        acts
      ]));
    });
  }
  function viewVersion(v) {
    A.api("GET", "/api/flows/" + flowId + "/versions/" + v.sha).then(function (r) {
      if (!S.viewing) S.viewingSaved = S.flow;
      S.viewing = { version: v.version }; S.flow = r.flow; render(); renderInspector();
      banner("Viewing v" + v.version + " (read-only).", "Back to the draft", stopViewing);
    });
  }
  function stopViewing() { if (!S.viewing) return; S.flow = S.viewingSaved; S.viewing = null; if (bannerEl) bannerEl.remove(); render(); renderInspector(); }
  function compare(v) {
    A.api("GET", "/api/flows/" + flowId + "/versions/" + v.sha).then(function (r) {
      var cur = S.viewing ? S.viewingSaved : S.flow, old = r.flow;
      var rows = [];
      var oldIds = old.questions.map(function (q) { return q.id; }), curIds = cur.questions.map(function (q) { return q.id; });
      cur.questions.forEach(function (q) {
        if (oldIds.indexOf(q.id) === -1) { rows.push(el("li", { class: "diff-add", text: "Added: " + q.prompt_screen })); return; }
        var o = old.questions.find(function (x) { return x.id === q.id; });
        var changes = ["prompt_screen", "voice_template", "prompt_voice", "recap_label", "topic_words", "help", "type", "required", "sensitive", "skippable", "ask_if", "options"].filter(function (k) { return JSON.stringify(o[k]) !== JSON.stringify(q[k]); });
        if (changes.length) rows.push(el("li", null, [el("strong", { text: q.prompt_screen }), " — changed: " + changes.map(function (k) { return { prompt_screen: "wording", voice_template: "spoken wording", prompt_voice: "spoken wording", ask_if: "when it's asked", options: "answers/effects" }[k] || k; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(", ")]));
      });
      old.questions.forEach(function (q) { if (curIds.indexOf(q.id) === -1) rows.push(el("li", { class: "diff-del", text: "Removed: " + q.prompt_screen })); });
      if (JSON.stringify(old.blocks.map(function (b) { return [b.id, b.title, b.questions]; })) !== JSON.stringify(cur.blocks.map(function (b) { return [b.id, b.title, b.questions]; }))) rows.push(el("li", { text: "Sections or question order changed." }));
      modal("v" + v.version + " compared with " + (S.hasDraft ? "your draft" : "the live version"), rows.length ? [el("ul", null, rows)] : [el("p", { text: "No differences." })]);
    });
  }

  function revealQ(id) {
    var q = qById(id), p = parentId(q), g = 0;
    while (p && g++ < 20) { S.expanded[p] = true; p = parentId(qById(p) || {}); }
    render();
    var n = S.nodes[id]; if (!n) return;
    var r = canvas.getBoundingClientRect();
    S.panX = r.width / 2 - (n.x + NODE_W / 2) * S.zoom; S.panY = r.height / 3 - n.y * S.zoom; applyView();
  }

  /* -------------------------------------------------------------- load */
  Promise.all([A.api("GET", "/api/flows/" + flowId), A.api("GET", "/api/flows")]).then(function (r) {
    var j = r[0];
    S.meta = j.meta; S.published = j.published; S.versions = j.versions; S.version = j.version; S.editsOn = r[1].editsOn;
    S.flow = j.draft ? j.draft.flow : JSON.parse(JSON.stringify(j.published));
    S.draftRevision = j.draft ? j.draft.draftRevision : 0; S.hasDraft = !!j.draft;
    document.title = S.meta.title + " — Workflow editor — VISION360 admin";
    build();
    setStatus(S.hasDraft ? "Draft (not published) · saved " + A.ago(j.draft.updated_at) : "Up to date", S.hasDraft ? "amber" : "ok");
    if (r[1].publishing === "off") banner("Publishing is off on this site: you can edit and save drafts, and file a request. (" + (r[1].storage === "github" ? "The publish key isn't set up yet." : "GitHub isn't connected yet.") + ")", null);
    else if (r[1].storage !== "github") banner("GitHub isn't connected: published versions are kept on this machine only.", null);
    if (!S.editsOn) banner("Editing is switched off on this site.", null);
    document.getElementById("discard").hidden = !S.hasDraft;
    renderRail(); render(); renderInspector();
    // Start readable at the first section; Fit shows the whole tree.
    S.zoom = 0.8; S.panX = 10; S.panY = 40; applyView();
    A.api("POST", "/api/flows/" + flowId + "/check", { flow: S.flow }).then(function (c) { setIssues(c.checks); }).catch(function () {});
  }).catch(function (e) { root.textContent = "Couldn't load this workflow: " + e.message; });

  fetch("/data/organizations.json").then(function (r) { return r.json(); }).then(function (list) {
    var byId = {}, cats = {};
    var out = list.map(function (o) {
      var conds = []; (o.access_path || []).forEach(function (s) { (s.branches || []).forEach(function (b) { if (b.condition && conds.indexOf(b.condition) === -1) conds.push(b.condition); }); });
      (o.categories || []).forEach(function (c) { cats[c] = 1; });
      var x = { id: o.id, name: o.name, conditions: conds }; byId[o.id] = x; return x;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    S.orgs = { list: out, byId: byId, cats: Object.keys(cats).sort() };
  }).catch(function () {});
})();
