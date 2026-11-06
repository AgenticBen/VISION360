/* Requests page (the CRM's "For Claude" layout): app changes and content
   changes, each with status chips and a comment thread; done ones in Archive. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var CHIP = { open: ["Waiting", ""], in_progress: ["In progress", "sky"], needs_ben: ["Needs you", "amber"], done: ["Done", "ok"], cancelled: ["Cancelled", "strike"] };
  var GROUPS = [["app", "App changes", "Layout, buttons, features — Claude makes these in the code and ships them."], ["content", "Content changes", "Questions, wording and organizations — Claude edits these through the workflow tools."]];
  var showArchive = false, rows = [];

  function load() { return A.api("GET", "/api/requests").then(function (j) { rows = j.requests; render(); }).catch(function (e) { document.getElementById("groups").textContent = "Couldn't load: " + e.message; }); }

  function card(r) {
    var c = CHIP[r.status] || [r.status, ""];
    var box = el("article", { class: "req", id: "r-" + r.id }, [
      el("div", { class: "req-head" }, [el("span", { class: "chip " + c[1], text: c[0] }), el("span", { class: "req-title", text: r.title })]),
      el("div", { class: "req-meta" }, ["From ", el("a", { href: r.page_path, text: r.page_label || r.page_path }), " · " + A.ago(r.created_at)])
    ]);
    if (r.body !== r.title) box.appendChild(el("p", { style: "margin:8px 0 0;white-space:pre-wrap", text: r.body }));
    if (r.summary) box.appendChild(el("div", { class: "thread" }, [el("div", { class: "msg claude" }, [el("div", { class: "who", text: "Claude · summary" }), r.summary])]));
    if (r.comments.length) box.appendChild(el("div", { class: "thread" }, r.comments.map(function (m) {
      return el("div", { class: "msg " + m.author }, [el("div", { class: "who", text: (m.author === "claude" ? "Claude" : "You") + " · " + A.ago(m.at) }), m.body]);
    })));
    var input = el("textarea", { class: "inp", placeholder: r.status === "done" ? "Not right? Say what's still wrong and it reopens." : "Add a note for Claude…", style: "min-height:52px;margin-top:8px" });
    var actions = el("div", { class: "req-actions" });
    var addBtn = el("button", { type: "button", class: "btn sm primary", text: "Comment", onclick: function () {
      if (!input.value.trim()) return;
      A.api("POST", "/api/requests/" + r.id + "/comment", { body: input.value }).then(load);
    } });
    if (r.status !== "cancelled") { box.appendChild(input); actions.appendChild(addBtn); }
    if (r.status !== "done" && r.status !== "cancelled") {
      var doneBtn = el("button", { type: "button", class: "btn sm", text: "Mark done" });
      doneBtn.addEventListener("click", function () {
        var s = window.prompt("Short summary of what changed (max 400 characters):");
        if (s && s.trim()) A.api("POST", "/api/requests/" + r.id + "/status", { status: "done", summary: s.trim() }).then(load).catch(function (e) { alert(e.message); });
      });
      actions.appendChild(doneBtn);
      actions.appendChild(A.confirm2(el("button", { type: "button", class: "btn sm danger", text: "Cancel request" }), "Yes, cancel it", function () { A.api("POST", "/api/requests/" + r.id + "/cancel", {}).then(load); }));
    }
    actions.appendChild(A.confirm2(el("button", { type: "button", class: "btn sm danger", text: "Delete" }), "Confirm delete", function () { A.api("DELETE", "/api/requests/" + r.id).then(load); }));
    box.appendChild(actions);
    return box;
  }

  function render() {
    var live = rows.filter(function (r) { return r.status !== "done" && r.status !== "cancelled"; });
    var archived = rows.filter(function (r) { return r.status === "done" || r.status === "cancelled"; });
    var groups = document.getElementById("groups"); groups.textContent = "";
    GROUPS.forEach(function (g) {
      var mine = live.filter(function (r) { return r.kind === g[0]; });
      var sec = el("section", { class: "card", style: "margin-bottom:14px" }, [el("h2", { text: g[1] + " (" + mine.length + ")" }), el("p", { class: "hint", style: "margin-top:-6px", text: g[2] })]);
      if (!mine.length) sec.appendChild(el("div", { class: "empty", text: "Nothing waiting. Use the round button in the bottom-right corner on the page the change belongs to." }));
      mine.forEach(function (r) { sec.appendChild(card(r)); });
      groups.appendChild(sec);
    });
    var t = document.getElementById("archive-toggle");
    t.textContent = (showArchive ? "Hide archive" : "Archive") + " (" + archived.length + " done)";
    var ar = document.getElementById("archive"); ar.hidden = !showArchive; ar.textContent = "";
    if (showArchive) {
      ar.appendChild(el("h2", { text: "Archive" }));
      if (!archived.length) ar.appendChild(el("div", { class: "empty", text: "Nothing finished yet." }));
      archived.forEach(function (r) { ar.appendChild(card(r)); });
    }
    if (location.hash && document.querySelector(location.hash)) document.querySelector(location.hash).scrollIntoView();
  }
  document.getElementById("archive-toggle").addEventListener("click", function () { showArchive = !showArchive; render(); });
  document.addEventListener("v360:request-sent", load);
  load();
})();
