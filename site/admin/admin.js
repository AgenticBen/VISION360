/* Admin overview: dashboard, cost estimate, email tracker, the live question
   flow (read-only), raw data and settings. Reads /api/admin/overview and the
   published data files; it never changes anything. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function getJson(path) {
    return fetch(path, { credentials: "same-origin", cache: "no-cache" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; throw e; } return j; });
    });
  }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : ""; }
  function usd(n) { return n == null ? "Not set" : "$" + Number(n).toFixed(2); }
  function words(s) { return String(s || "").replace(/_/g, " "); }

  function renderOverview(o) {
    $("open-note").hidden = o.signInRequired;
    var u = o.usage;
    var emailsSent = o.emails.filter(function (e) { return e.status === "mock_written" || e.status === "provider_accepted"; }).length;
    var stats = [
      [u.conversations, "conversations started"],
      [u.byMode.voice, "started by voice"],
      [u.byMode.text, "started by typing"],
      [u.summariesConfirmed, "confirmed their summary"],
      [u.completed, "reached suggestions"],
      [emailsSent, "plan emails sent"],
      [u.staffRequests, "asked staff to follow up"]
    ];
    var list = $("stats"); list.textContent = "";
    stats.forEach(function (s) { list.appendChild(el("li", null, [el("span", { class: "num", text: String(s[0]) }), el("span", { class: "lbl", text: s[1] })])); });

    var days = Object.keys(u.byDay).sort().reverse();
    var max = Math.max.apply(null, [1].concat(days.map(function (d) { return u.byDay[d]; })));
    var tb = $("per-day").tBodies[0]; tb.textContent = "";
    if (!days.length) tb.appendChild(el("tr", null, [el("td", { colspan: "3", text: "No conversations in the last 30 days." })]));
    days.forEach(function (d) {
      var n = u.byDay[d];
      tb.appendChild(el("tr", null, [
        el("td", { text: new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) }),
        el("td", { class: "n", text: String(n) }),
        el("td", { "aria-hidden": "true" }, [el("span", { class: "bar", style: "width:" + Math.round((n / max) * 12) + "rem" })])
      ]));
    });
    $("storage-note").textContent = o.storage === "ephemeral"
      ? "Heads-up: the demo server keeps conversations in temporary storage, so these counts reset whenever the server restarts. Permanent storage (Supabase) comes in a later phase."
      : "Conversations are kept for " + o.retentionDays + " days.";

    var c = o.costs;
    var rows = [
      ["AI understanding", c.ai.on ? "On — " + c.ai.model : "Off (rules only)", c.ai.calls + " AI calls", c.ai.estimateUsd],
      ["Voice (text to speech)", c.tts.provider === "browser" ? "The listener's own browser voice" : c.tts.provider, "—", c.tts.estimateUsd],
      ["Email", c.email.transport === "outbox" ? "Test outbox (no real emails)" : c.email.transport, emailsSent + " sent", c.email.estimateUsd]
    ];
    var total = rows.every(function (r) { return r[3] != null; }) ? rows.reduce(function (a, r) { return a + r[3]; }, 0) : null;
    var ct = $("cost-table").tBodies[0]; ct.textContent = "";
    rows.forEach(function (r) { ct.appendChild(el("tr", null, [el("th", { scope: "row", text: r[0] }), el("td", { text: r[1] }), el("td", { text: r[2] }), el("td", { class: "n", text: usd(r[3]) })])); });
    ct.appendChild(el("tr", null, [el("th", { scope: "row", text: "Total" }), el("td"), el("td"), el("td", { class: "n" }, [el("strong", { text: total == null ? "Needs a price setting" : usd(total) })])]));

    var et = $("email-table").tBodies[0]; et.textContent = "";
    if (!o.emails.length) et.appendChild(el("tr", null, [el("td", { colspan: "5", text: "No emails in the last 30 days." })]));
    o.emails.forEach(function (e) {
      et.appendChild(el("tr", null, [
        el("td", { text: when(e.created_at) }),
        el("td", { text: e.to || "—" }),
        el("td", { text: words(e.status) + (e.error ? " — " + e.error : "") }),
        el("td", { text: String(e.attempts) }),
        el("td", null, [el("a", { href: "/staff/#" + e.session_id, text: "Open in staff queue" })])
      ]));
    });

    var set = [
      ["Live commit", o.commit === "local" ? "local" : o.commit.slice(0, 7)],
      ["Admin sign-in", o.signInRequired ? "Required" : "Off — anyone with the link can view (set V360_ADMIN_SIGNIN=on to require it)"],
      ["Storage", o.storage === "ephemeral" ? "Temporary (resets on restart)" : o.storage],
      ["Keeps conversations for", o.retentionDays + " days"],
      ["Directory data version", o.settings.corpusVersion + " (" + o.settings.organizations + " organizations)"],
      ["Conversation rules version", o.settings.policyVersion],
      ["Email", o.settings.emailTransport === "outbox" ? "Test outbox" : o.settings.emailTransport],
      ["Voice", o.settings.tts === "browser" ? "Browser voice" : o.settings.tts],
      ["AI understanding", o.settings.aiUnderstanding ? "On" : "Off"],
      ["Claude MCP", "Not connected"]
    ];
    var dl = $("settings-list"); dl.textContent = "";
    set.forEach(function (s) { dl.appendChild(el("dt", { text: s[0] })); dl.appendChild(el("dd", { text: s[1] })); });
  }

  function renderTree(a, names) {
    var byId = {}; a.questions.forEach(function (q) { byId[q.id] = q; });
    var box = $("tree"); box.textContent = "";
    box.appendChild(el("p", { class: "hint", text: a.blocks.length + " sections, " + a.questions.length + " questions. Questions marked “only asked if” are the branches." }));
    a.blocks.forEach(function (b, bi) {
      var blk = el("div", { class: "block" }, [el("h3", { text: (bi + 1) + ". " + b.title })]);
      if (b.preamble) blk.appendChild(el("p", { class: "hint", text: "Said first: " + b.preamble }));
      b.questions.forEach(function (qid) {
        var q = byId[qid]; if (!q) return;
        var card = el("div", { class: "q" }, [
          el("p", null, [el("strong", { text: q.prompt_screen })]),
          el("p", { class: "meta", text: "Spoken as: “" + q.prompt_voice + "” · " + (q.type === "multi" ? "choose any" : q.type === "yes_no" ? "yes or no" : "choose one") + (q.skippable ? " · can skip" : "") + (q.sensitive ? " · sensitive" : "") + " · id " + q.id })
        ]);
        if (q.ask_if) {
          var parent = byId[q.ask_if.q];
          var vals = q.ask_if.in.map(function (v) { var o = parent && parent.options.find(function (x) { return x.value === v; }); return o ? o.label_screen : v; });
          card.appendChild(el("p", null, [el("span", { class: "branch", text: "Only asked if “" + (parent ? parent.prompt_screen : q.ask_if.q) + "” is " + vals.join(" or ") })]));
        }
        var opts = el("ul");
        q.options.forEach(function (o) {
          var fx = (o.effects || []).map(function (f) {
            var who = f.target === "org" ? (names[f.id] || f.id) : "all “" + words(f.id) + "” services";
            return (f.op === "boost" ? "raises " : f.op === "suppress" ? "lowers " : f.op + " ") + who + (f.weight != null ? " (" + (f.op === "suppress" ? "−" : "+") + Math.abs(f.weight) + ")" : "");
          });
          opts.appendChild(el("li", null, [el("strong", { text: o.label_screen }), fx.length ? " — " + fx.join("; ") : " — no effect on ranking"]));
        });
        card.appendChild(el("details", null, [el("summary", { text: q.options.length + " answers and what each one does" }), opts]));
        blk.appendChild(card);
      });
      box.appendChild(blk);
    });
  }

  getJson("/api/admin/overview").then(function (o) {
    renderOverview(o);
    $("load-status").textContent = "Updated " + when(o.generatedAt) + ".";
  }).catch(function (e) {
    $("load-status").textContent = e.status === 401 ? "Admin sign-in is switched on. Sign in on the staff queue page first, then come back." : "Couldn't load the dashboard: " + e.message;
  });

  Promise.all([getJson("/data/assessment.json"), getJson("/data/organizations.json").catch(function () { return []; })]).then(function (r) {
    var orgs = Array.isArray(r[1]) ? r[1] : (r[1].organizations || []);
    var names = {}; orgs.forEach(function (o) { names[o.id] = o.name; });
    renderTree(r[0], names);
  }).catch(function (e) { $("tree").textContent = "Couldn't load the question flow: " + e.message; });

  /* Arriving with #emails etc. lands on that section once content has loaded. */
  if (location.hash) setTimeout(function () { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }, 300);
})();
