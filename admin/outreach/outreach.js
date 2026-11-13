/* Admin › Outreach: the switch, referrals sent for people, and how each
   organization is contacted (with a staff override per organization). */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var data = null, filter = "all";
  var CHIP = { mock_written: ["Test outbox", "ok"], provider_accepted: ["Accepted by email service", "ok"], delivered: ["Delivered", "ok"], bounced: ["Bounced", "bad"], failed: ["Failed", "bad"], queued: ["Queued", "sky"], running: ["Sending", "sky"], retrying: ["Retrying", "amber"], cancelled: ["Cancelled", "strike"] };
  var REF = { yes: "Yes", unclear: "Unclear", no: "No — contact directly" };

  function load() { A.api("GET", "/api/admin/outreach").then(function (d) { data = d; render(); }); }

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
      var to = a.demoRedirect ? "Test inbox (meant for " + (a.intendedTo || "the organization") + ")" : (a.to || "—");
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

  function $(id) { return document.getElementById(id); }
  $("sw-btn").addEventListener("click", function () {
    var on = !data.status.on;
    if (on && !confirm("Switch on contacting organizations?\n\n" + (data.status.live ? "LIVE: real organizations will receive referral emails." : "Demo: emails go to the test inbox, not the organizations."))) return;
    $("sw-btn").disabled = true;
    A.api("PUT", "/api/admin/outreach/settings", { on: on }).then(load).catch(function (e) { alert(e.message || "Couldn't change it."); load(); });
  });
  $("org-filter").addEventListener("click", function (ev) { var b = ev.target.closest("button"); if (!b) return; filter = b.dataset.f; render(); });
  load();
})();
