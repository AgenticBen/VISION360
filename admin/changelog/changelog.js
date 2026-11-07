/* Change log: newest-first timeline of workflow versions, finished requests
   and other logged changes. Opening it marks everything as read. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el, kind = "", entries = [];
  var KIND = { workflow: "Workflow", app: "App", content: "Content" };
  var STATE = { proposed: ["amber", "Checks running"], live: ["ok", "Live"], failed: ["bad", "Not published"] };
  function render() {
    [].forEach.call(document.querySelectorAll("#kind button"), function (b) { b.setAttribute("aria-pressed", String(b.dataset.k === kind)); });
    var ul = document.getElementById("log"); ul.textContent = "";
    var rows = entries.filter(function (e) { return !kind || e.kind === kind; });
    if (!rows.length) ul.appendChild(el("li", { class: "muted", text: "Nothing logged yet. Workflow publishes and finished requests show up here." }));
    rows.forEach(function (e) {
      var links = el("div", { class: "req-actions" });
      if (e.highlight && e.highlight.page) links.appendChild(el("a", { class: "btn sm", href: e.highlight.page, text: "Show me" }));
      if (e.request_id) links.appendChild(el("a", { class: "btn sm", href: "/admin/requests/#r-" + e.request_id, text: "The request" }));
      if (e.pr_url) links.appendChild(el("a", { class: "btn sm", href: e.pr_url, target: "_blank", rel: "noopener", text: "Pull request #" + e.pr }));
      if (e.ref && /^[0-9a-f]{7,40}$/.test(e.ref)) links.appendChild(el("a", { class: "btn sm", href: "https://github.com/AgenticBen/VISION360/commit/" + e.ref, target: "_blank", rel: "noopener", text: "Commit " + e.ref.slice(0, 7) }));
      ul.appendChild(el("li", { class: e.kind }, [
        el("div", { class: "req-head" }, [el("span", { class: "chip " + (e.kind === "workflow" ? "sky" : e.kind === "content" ? "amber" : ""), text: KIND[e.kind] || e.kind }), el("strong", { text: e.title }), STATE[e.state] ? el("span", { class: "chip " + STATE[e.state][0], text: STATE[e.state][1] }) : null]),
        e.state_note ? el("div", { class: "hint", text: e.state_note }) : null,
        el("div", { class: "hint", text: A.when(e.at) }),
        e.summary ? el("p", { style: "margin:4px 0 0", text: e.summary }) : null,
        links.children.length ? links : null
      ]));
    });
  }
  document.getElementById("kind").addEventListener("click", function (ev) { var b = ev.target.closest("button"); if (!b) return; kind = b.dataset.k; render(); });
  A.api("GET", "/api/changelog").then(function (j) {
    entries = j.entries; render();
    try { if (entries[0]) localStorage.setItem("v360-changelog-seen", entries[0].at); } catch (e) {}
    A.setBadge("/admin/changelog/", 0);
  }).catch(function (e) { document.getElementById("log").textContent = "Couldn't load: " + e.message; });
})();
