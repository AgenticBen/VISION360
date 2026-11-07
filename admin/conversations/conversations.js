/* Conversations (the staff queue inside the admin app). Reads /api/staff routes (open while admin sign-in is off).
   The HttpOnly session cookie is set by the server; this file never sees it. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || r.status); e.status = r.status; throw e; } return j; }); });
  }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : ""; }
  var STAFF_STATUS = { pending: "Pending", reviewed: "Reviewed", needs_follow_up: "Needs follow-up" };
  var PHASE = { opening: "Just started", intake: "Answering questions", recap: "Checking summary", results: "Has suggestions", email_address: "Giving email", email_confirm_address: "Giving email", email_consent: "Deciding on email", staff_contact: "Asking for staff", staff_confirm: "Asking for staff", closed: "Ended" };

  /* Admin sign-in is switched off for now, so the server usually answers
     /api/staff/me without a password; the sign-in form only shows when it is on. */
  var openMode = false;
  function show(id) { ["login", "list", "detail"].forEach(function (x) { $(x).hidden = x !== id; }); $("logout").hidden = id === "login" || openMode; }

  function boot() {
    var deep = /^#([0-9a-f-]{36})$/.exec(location.hash);
    api("GET", "/api/staff/me").then(function (me) { openMode = !!me.open; if (deep) openDetail(deep[1]); else loadList(); }).catch(function () { show("login"); $("u").focus(); });
  }

  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("login-error").textContent = "";
    api("POST", "/api/staff/login", { username: $("u").value, password: $("p").value })
      .then(function () { $("p").value = ""; loadList(); })
      .catch(function (err) { $("login-error").textContent = err.message; $("login-error").hidden = false; });
  });
  $("logout").addEventListener("click", function () { api("POST", "/api/staff/logout", {}).finally(function () { show("login"); }); });
  $("back").addEventListener("click", loadList);

  function loadList() {
    api("GET", "/api/staff/sessions").then(function (j) {
      show("list");
      var tb = $("rows");
      tb.textContent = "";
      if (!j.sessions.length) tb.appendChild(el("tr", null, [el("td", { colspan: "6", text: "No conversations yet." })]));
      j.sessions.forEach(function (s) {
        var email = s.actions.filter(function (a) { return a.type === "email_plan"; }).map(function (a) { return a.status.replace(/_/g, " "); }).join(", ") || "—";
        tb.appendChild(el("tr", null, [
          el("td", { text: when(s.updated_at) }),
          el("td", { text: PHASE[s.phase] || s.phase || "" }),
          el("td", { text: STAFF_STATUS[s.staff_status] || s.staff_status }),
          el("td", { text: s.openReviews ? s.openReviews + " request(s)" : "—" }),
          el("td", { text: email }),
          el("td", null, [el("button", { type: "button", class: "btn", text: "Open", "aria-label": "Open conversation updated " + when(s.updated_at), onclick: function () { openDetail(s.id); } })]),
        ]));
      });
    }).catch(function (e) { if (e.status === 401) show("login"); });
  }

  function section(title, kids) { return el("section", { class: "card" }, [el("h3", { text: title })].concat(kids)); }

  function openDetail(id) {
    api("GET", "/api/staff/sessions/" + id).then(function (j) {
      show("detail");
      var b = $("detail-body");
      b.textContent = "";
      var s = j.session, snap = j.snapshot;
      var nm = snap.names || {};
      b.appendChild(el("p", { style: "font-size:1.2rem;font-weight:700", text: "Caller: " + (nm.caller || "name not given") + (nm.subject ? " · Asking for: " + nm.subject : "") }));
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
    }).catch(function (e) { if (e.status === 401) show("login"); else loadList(); });
  }

  window.addEventListener("hashchange", function () {
    var m = /^#([0-9a-f-]{36})$/.exec(location.hash);
    if (m) openDetail(m[1]);
  });
  boot();
})();
