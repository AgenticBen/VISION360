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
    plan(c.tts.plan, o.days);
  }).catch(function (e) { document.querySelector("#cost-table tbody").textContent = "Couldn't load: " + e.message; });

  // ---- The ElevenLabs plan: what a conversation costs, and what a month needs.
  var P = null;
  function byId(id) { return document.getElementById(id); }
  function n(x) { return Math.round(x).toLocaleString(); }
  function cents(x) { return x < 0.1 ? (x * 100).toFixed(1) + "¢" : "$" + x.toFixed(2); }
  function plan(p, days) {
    P = p;
    var dl = byId("plan-facts"); dl.textContent = "";
    if (!p) { dl.appendChild(el("dd", { text: "Not available." })); return; }
    var m = p.measured;
    var rows = [
      ["Plan", p.plan.name + " · $" + p.plan.usd + " a month · " + n(p.plan.credits) + " credits · renews on day " + p.plan.renewsDay + " of the month"],
      ["Rate", "About " + p.plan.creditsPerChar + " credits per character spoken (1 credit ≈ " + Math.round(1 / p.plan.creditsPerChar) + " characters). Measured from your ElevenLabs dashboard, " + m.from + " to " + m.to + ": " + n(m.chars) + " characters used " + n(m.credits) + " credits."],
      ["In dollars", "1 credit ≈ $" + p.usdPerCredit.toFixed(5) + " · 1,000 characters ≈ " + cents(p.per1kUsd)],
      ["This site, last " + days + " days", p.period.conversations ? n(p.period.conversations) + (p.period.conversations === 1 ? " conversation · " : " conversations · ") + n(p.period.chars) + " characters spoken · about " + n(p.period.credits) + " credits" : "No conversations yet"],
      ["Each conversation", "About " + n(p.charsPerConversation) + " characters ≈ " + n(p.creditsPerConversation) + " credits ≈ " + cents(p.usdPerConversation) + (p.perConversationSource === "site" ? " (this site's conversations, last " + days + " days)" : " (from the measured week; this site has no voiced conversations in the last " + days + " days yet)")],
      ["The plan covers", p.conversationsPerPlan == null ? "—" : "About " + n(p.conversationsPerPlan) + " conversations a month"]
    ];
    rows.forEach(function (r) { dl.appendChild(el("dt", { text: r[0] })); dl.appendChild(el("dd", { text: r[1] })); });
    calc();
  }
  function calc() {
    var out = byId("calc-out"); if (!P) return;
    var per = P.creditsPerConversation || 250;
    var conv = Math.max(0, Number(byId("calc-conv").value) || 0);
    var used = Math.max(0, Number(byId("calc-used").value) || 0);
    var need = conv * per;
    var left = P.plan.credits - used;
    var lines = [];
    lines.push(n(conv) + " conversations ≈ " + n(need) + " credits (" + Math.round(need / P.plan.credits * 100) + "% of the plan) ≈ " + cents(need * P.usdPerCredit) + " of credits.");
    if (used) lines.push("Credits left this month: " + n(Math.max(0, left)) + " — about " + n(Math.max(0, left) / per) + " more conversations.");
    if (need > P.plan.credits) lines.push("⚠ More than the plan holds. Above about " + n(P.plan.credits / per) + " conversations a month, the voice falls back to the browser voice unless you add credits or move up a plan.");
    out.textContent = lines.join(" ");
  }
  byId("calc-conv").addEventListener("input", calc);
  byId("calc-used").addEventListener("input", calc);

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
