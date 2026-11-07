/* Conversations: every assistant conversation, with filters at the top and
   permanent delete (one or many) that needs the word DELETE typed to confirm.
   Sign-in is handled by the admin shell (a signed-out visit goes to /admin/login/). */
(function () {
  "use strict";
  var A = window.V360Admin;
  var $ = function (id) { return document.getElementById(id); };
  var el = A.el;
  function api(method, path, body) { return A.api(method, path, body); }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : ""; }
  var STAFF_STATUS = { pending: "Pending", reviewed: "Reviewed", needs_follow_up: "Needs follow-up" };
  var PHASE = { name: "Giving name", opening: "Just started", intake: "Answering questions", recap: "Checking summary", results: "Has suggestions", email_address: "Giving email", email_confirm_address: "Giving email", email_consent: "Deciding on email", staff_contact: "Asking for staff", staff_confirm: "Asking for staff", closed: "Ended" };
  var FIELDS = ["flow", "status", "stage", "attention", "from", "to"];
  var PAGE = 50;
  var shown = [], selected = new Set(), total = 0, flowsKnown = false, current = null;

  function show(id) { ["list", "detail"].forEach(function (x) { $(x).hidden = x !== id; }); }

  // Filters live in the URL, so a filtered view can be bookmarked or shared.
  function readFilters() {
    var q = new URLSearchParams(location.search);
    FIELDS.forEach(function (k) { var v = q.get(k); if (v != null && $("f-" + k)) $("f-" + k).value = v; });
  }
  function query(offset) {
    var q = new URLSearchParams();
    FIELDS.forEach(function (k) { var v = $("f-" + k).value; if (v && v !== "all") q.set(k, v); });
    var url = location.pathname + (q.toString() ? "?" + q.toString() : "");
    if (url !== location.pathname + location.search) history.replaceState(null, "", url);
    q.set("limit", PAGE); q.set("offset", offset || 0);
    return "/api/staff/sessions?" + q.toString();
  }
  FIELDS.forEach(function (k) { $("f-" + k).addEventListener("change", function () { loadList(); }); });
  $("f-clear").addEventListener("click", function () { FIELDS.forEach(function (k) { $("f-" + k).value = k === "attention" || k === "from" || k === "to" ? "" : "all"; }); loadList(); });
  $("more").addEventListener("click", function () { loadList(shown.length); });
  $("back").addEventListener("click", function () { history.replaceState(null, "", location.pathname + location.search); loadList(); });

  function fillFlows(flows) {
    var sel = $("f-flow"), keep = sel.value || new URLSearchParams(location.search).get("flow") || "all";
    sel.textContent = "";
    sel.appendChild(el("option", { value: "all", text: "All conversations" }));
    flows.forEach(function (f) { sel.appendChild(el("option", { value: f.id, text: f.title + (f.live ? "" : " (deleted workflow)") })); });
    sel.value = keep;
    if (sel.value !== keep) sel.value = "all";
    flowsKnown = true;
  }

  function updateBulk() {
    var n = selected.size;
    $("del-selected").disabled = !n;
    $("del-selected").textContent = n ? "Delete selected (" + n + ")" : "Delete selected";
    var all = $("sel-all");
    all.checked = shown.length > 0 && shown.every(function (s) { return selected.has(s.id); });
    all.indeterminate = !all.checked && shown.some(function (s) { return selected.has(s.id); });
    $("count").textContent = total ? "Showing " + shown.length + " of " + total + (n ? " · " + n + " selected" : "") : "";
  }
  $("sel-all").addEventListener("change", function () {
    var on = this.checked;
    shown.forEach(function (s) { if (on) selected.add(s.id); else selected.delete(s.id); });
    Array.prototype.forEach.call(document.querySelectorAll("#rows input[type=checkbox]"), function (c) { c.checked = on; c.closest("tr").classList.toggle("selected", on); });
    updateBulk();
  });

  function loadList(offset) {
    offset = offset || 0;
    if (!offset) { shown = []; selected.clear(); }
    api("GET", query(offset)).then(function (j) {
      show("list");
      if (!flowsKnown || !offset) fillFlows(j.flows || []);
      total = j.total;
      var tb = $("rows");
      if (!offset) tb.textContent = "";
      if (!j.sessions.length && !offset) tb.appendChild(el("tr", null, [el("td", { colspan: "8", text: j.totalAll ? "No conversations match these filters." : "No conversations yet." })]));
      j.sessions.forEach(function (s) {
        shown.push(s);
        var email = s.actions.filter(function (a) { return a.type === "email_plan"; }).map(function (a) { return a.status.replace(/_/g, " "); }).join(", ") || "—";
        var box = el("input", { type: "checkbox", "aria-label": "Select conversation updated " + when(s.updated_at) });
        var tr = el("tr", null, [
          el("td", { class: "ck" }, [box]),
          el("td", { text: when(s.updated_at) }),
          el("td", null, [el("span", { class: "flow-chip" + (s.flowLive ? "" : " gone"), text: (s.flow_title || s.flow_id) + (s.flowLive ? "" : " (deleted)") })]),
          el("td", { text: PHASE[s.phase] || s.phase || "" }),
          el("td", { text: STAFF_STATUS[s.staff_status] || s.staff_status }),
          el("td", { text: s.openReviews ? s.openReviews + " request(s)" : "—" }),
          el("td", { text: email }),
          el("td", null, [el("button", { type: "button", class: "btn", text: "Open", "aria-label": "Open conversation updated " + when(s.updated_at), onclick: function () { openDetail(s.id); } })])
        ]);
        box.addEventListener("change", function () { if (box.checked) selected.add(s.id); else selected.delete(s.id); tr.classList.toggle("selected", box.checked); updateBulk(); });
        tb.appendChild(tr);
      });
      $("more").hidden = shown.length >= total;
      updateBulk();
    }).catch(function (e) { $("rows").textContent = "Couldn't load conversations: " + e.message; });
  }

  // ---- Delete: always asks, and needs DELETE typed exactly ----
  var pending = [];
  function askDelete(ids) {
    pending = ids.slice();
    var n = pending.length;
    $("del-title").textContent = n === 1 ? "Delete this conversation?" : "Delete " + n + " conversations?";
    $("del-warning").textContent = "You are about to permanently delete " + (n === 1 ? "1 conversation" : n + " conversations") + " and everything recorded with " + (n === 1 ? "it" : "them") + ": answers, suggestions, emails and follow-up requests.";
    $("del-input").value = "";
    $("del-go").disabled = true;
    $("del-error").hidden = true;
    var d = $("del-dialog");
    if (d.showModal) d.showModal(); else d.setAttribute("open", "");
    $("del-input").focus();
  }
  function closeDelete() { var d = $("del-dialog"); if (d.close) d.close(); else d.removeAttribute("open"); }
  $("del-input").addEventListener("input", function () { $("del-go").disabled = this.value !== "DELETE"; });
  $("del-cancel").addEventListener("click", closeDelete);
  $("del-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if ($("del-input").value !== "DELETE") return;
    $("del-go").disabled = true;
    api("POST", "/api/admin/conversations/delete", { ids: pending, confirm: "DELETE" }).then(function (j) {
      closeDelete();
      $("count").textContent = "";
      var wasDetail = !$("detail").hidden;
      if (wasDetail) history.replaceState(null, "", location.pathname + location.search);
      loadList();
      setTimeout(function () { $("count").textContent = "✓ Deleted " + j.deleted + " conversation" + (j.deleted === 1 ? "" : "s") + ". " + $("count").textContent; }, 400);
    }).catch(function (err) { $("del-error").textContent = "⚠ " + err.message; $("del-error").hidden = false; $("del-go").disabled = false; });
  });
  $("del-selected").addEventListener("click", function () { if (selected.size) askDelete(Array.from(selected)); });
  $("del-one").addEventListener("click", function () { if (current) askDelete([current]); });

  function boot() {
    readFilters();
    var deep = /^#([0-9a-f-]{36})$/.exec(location.hash);
    if (deep) openDetail(deep[1]); else loadList();
  }

  function section(title, kids) { return el("section", { class: "card" }, [el("h3", { text: title })].concat(kids)); }

  function openDetail(id) {
    api("GET", "/api/staff/sessions/" + id).then(function (j) {
      show("detail");
      current = id;
      var b = $("detail-body");
      b.textContent = "";
      var s = j.session, snap = j.snapshot;
      var nm = snap.names || {};
      b.appendChild(el("p", { style: "font-size:1.2rem;font-weight:700", text: "Caller: " + (nm.caller || "name not given") + (nm.subject ? " · Asking for: " + nm.subject : "") }));
      var fl = j.flow || {};
      b.appendChild(el("p", null, ["Workflow: ", el("span", { class: "flow-chip" + (fl.live ? "" : " gone"), text: (fl.title || fl.id) + (fl.live ? "" : " (deleted)") }), fl.version ? el("span", { class: "hint", text: " " + fl.version }) : null,
        fl.live ? el("a", { href: "/admin/workflows/?flow=" + encodeURIComponent(fl.id), style: "margin-left:10px", text: "Link, QR code and flyer →" }) : null]));
      b.appendChild(el("p", { text: "Started " + when(s.created_at) + " · updated " + when(s.updated_at) + " · channels: " + s.channels.map(function (c) { return c.mode; }).join(" → ") + " · answer revision " + s.revision + " · data " + s.corpus_version }));

      var statusRow = el("div", { class: "action-row", role: "group", "aria-label": "Staff status" });
      Object.keys(STAFF_STATUS).forEach(function (k) {
        statusRow.appendChild(el("button", { type: "button", class: "btn sm", "aria-pressed": String(s.staff_status === k), text: STAFF_STATUS[k], onclick: function () {
          api("POST", "/api/staff/sessions/" + id + "/status", { staffStatus: k }).then(function () { openDetail(id); });
        } }));
      });
      b.appendChild(section("Staff status", [statusRow]));

      var reviews = j.reviews.length ? el("ul", null, j.reviews.map(function (r) {
        var c = r.contact && r.contact.method ? " · contact by " + r.contact.method + (r.contact.value ? ": " + r.contact.value : "") : " · no contact details";
        return el("li", { text: when(r.created_at) + " — " + r.reason + c });
      })) : el("p", { text: "None." });
      b.appendChild(section("Requests and flags", [reviews]));

      var ans = el("table", { class: "t" }, [el("thead", null, [el("tr", null, [el("th", { text: "Question" }), el("th", { text: "Answer" }), el("th", { text: "Status" })])])]);
      var tb = el("tbody");
      snap.answers.forEach(function (a) {
        tb.appendChild(el("tr", null, [el("td", { text: a.label }), el("td", { text: a.display + (a.kind !== "answer" ? " (" + a.kind + ")" : "") }), el("td", null, [el("span", { class: "chip " + (a.status === "confirmed" ? "ok" : "amber"), text: a.status })])]));
      });
      ans.appendChild(tb);
      b.appendChild(section("Answers", [snap.answers.length ? el("div", { class: "table-wrap" }, [ans]) : el("p", { text: "No answers yet." }),
        el("p", { class: "hint", text: "Confirmed = the person explicitly confirmed the summary. It records what they reported; it doesn't prove eligibility." })]));

      var recs = j.recommendations.length ? j.recommendations.map(function (r) {
        return el("details", r.stale ? {} : { open: "" }, [
          el("summary", { text: (r.stale ? "Superseded" : "Current") + " suggestions — revision " + r.revision + " · " + when(r.createdAt) + " · " + r.corpusVersion }),
          el("ol", null, r.matches.map(function (m) { return el("li", null, [el("strong", { text: m.name + " (" + m.points + " pts)" }), el("ul", null, m.reasons.map(function (x) { return el("li", { text: x }); }))]); })),
          r.handoffs.length ? el("p", { text: "Outside the directory: " + r.handoffs.join(" ") }) : null,
          r.unresolved.length ? el("p", { class: "note", text: "Unresolved: " + r.unresolved.map(function (u) { return u.questionId + " (" + u.kind + ")"; }).join(", ") }) : null,
        ]);
      }) : [el("p", { text: "No suggestions yet (summary not confirmed)." })];
      b.appendChild(section("Suggestions and reasons", recs));

      var acts = j.actions.length ? el("ul", null, j.actions.map(function (a) {
        return el("li", null, [
          a.type + ": " + a.status.replace(/_/g, " ") + " · attempts " + a.attempts + (a.provider ? " · via " + a.provider : "") + (a.error ? " · " + a.error : "") + " · " + when(a.updated_at),
          a.status === "failed" ? el("button", { type: "button", class: "btn", style: "margin-left:0.5rem", text: "Retry", onclick: function () { api("POST", "/api/staff/actions/" + a.id + "/retry", {}).then(function () { openDetail(id); }); } }) : null,
        ]);
      })) : el("p", { text: "None." });
      b.appendChild(section("Actions", [acts, el("p", { class: "hint", text: "“mock written” means the local test outbox — not a real email. “provider accepted” means handed to the email service; it doesn't prove delivery." })]));

      b.appendChild(section("Answer history", [el("ul", null, j.answerEvents.map(function (e) {
        return el("li", { text: when(e.at) + " · rev " + e.revision + " · " + e.event + (e.question_id ? " · " + e.question_id : "") + (e.value_json ? " = " + e.value_json : "") + (e.kind ? " (" + e.kind + ")" : "") });
      }))]));
      $("detail-h").focus();
    }).catch(function () { loadList(); });
  }

  window.addEventListener("hashchange", function () {
    var m = /^#([0-9a-f-]{36})$/.exec(location.hash);
    if (m) openDetail(m[1]);
  });
  boot();
})();
