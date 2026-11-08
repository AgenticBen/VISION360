/* Dashboard: 30-day numbers, "needs you" chips and recent changes. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el, $ = function (id) { return document.getElementById(id); };

  Promise.all([A.api("GET", "/api/admin/overview"), A.api("GET", "/api/requests").catch(function () { return { requests: [] }; }), A.api("GET", "/api/changelog").catch(function () { return { entries: [] }; })])
    .then(function (r) { render(r[0], r[1].requests, r[2].entries); })
    .catch(function (e) { $("updated").textContent = "Couldn't load: " + e.message; });

  function render(o, reqs, log) {
    $("updated").textContent = "Updated " + A.when(o.generatedAt);
    $("open-note").hidden = o.signInRequired;
    var u = o.usage;
    var sent = o.emails.filter(function (e) { return e.status === "mock_written" || e.status === "provider_accepted" || e.status === "delivered"; }).length;
    var failed = o.emails.filter(function (e) { return e.status === "failed"; }).length;
    var needsBen = reqs.filter(function (r) { return r.status === "needs_ben"; }).length;
    var open = reqs.filter(function (r) { return r.status === "open" || r.status === "in_progress"; }).length;

    var needs = $("needs"); needs.textContent = "";
    var chips = [];
    if (needsBen) chips.push(["/admin/requests/", needsBen + (needsBen === 1 ? " request needs you" : " requests need you"), "warn"]);
    if (failed) chips.push(["/admin/emails/#failed", failed + (failed === 1 ? " email failed" : " emails failed"), "err"]);
    if (u.staffRequests) chips.push(["/admin/conversations/", u.staffRequests + (u.staffRequests === 1 ? " person asked for staff follow-up" : " people asked for staff follow-up"), "warn"]);
    if (open) chips.push(["/admin/requests/", open + (open === 1 ? " request waiting for Claude" : " requests waiting for Claude"), ""]);
    var sc = o.screenChecks;
    if (sc && sc.needsReview) chips.push(["/admin/screen-checks/?show=needs_review", sc.needsReview + (sc.needsReview === 1 ? " screen check to review" : " screen checks to review"), "warn"]);
    if (sc && sc.wantsCall) chips.push(["/admin/screen-checks/?show=call", sc.wantsCall + (sc.wantsCall === 1 ? " person asked for a call (screen check)" : " people asked for a call (screen check)"), "warn"]);
    if (!chips.length) needs.appendChild(el("span", { class: "hint", text: "Nothing needs you right now." }));
    chips.forEach(function (c) { needs.appendChild(el("a", { href: c[0], class: c[2], text: c[1] })); });

    var stats = [[u.conversations, "conversations started"], [u.byMode.voice, "by voice"], [u.byMode.text, "by typing"], [u.summariesConfirmed, "confirmed their summary"], [u.completed, "reached suggestions"], [sent, "plan emails sent"], [u.staffRequests, "asked for staff follow-up"]];
    var box = $("stats"); box.textContent = "";
    stats.forEach(function (s) { box.appendChild(el("div", { class: "stat" }, [el("div", { class: "num", text: String(s[0]) }), el("div", { class: "lbl", text: s[1] })])); });
    // Screen settings check, this calendar month: time taken and staff time.
    if (sc && (sc.on || sc.started)) {
      var sbox = $("check-stats");
      sbox.hidden = false;
      var g = sbox.querySelector(".grid"); g.textContent = "";
      [[sc.finished, "screen checks finished"], [sc.avgMinutes == null ? "—" : sc.avgMinutes + " min", "average time to finish"], [sc.reviewed, "reviewed by staff"], [sc.avgReviewMinutes == null ? "—" : sc.avgReviewMinutes + " min", "average staff review time"], [sc.reviewMinutes + " min", "staff review time in all"]]
        .forEach(function (s) { g.appendChild(el("div", { class: "stat" }, [el("div", { class: "num", text: String(s[0]) }), el("div", { class: "lbl", text: s[1] })])); });
    }

    var days = Object.keys(u.byDay).sort().reverse();
    var max = Math.max.apply(null, [1].concat(days.map(function (d) { return u.byDay[d]; })));
    var tb = $("per-day").tBodies[0]; tb.textContent = "";
    if (!days.length) tb.appendChild(el("tr", null, [el("td", { colspan: "3", class: "muted", text: "No conversations in the last 30 days." })]));
    days.forEach(function (d) {
      tb.appendChild(el("tr", null, [
        el("td", { text: new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) }),
        el("td", { class: "n", text: String(u.byDay[d]) }),
        el("td", null, [el("span", { class: "bar", style: "width:" + Math.round((u.byDay[d] / max) * 12) + "rem" })])
      ]));
    });
    $("storage-note").textContent = o.storage === "ephemeral" ? "The demo server keeps conversations in temporary storage, so these counts reset whenever it restarts or a new version is published." : (o.retentionDays ? "Conversations are kept for " + o.retentionDays + " days." : "Conversations are kept until an admin deletes them.");

    var recent = $("recent"); recent.textContent = "";
    if (!log.length) recent.appendChild(el("li", { class: "muted", text: "No changes logged yet." }));
    log.slice(0, 4).forEach(function (e) {
      recent.appendChild(el("li", { class: e.kind }, [el("div", { style: "font-weight:700", text: e.title }), el("div", { class: "hint", text: A.ago(e.at) + (e.summary ? " · " + e.summary : "") })]));
    });
  }
})();
