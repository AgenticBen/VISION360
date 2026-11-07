/* Estimated costs, from /api/admin/overview. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  function usd(n) { return n == null ? "Needs a price" : "$" + Number(n).toFixed(2); }
  A.api("GET", "/api/admin/overview").then(function (o) {
    var c = o.costs;
    var sent = o.emails.filter(function (e) { return e.status === "mock_written" || e.status === "provider_accepted" || e.status === "delivered"; }).length;
    var rows = [
      ["AI understanding", c.ai.on ? "On — " + c.ai.model : "Off (rules only)", c.ai.calls + " AI calls" + (c.ai.perCallUsd != null ? " × $" + c.ai.perCallUsd : ""), c.ai.estimateUsd],
      ["Voice (text to speech)", c.tts.provider === "browser" ? "The listener's own browser voice" : c.tts.provider, "—", c.tts.estimateUsd],
      ["Email", c.email.transport === "outbox" ? "Test outbox (no real emails)" : c.email.transport, sent + " sent", c.email.estimateUsd]
    ];
    var total = rows.every(function (r) { return r[3] != null; }) ? rows.reduce(function (a, r) { return a + r[3]; }, 0) : null;
    var tb = document.querySelector("#cost-table tbody"); tb.textContent = "";
    rows.forEach(function (r) { tb.appendChild(el("tr", null, [el("td", null, [el("strong", { text: r[0] })]), el("td", { text: r[1] }), el("td", { text: r[2] }), el("td", { class: "n", text: usd(r[3]) })])); });
    tb.appendChild(el("tr", null, [el("td", null, [el("strong", { text: "Total" })]), el("td"), el("td"), el("td", { class: "n" }, [el("strong", { text: total == null ? "Needs a price" : usd(total) })])]));
  }).catch(function (e) { document.querySelector("#cost-table tbody").textContent = "Couldn't load: " + e.message; });
})();
