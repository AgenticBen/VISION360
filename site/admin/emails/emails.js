/* Email tracker with status filter and retry for failed emails. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var all = [], filter = (location.hash || "").slice(1) || "all";
  var GROUP = { mock_written: "sent", provider_accepted: "sent", failed: "failed" };
  var CHIP = { mock_written: ["Mock written", "ok"], provider_accepted: ["Provider accepted", "ok"], failed: ["Failed", "bad"], queued: ["Queued", "sky"], retrying: ["Retrying", "amber"], cancelled: ["Cancelled", "strike"] };
  function load() { A.api("GET", "/api/admin/overview").then(function (o) { all = o.emails; render(); }); }
  function render() {
    [].forEach.call(document.querySelectorAll("#filter button"), function (b) { b.setAttribute("aria-pressed", String(b.dataset.f === filter)); });
    var tb = document.querySelector("#email-table tbody"); tb.textContent = "";
    var rows = all.filter(function (e) { var g = GROUP[e.status] || "waiting"; return filter === "all" || g === filter; });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "6", class: "muted", text: "No emails here." })]));
    rows.forEach(function (e) {
      var c = CHIP[e.status] || [e.status, ""];
      var actions = el("td", null, [el("a", { class: "btn sm", href: "/admin/conversations/#" + e.session_id, text: "Conversation" })]);
      if (e.status === "failed") actions.appendChild(el("button", { type: "button", class: "btn sm", style: "margin-left:6px", text: "Retry", onclick: function () { A.api("POST", "/api/staff/actions/" + e.id + "/retry", {}).then(load); } }));
      tb.appendChild(el("tr", null, [
        el("td", { text: A.when(e.created_at) }), el("td", { text: e.to || "—" }), el("td", { text: e.subject || "—" }),
        el("td", null, [el("span", { class: "chip " + c[1], text: c[0] }), e.error ? el("div", { class: "hint", text: e.error }) : null]),
        el("td", { class: "n", text: String(e.attempts) }), actions
      ]));
    });
  }
  document.getElementById("filter").addEventListener("click", function (ev) { var b = ev.target.closest("button"); if (!b) return; filter = b.dataset.f; history.replaceState(null, "", filter === "all" ? location.pathname : "#" + filter); render(); });
  load();
})();
