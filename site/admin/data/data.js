/* Raw data: links to every data file and feed, with an inline preview. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var FILES = [
    ["/data/organizations.json", "Organizations", "Every directory record"],
    ["/data/assessment.json", "Referral workflow", "Questions, answers and scoring rules the assistant and directory use"],
    ["/data/flows/v360-interest.json", "V360 TECH interest workflow", "The interest form as an editable workflow"],
    ["/data/flows/index.json", "Workflow list", "Which workflows exist and what uses them"],
    ["/data/geography.json", "Geography", "How counties are ranked by distance"],
    ["/data/pathways.json", "Pathways", "Common routes through services"],
    ["/api/staff/sessions", "Conversations", "The conversation list as data"],
    ["/api/requests", "Requests", "Everything asked for with the request button"],
    ["/api/changelog", "Change log", "Every logged change"],
    ["/api/admin/overview", "Dashboard numbers", "The 30-day figures, costs and emails"],
    ["/api/health", "System health", "Live version, data versions and settings"]
  ];
  var tb = document.querySelector("#files tbody");
  FILES.forEach(function (f) {
    var size = el("td", { class: "n muted", text: "…" });
    tb.appendChild(el("tr", null, [
      el("td", null, [el("a", { href: f[0], text: f[1] }), el("div", { class: "hint", text: f[0] })]),
      el("td", { text: f[2] }), size,
      el("td", null, [el("button", { type: "button", class: "btn sm", text: "Preview", onclick: function () { preview(f); } })])
    ]));
    fetch(f[0], { cache: "no-store" }).then(function (r) { return r.text(); }).then(function (t) { size.textContent = t.length > 1024 ? Math.round(t.length / 1024) + " KB" : t.length + " B"; }).catch(function () { size.textContent = "—"; });
  });
  function preview(f) {
    document.getElementById("preview-card").hidden = false;
    document.getElementById("preview-h").textContent = f[1] + " — first part";
    var pre = document.getElementById("preview"); pre.textContent = "Loading…";
    fetch(f[0], { cache: "no-store" }).then(function (r) { return r.text(); }).then(function (t) {
      var out = t; try { out = JSON.stringify(JSON.parse(t), null, 2); } catch (e) {}
      pre.textContent = out.slice(0, 6000) + (out.length > 6000 ? "\n…" : "");
      document.getElementById("preview-card").scrollIntoView({ behavior: "smooth" });
    });
  }
})();
