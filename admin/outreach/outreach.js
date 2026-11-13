/* Admin › Outreach: the switch, referrals sent for people, and how each
   organization is contacted (with a staff override per organization). */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var data = null, filter = "all";
  var CHIP = { mock_submitted: ["Practice form sent", "ok"], submitted: ["Form sent", "ok"], unconfirmed: ["Form not confirmed", "amber"], fell_back: ["Form couldn't be used", "amber"], prepared: ["Backup email (only if the form fails)", ""], mock_written: ["Test outbox", "ok"], provider_accepted: ["Accepted by email service", "ok"], delivered: ["Delivered", "ok"], bounced: ["Bounced", "bad"], failed: ["Failed", "bad"], queued: ["Queued", "sky"], running: ["Sending", "sky"], retrying: ["Retrying", "amber"], cancelled: ["Cancelled", "strike"] };
  var REF = { yes: "Yes", unclear: "Unclear", no: "No — contact directly" };

  function load() { A.api("GET", "/api/admin/outreach").then(function (d) { data = d; render(); if (R.recipes) renderRecipes(); }); }

  function render() {
    var st = data.status;
    $("sw-state").textContent = st.on ? "On: the assistant offers to contact organizations." : "Off: the assistant doesn't offer to contact organizations.";
    var b = $("sw-btn"); b.disabled = false; b.textContent = st.on ? "Switch off" : "Switch on";
    b.className = st.on ? "btn" : "btn primary";
    $("sw-live").textContent = st.live
      ? "Live: referral emails go to the real organizations, with the person copied."
      : "Demo: referral emails go to the test inbox" + (st.testInbox ? " (" + st.testInbox + ")" : "") + ", marked with the organization they were meant for. Nothing reaches the organizations until V360_OUTREACH_LIVE is set to on in Vercel." + (st.blocker && st.on ? " Not available yet: " + st.blocker : "");

    var tb = document.querySelector("#sent-table tbody"); tb.textContent = "";
    if (!data.actions.length) tb.appendChild(el("tr", null, [el("td", { colspan: "5", class: "muted", text: "No referrals yet." })]));
    data.actions.forEach(function (a) {
      var c = CHIP[a.status] || [a.status, ""];
      var to = a.channel === "form" ? (a.demoRedirect ? "Practice form (meant for their online form)" : "Their online form") : a.demoRedirect ? "Test inbox (meant for " + (a.intendedTo || "the organization") + ")" : (a.to || "—");
      var acts = el("td", null, [el("a", { class: "btn sm", href: "/admin/conversations/#" + a.session_id, text: "Conversation" })]);
      if (a.status === "failed") acts.appendChild(el("button", { type: "button", class: "btn sm", style: "margin-left:6px", text: "Retry", onclick: function () { A.api("POST", "/api/staff/actions/" + a.id + "/retry", {}).then(load); } }));
      tb.appendChild(el("tr", null, [el("td", { text: A.when(a.created_at) }), el("td", { text: a.orgName || a.orgId || "—" }), el("td", { text: to }),
        el("td", null, [el("span", { class: "chip " + c[1], text: c[0] }), a.error ? el("div", { class: "hint", text: a.error }) : null]), acts]));
    });

    [].forEach.call(document.querySelectorAll("#org-filter button"), function (x) { x.setAttribute("aria-pressed", String(x.dataset.f === filter)); });
    var ob = document.querySelector("#org-table tbody"); ob.textContent = "";
    data.orgs.filter(function (o) { return filter === "all" || (filter === "email" ? o.channel === "email" : o.channel === "none"); }).forEach(function (o) {
      ob.appendChild(el("tr", null, [
        el("td", null, [el("strong", { text: o.name }), o.listedEmail ? el("div", { class: "hint", text: "Listing: " + o.listedEmail }) : null]),
        el("td", { text: REF[o.referral] || "—" }),
        el("td", { text: o.channel === "email" ? "Email: " + o.email : "Not contacted" }),
        el("td", { class: "hint", text: o.why }),
        el("td", null, o.referral === "no" ? [el("span", { class: "muted", text: "—" })] : [changeForm(o)])
      ]));
    });
  }

  function changeForm(o) {
    var cur = o.override ? o.override.channel : "auto";
    var sel = el("select", { "aria-label": "How to contact " + o.name }, ["auto", "email", "none"].map(function (v) {
      return el("option", { value: v, selected: v === cur ? true : null, text: v === "auto" ? "Auto" : v === "email" ? "This email:" : "Don't contact" });
    }));
    var inp = el("input", { type: "email", "aria-label": "Referral email for " + o.name, placeholder: "intake@example.org", value: (o.override && o.override.email) || "", style: "max-width:14rem" });
    inp.hidden = sel.value !== "email";
    sel.addEventListener("change", function () { inp.hidden = sel.value !== "email"; });
    var save = el("button", { type: "button", class: "btn sm", text: "Save", onclick: function () {
      A.api("PUT", "/api/admin/outreach/orgs/" + o.id, { channel: sel.value, email: inp.value }).then(load).catch(function (e) { alert(e.message || "Couldn't save."); });
    } });
    return el("div", { class: "row", style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center" }, [sel, inp, save]);
  }

  // ------------------------------------------------------------ online forms
  var R = { list: [], sources: [], runner: false };
  function loadRecipes() { A.api("GET", "/api/admin/outreach/recipes").then(function (d) { R = d; renderRecipes(); }); }
  var STATUS = { draft: "Draft", test_approved: "Approved for testing", live_approved: "Approved for real", retired: "Retired" };
  function renderRecipes() {
    $("runner-note").textContent = R.runner ? "The safe browser is set up." : "The safe browser (Vercel Sandbox) isn't set up yet, so Inspect and Dry run won't work and every form job falls back to email or a staff task. See docs/outreach.md.";
    var box = $("recipes"); box.textContent = "";
    R.recipes.forEach(function (x) {
      var r = x.recipe;
      var d = el("details", { class: "card", style: "margin:0 0 10px" });
      d.appendChild(el("summary", { text: x.name + " — " + (r ? STATUS[r.status] + " (version " + r.version + ")" : "no recipe") }));
      d.appendChild(el("p", { class: "hint" }, [document.createTextNode("Form link in the directory: "), el("a", { href: x.formUrl, target: "_blank", rel: "noopener", text: x.formUrl })]));
      var draft = r ? JSON.parse(JSON.stringify(r)) : { url: x.formUrl, allowDomains: [hostOf(x.formUrl)], fields: [], submit: { selector: "" }, success: { textIncludes: "" } };
      delete draft.history; delete draft.status; delete draft.version; delete draft.orgId;
      var ta = el("textarea", { rows: "14", style: "width:100%;font-family:monospace;font-size:13px", "aria-label": "Recipe for " + x.name });
      ta.value = JSON.stringify(draft, null, 2);
      var out = el("div", { class: "hint", role: "status" });
      var btn = function (text, fn, cls) { return el("button", { type: "button", class: "btn sm" + (cls ? " " + cls : ""), style: "margin:4px 6px 4px 0", text: text, onclick: fn }); };
      var parse = function () { try { return JSON.parse(ta.value); } catch (e) { out.textContent = "That isn't valid JSON: " + e.message; return null; } };
      var show = function (res) {
        out.textContent = "";
        if (res.outcome) out.appendChild(el("p", { text: "Result: " + res.outcome + (res.detail ? " — " + res.detail : "") }));
        if (res.fields) out.appendChild(el("p", { text: res.fields.length + " fields found. They've been put in the recipe with source \"skip\"; choose a source for each one you want filled, and remove the rest." }));
        if (res.screenshot) out.appendChild(el("img", { src: "data:image/jpeg;base64," + res.screenshot, alt: "Picture of the form", style: "max-width:100%;border:1px solid #ccc;margin-top:6px" }));
      };
      d.appendChild(ta);
      d.appendChild(el("div", null, [
        btn("Inspect", function () {
          var dr = parse(); if (!dr) return;
          out.textContent = "Opening the form…";
          A.api("POST", "/api/admin/outreach/recipes/" + x.orgId + "/inspect", { url: dr.url, allowDomains: dr.allowDomains }).then(function (res) {
            if (res.fields) { dr.fields = res.fields.map(function (f) { return { selector: f.selector, kind: f.kind, label: f.label, required: f.required, source: "skip" }; }); ta.value = JSON.stringify(dr, null, 2); }
            show(res); loadRecipes();
          }).catch(function (e) { out.textContent = e.message; });
        }),
        btn("Draft with AI", function () {
          var dr = parse(); if (!dr) return;
          A.api("POST", "/api/admin/outreach/recipes/" + x.orgId + "/draft-ai", { fields: dr.fields }).then(function (res) { dr.fields = res.fields; ta.value = JSON.stringify(dr, null, 2); out.textContent = "Suggested sources filled in. Check each one before saving."; }).catch(function (e) { out.textContent = e.message; });
        }),
        btn("Save", function () {
          var dr = parse(); if (!dr) return;
          dr.fields = (dr.fields || []).filter(function (f) { return f.source && f.source !== "skip"; });
          A.api("PUT", "/api/admin/outreach/recipes/" + x.orgId, dr).then(function (res) { out.textContent = res.problems.length ? "Saved as a draft. Still to fix: " + res.problems.join(" ") : "Saved as a draft. It can be approved for testing."; loadRecipes(); }).catch(function (e) { out.textContent = e.message; });
        }),
        btn("Approve for testing", function () { status("test_approved"); }),
        btn("Dry run", function () { out.textContent = "Filling in the form with made-up details (not sending)…"; A.api("POST", "/api/admin/outreach/recipes/" + x.orgId + "/dry-run", {}).then(show).catch(function (e) { out.textContent = e.message; }); }),
        btn("Approve for real", function () { status("live_approved"); }, "primary"),
        btn("Retire", function () { status("retired"); })
      ]));
      d.appendChild(out);
      function status(st) {
        var body = { status: st };
        if (/approved$/.test(st)) { var t = prompt("Type APPROVE to approve this recipe (" + STATUS[st] + ")."); if (t === null) return; body.confirm = t; }
        A.api("POST", "/api/admin/outreach/recipes/" + x.orgId + "/status", body).then(function () { out.textContent = STATUS[st] + "."; loadRecipes(); }).catch(function (e) { out.textContent = e.message; });
      }
      box.appendChild(d);
    });
    var ul = $("practice"); ul.textContent = "";
    ((data && data.practice) || []).forEach(function (p) { ul.appendChild(el("li", { text: A.when(p.at) + " — " + (p.detail.fullName || "?") + " · meant for " + (p.detail.intendedOrg || "?") + " · " + [p.detail.phone, p.detail.email].filter(Boolean).join(" · ") })); });
    if (!ul.children.length) ul.appendChild(el("li", { text: "None yet." }));
  }
  function hostOf(u) { try { return new URL(u).host; } catch (e) { return ""; } }

  function $(id) { return document.getElementById(id); }
  $("sw-btn").addEventListener("click", function () {
    var on = !data.status.on;
    if (on && !confirm("Switch on contacting organizations?\n\n" + (data.status.live ? "LIVE: real organizations will receive referral emails." : "Demo: emails go to the test inbox, not the organizations."))) return;
    $("sw-btn").disabled = true;
    A.api("PUT", "/api/admin/outreach/settings", { on: on }).then(load).catch(function (e) { alert(e.message || "Couldn't change it."); load(); });
  });
  $("org-filter").addEventListener("click", function (ev) { var b = ev.target.closest("button"); if (!b) return; filter = b.dataset.f; render(); });
  load();
  loadRecipes();
})();
