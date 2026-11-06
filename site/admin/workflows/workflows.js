/* Workflows list: one card per workflow, with versions and draft state. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  A.api("GET", "/api/flows").then(function (j) {
    var note = document.getElementById("gh-note");
    if (j.storage !== "github") { note.hidden = false; note.textContent = "GitHub isn't connected, so published versions are kept on this server only and disappear when it restarts. Add V360_GITHUB_TOKEN in Vercel to save them for good (see Connect Claude & ChatGPT)."; }
    if (!j.editsOn) { note.hidden = false; note.textContent = "Editing is switched off on this site (V360_FLOW_EDITS=off)."; }
    var box = document.getElementById("flows"); box.textContent = "";
    j.flows.forEach(function (f) {
      var used = f.usedBy.length ? f.usedBy.map(function (u) { return el("span", { class: "chip sky", text: u }); }) : [el("span", { class: "chip", text: "Not used live yet" })];
      box.appendChild(el("article", { class: "card", style: "display:flex;flex-direction:column;gap:8px;margin:0" }, [
        el("div", { class: "req-head" }, [el("h2", { style: "margin:0", text: f.title }), f.draft ? el("span", { class: "chip amber", text: "Unpublished draft" }) : null]),
        el("p", { class: "muted", style: "margin:0", text: f.description }),
        el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, used),
        el("dl", { class: "kv", style: "font-size:14px" }, [
          el("dt", { text: "Questions" }), el("dd", { text: f.questions + " in " + f.sections + " sections · " + f.followUps + " follow-up" + (f.followUps === 1 ? "" : "s") }),
          el("dt", { text: "Version" }), el("dd", { text: "v" + f.version + (f.lastPublished && f.lastPublished.date ? " · " + A.ago(f.lastPublished.date) + (f.lastPublished.author ? " by " + f.lastPublished.author : "") : "") }),
          f.draft ? el("dt", { text: "Draft" }) : null, f.draft ? el("dd", { text: "Saved " + A.ago(f.draft.updated_at) + " by " + f.draft.author }) : null
        ]),
        el("div", { style: "margin-top:auto;display:flex;gap:8px" }, [
          el("a", { class: "btn primary", href: "/admin/workflows/edit/?flow=" + encodeURIComponent(f.id), text: "Open editor" }),
          el("a", { class: "btn", href: "/" + f.file.replace(/^site\//, ""), text: "View JSON" })
        ])
      ]));
    });
  }).catch(function (e) { document.getElementById("flows").textContent = "Couldn't load: " + e.message; });
})();
