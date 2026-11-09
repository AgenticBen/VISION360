/* Workflows: two rows, one per item in the public site menu. Resource
   Assistant (/demo/) and Vision Assessment (/assessment/) each have one live
   version; "Make live" switches it. The Vision Assessment row also has the
   full-screen test, which isn't a JSON workflow. Every published workflow has
   its own link, QR code and flyer. New workflows start as drafts; deleting
   needs the word DELETE. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var $ = function (id) { return document.getElementById(id); };
  var focusId = new URLSearchParams(location.search).get("flow");
  var all = [], rows = null;

  function copyText(btn, text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () {
      var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1500);
    }).catch(function () { window.prompt("Copy this link:", text); });
  }

  // PNG: draw the SVG onto a 1024px canvas in the browser.
  function downloadPng(f) {
    fetch(f.qr, { credentials: "same-origin" }).then(function (r) { return r.text(); }).then(function (svg) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas"); c.width = 1024; c.height = 1024;
        var g = c.getContext("2d"); g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, 1024, 1024);
        c.toBlob(function (b) { var a = el("a", { href: URL.createObjectURL(b), download: "vision360-" + f.id + "-qr.png" }); document.body.appendChild(a); a.click(); a.remove(); });
      };
      img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    });
  }

  // Makes a workflow (or "live-test", the full-screen test) live in its row.
  function makeLive(id, group, btn) {
    btn.disabled = true;
    A.api("PUT", "/api/admin/settings", group === "assessment" ? { assessment: id } : { mainFlow: id }).then(function (r) {
      return load().then(function () { var n = $("gh-note"); n.hidden = false; n.className = "note sky"; n.textContent = "✓ " + (r.note || "Done.") + " The site menu shows it within a minute."; });
    }).catch(function (e) { btn.disabled = false; alert(e.message); });
  }

  // The full-screen test: not a JSON workflow, so it has no editor or versions.
  function testCard(t, live) {
    var actions = [
      el("a", { class: "btn primary", href: live ? t.url : t.url + "?preview=1", target: "_blank", rel: "noopener", text: live ? "Open it" : "Try it" }),
      el("a", { class: "btn", href: t.results, text: "See results" })
    ];
    if (!live) {
      var mb = el("button", { type: "button", class: "btn", text: "Make live" });
      mb.addEventListener("click", function () {
        if (!window.confirm("Make the full-screen test the Vision Assessment on the public site?\n\nPeople who choose Vision Assessment in the menu will get the test straight away. The hearing and about-you questions, the new color order and the reports aren't built yet. The question-and-answer version stays at /assessment/interview/, and you can switch back here at any time.")) return;
        makeLive("live-test", "assessment", mb);
      });
      actions.push(mb);
    }
    return el("article", { class: "card flow-card is-test" + (live ? " is-main" : ""), id: "flow-live-test" }, [
      el("div", { class: "req-head" }, [
        el("h2", { style: "margin:0", text: t.title }),
        live ? el("span", { class: "chip main-chip", text: "★ Live on the site", title: "Vision Assessment in the site menu opens this" }) : el("span", { class: "chip", text: "Not live yet" })
      ]),
      el("p", { class: "muted", style: "margin:0", text: "Two big choices at a time, read aloud and answered by voice, keyboard or touch: speaking speed, text size, pictures, colors, pointer and bold. The page takes on each choice as the person makes it, and staff get the results." }),
      el("p", { class: "hint", style: "margin:0", text: live ? "People get this from Vision Assessment in the site menu." : "Try it opens it just for you; the public doesn't see it until you make it live." }),
      el("dl", { class: "kv", style: "font-size:14px" }, [
        el("dt", { text: "Link" }), el("dd", null, [el("a", { href: t.url, target: "_blank", rel: "noopener", text: location.host + t.url })]),
        el("dt", { text: "Wording" }), el("dd", { text: "site/data/screen-check.json" }),
        el("dt", { text: "Still to come" }), el("dd", { text: "Hearing and about-you questions, technology inventory, white → blue → black colors, reports" })
      ]),
      el("div", { class: "flow-actions" }, actions)
    ]);
  }

  function card(f) {
    var used = f.usedBy.length ? f.usedBy.map(function (u) { return el("span", { class: "chip sky", text: u }); }) : [el("span", { class: "chip", text: "Not used live yet" })];
    var head = el("div", { class: "req-head" }, [
      el("h2", { style: "margin:0", text: f.title }),
      f.onSite ? el("span", { class: "chip main-chip", text: "★ Live on the site", title: f.group === "assessment" ? "Vision Assessment in the site menu opens this" : "Resource Assistant in the site menu runs this" }) : null,
      !f.onSite && rows && f.group === "assessment" && f.id === rows.assessment.flow ? el("span", { class: "chip sky", text: "At /assessment/interview/", title: "The question-and-answer Vision Assessment, while the full-screen test is live" }) : null,
      f.status === "draft" ? el("span", { class: "chip amber", text: "Not published yet" }) : f.draft ? el("span", { class: "chip amber", text: "Unpublished draft" }) : null
    ]);
    var share;
    if (f.url) {
      var copyBtn = el("button", { type: "button", class: "btn sm", text: "Copy link" });
      copyBtn.addEventListener("click", function () { copyText(copyBtn, f.url); });
      share = el("div", { class: "share", "data-tour": f.onSite && f.group !== "assessment" ? "main-flow" : null }, [
        el("img", { class: "share-qr", src: f.qr, alt: "QR code for " + f.title, width: "96", height: "96", loading: "lazy" }),
        el("div", { class: "share-body" }, [
          el("p", { class: "share-label", text: f.onSite ? "Live on the site — also at its own link:" : "Share this workflow:" }),
          el("a", { class: "share-url", href: f.url, target: "_blank", rel: "noopener", text: f.url.replace(/^https?:\/\//, "") }),
          el("div", { class: "share-actions" }, [
            copyBtn,
            el("a", { class: "btn sm", href: f.qr, download: "vision360-" + f.id + "-qr.svg", text: "QR (SVG)" }),
            el("button", { type: "button", class: "btn sm", text: "QR (PNG)", onclick: function () { downloadPng(f); } }),
            el("a", { class: "btn sm", href: "/admin/workflows/flyer/?flow=" + encodeURIComponent(f.id), target: "_blank", rel: "noopener", text: "Flyer PDF" })
          ])
        ])
      ]);
    } else if (f.status === "published") {
      share = el("p", { class: "hint", text: "Published — its link and QR code appear once the site has redeployed (a few minutes)." });
    } else {
      share = el("p", { class: "hint", text: "Publish this workflow to get its link, QR code and flyer." });
    }
    var actions = [el("a", { class: "btn primary", href: "/admin/workflows/edit/?flow=" + encodeURIComponent(f.id), text: f.status === "draft" ? "Edit draft" : "Open editor" })];
    if (f.status !== "draft") actions.push(el("a", { class: "btn", href: "/" + f.file.replace(/^site\//, ""), text: "View JSON" }));
    if (!f.onSite && f.canGoLive) { var mb = el("button", { type: "button", class: "btn", text: "Make live" }); mb.addEventListener("click", function () { makeLive(f.id, f.group, mb); }); actions.push(mb); }
    var protectedId = rows && (f.id === rows.assistant.live || f.id === rows.assessment.flow);
    if (!f.onSite && !protectedId && f.id !== "referral") actions.push(el("button", { type: "button", class: "btn danger", text: "Delete", onclick: function () { askDelete(f); } }));
    var art = el("article", { class: "card flow-card" + (f.onSite ? " is-main" : ""), id: "flow-" + f.id }, [
      head,
      el("p", { class: "muted", style: "margin:0", text: f.description || "" }),
      el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, used),
      share,
      el("dl", { class: "kv", style: "font-size:14px" }, [
        el("dt", { text: "Questions" }), el("dd", { text: f.questions + " in " + f.sections + " section" + (f.sections === 1 ? "" : "s") + " · " + f.followUps + " follow-up" + (f.followUps === 1 ? "" : "s") }),
        el("dt", { text: "Version" }), el("dd", { text: f.version ? "v" + f.version + (f.lastPublished && f.lastPublished.date ? " · " + A.ago(f.lastPublished.date) + (f.lastPublished.author ? " by " + f.lastPublished.author : "") : "") : "Draft only" }),
        f.draft ? el("dt", { text: "Draft" }) : null, f.draft ? el("dd", { text: "Saved " + A.ago(f.draft.updated_at) + " by " + f.draft.author }) : null
      ]),
      el("div", { class: "flow-actions" }, actions)
    ]);
    return art;
  }

  function load() {
    return A.api("GET", "/api/flows").then(function (j) {
      all = j.flows;
      var note = $("gh-note");
      note.hidden = true;
      if (j.storage !== "github") { note.hidden = false; note.textContent = "GitHub isn't connected, so published versions are kept on this server only and disappear when it restarts. Add V360_GITHUB_TOKEN in Vercel to save them for good (see Settings)."; }
      if (!j.editsOn) { note.hidden = false; note.textContent = "Editing is switched off on this site (V360_FLOW_EDITS=off)."; }
      rows = j.rows;
      var testLive = rows.assessment.live === "live-test";
      // One row per menu item; the live one first.
      ["assistant", "assessment"].forEach(function (g) {
        var box = $("row-" + g); box.textContent = "";
        var cards = j.flows.filter(function (f) { return f.group === g; }).sort(function (a, b) { return (b.onSite ? 1 : 0) - (a.onSite ? 1 : 0); }).map(card);
        if (g === "assessment") { var t = testCard(rows.assessment.test, testLive); if (testLive) cards.unshift(t); else cards.push(t); }
        cards.forEach(function (c) { box.appendChild(c); });
      });
      var copy = $("nf-copy");
      copy.textContent = "";
      copy.appendChild(el("option", { value: "", text: "A blank form (one name question)" }));
      j.flows.filter(function (f) { return !f.routing; }).forEach(function (f) { copy.appendChild(el("option", { value: f.id, "data-group": f.group, text: "A copy of " + f.title })); });
      if (focusId && $("flow-" + focusId)) { $("flow-" + focusId).classList.add("focus-ring"); $("flow-" + focusId).scrollIntoView({ block: "center" }); focusId = null; }
    }).catch(function (e) { $("flows").textContent = "Couldn't load: " + e.message; });
  }

  // ---- new workflow
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40).replace(/-+$/, ""); }
  var idTouched = false;
  $("new-flow").addEventListener("click", function () {
    $("new-form").reset(); idTouched = false; $("nf-error").hidden = true; $("nf-url").textContent = "";
    $("new-dialog").showModal(); $("nf-title").focus();
  });
  $("nf-title").addEventListener("input", function () { if (!idTouched) { $("nf-id").value = slug(this.value); showUrl(); } });
  $("nf-id").addEventListener("input", function () { idTouched = true; showUrl(); });
  function showUrl() { $("nf-url").textContent = $("nf-id").value ? "Its link will be " + location.origin + "/f/" + $("nf-id").value : ""; }
  // A copy starts in its source's row.
  $("nf-copy").addEventListener("change", function () { var o = this.options[this.selectedIndex]; if (o && o.getAttribute("data-group")) $("nf-row").value = o.getAttribute("data-group"); });
  $("nf-cancel").addEventListener("click", function () { $("new-dialog").close(); });
  $("new-form").addEventListener("submit", function (e) {
    e.preventDefault();
    $("nf-go").disabled = true; $("nf-error").hidden = true;
    A.api("POST", "/api/flows", { id: $("nf-id").value.trim(), title: $("nf-title").value.trim(), description: $("nf-desc").value.trim(), copyFrom: $("nf-copy").value || null, group: $("nf-row").value })
      .then(function (r) { location.href = "/admin/workflows/edit/?flow=" + encodeURIComponent(r.id); })
      .catch(function (err) { $("nf-error").textContent = "⚠ " + err.message; $("nf-error").hidden = false; $("nf-go").disabled = false; });
  });

  // ---- delete (type DELETE)
  var deleting = null;
  function askDelete(f) {
    deleting = f;
    $("del-title").textContent = "Delete “" + f.title + "”?";
    $("del-warning").textContent = f.status === "draft"
      ? "This draft workflow was never published. Deleting it removes it for good."
      : "Its link and QR code will stop working and it disappears from this page once the change is live (a few minutes). Conversations people already had with it are kept and stay in Conversations.";
    $("del-input").value = ""; $("del-go").disabled = true; $("del-error").hidden = true;
    $("del-dialog").showModal(); $("del-input").focus();
  }
  $("del-input").addEventListener("input", function () { $("del-go").disabled = this.value !== "DELETE"; });
  $("del-cancel").addEventListener("click", function () { $("del-dialog").close(); });
  $("del-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if ($("del-input").value !== "DELETE" || !deleting) return;
    $("del-go").disabled = true;
    A.api("DELETE", "/api/flows/" + encodeURIComponent(deleting.id), { confirm: "DELETE" })
      .then(function (r) { $("del-dialog").close(); var n = $("gh-note"); load().then(function () { n.hidden = false; n.className = "note sky"; n.textContent = "✓ " + r.live; }); })
      .catch(function (err) { $("del-error").textContent = "⚠ " + err.message; $("del-error").hidden = false; $("del-go").disabled = false; });
  });

  load();
})();
