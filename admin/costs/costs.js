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
      ["Voice (text to speech)", c.tts.provider === "browser" ? "The listener's own browser voice" : "ElevenLabs natural voice", c.tts.chars ? c.tts.chars.toLocaleString() + " characters" + (c.tts.per1kUsd != null ? " × $" + c.tts.per1kUsd + " per 1,000" : "") : "—", c.tts.estimateUsd],
      ["Email", c.email.transport === "outbox" ? "Test outbox (no real emails)" : c.email.transport, sent + " sent", c.email.estimateUsd]
    ];
    var total = rows.every(function (r) { return r[3] != null; }) ? rows.reduce(function (a, r) { return a + r[3]; }, 0) : null;
    var tb = document.querySelector("#cost-table tbody"); tb.textContent = "";
    rows.forEach(function (r) { tb.appendChild(el("tr", null, [el("td", null, [el("strong", { text: r[0] })]), el("td", { text: r[1] }), el("td", { text: r[2] }), el("td", { class: "n", text: usd(r[3]) })])); });
    tb.appendChild(el("tr", null, [el("td", null, [el("strong", { text: "Total" })]), el("td"), el("td"), el("td", { class: "n" }, [el("strong", { text: total == null ? "Needs a price" : usd(total) })])]));
    voice(c.tts);
  }).catch(function (e) { document.querySelector("#cost-table tbody").textContent = "Couldn't load: " + e.message; });

  // Natural voice switch. It only works once ELEVENLABS_API_KEY is in Vercel.
  var $ = function (id) { return document.getElementById(id); };
  function voice(t) {
    var dl = $("voice-status"); dl.textContent = "";
    var rows = [
      ["ElevenLabs key", t.keySet ? ["ok", "Connected (ELEVENLABS_API_KEY is set)"] : ["amber", "Not set — add ELEVENLABS_API_KEY in Vercel, then redeploy"]],
      ["In use now", t.provider === "elevenlabs" ? ["ok", "Natural voice"] : ["", "Browser voice (free)"]],
      ["Voice and model", ["", t.voiceId + " · " + t.model]],
      ["Characters spoken, last 30 days", ["", (t.chars || 0).toLocaleString()]]
    ];
    rows.forEach(function (x) { dl.appendChild(el("dt", { text: x[0] })); dl.appendChild(el("dd", null, [el("span", { class: "status-line" }, [el("span", { class: "dot " + x[1][0] }), x[1][1]])])); });
    var box = $("voice-on");
    box.checked = !!t.switchOn && t.keySet;
    box.disabled = !t.keySet;
    $("voice-label").textContent = box.checked ? "Natural voice on" : "Natural voice off";
    $("voice-sample").hidden = t.provider !== "elevenlabs";
    $("voice-help").textContent = t.keySet ? "When it's off, or if ElevenLabs fails, the assistant uses the listener's browser voice." : "To turn it on: in Vercel → lions-vision-referral → Settings → Environment Variables, add ELEVENLABS_API_KEY (Production), redeploy, then come back and switch it on. Optional: ELEVENLABS_VOICE_ID to pick a different voice.";
  }
  $("voice-on").addEventListener("change", function () {
    var box = this, want = box.checked;
    box.disabled = true; $("voice-msg").textContent = "Saving…"; $("voice-msg").className = "hint";
    A.api("PUT", "/api/admin/settings", { voice: { elevenlabs: want } })
      .then(function () { return A.api("GET", "/api/admin/overview"); })
      .then(function (o) { voice(o.costs.tts); $("voice-msg").className = "ok-text"; $("voice-msg").textContent = want ? "✓ On. New replies use the natural voice within a minute." : "✓ Off."; })
      .catch(function (e) { box.checked = !want; box.disabled = false; $("voice-msg").className = "danger-text"; $("voice-msg").textContent = "⚠ " + e.message; });
  });
  $("voice-sample").addEventListener("click", function () {
    var a = new Audio("/api/tts-sample?rate=1");
    a.play().catch(function () { $("voice-msg").className = "danger-text"; $("voice-msg").textContent = "⚠ Couldn't play the sample."; });
  });
})();
