/* Admin › Screen checks: the follow-up list, one result with accept / edit /
   reject for each recommendation, the case note to paste into Unitus, earlier
   checks by the same person, and delete (type DELETE). Every control is a
   real button, select or field, so it works with a screen reader. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el, api = A.api;
  var $ = function (id) { return document.getElementById(id); };
  var NAMES = { speech_rate: "Speaking speed", magnification: "Text size", pictures: "Pictures", contrast: "Colors", cursor: "Pointer", bold: "Text weight" };
  var THEMES = { high: "High contrast", dark: "Light on dark", blue: "White on dark blue", standard: "Dark on white" };
  var selected = new Set(), current = null, openedAt = 0;

  var STATE = { in_progress: "In progress", left: "Left without ending", ended: "Ended early", finished: "Finished" };
  function statusWords(r) {
    if (r.state === "in_progress" || r.state === "left") return STATE[r.state];
    var staff = { needs_review: "Needs review", reviewed: "Reviewed", closed: "Closed" }[r.staff_status] || r.staff_status;
    return r.state === "ended" ? "Ended early · " + staff : staff;
  }

  // ---------------------------------------------------------------- list
  function loadList() {
    $("detail").hidden = true; $("list").hidden = false;
    var show = $("f-show").value;
    api("GET", "/api/admin/checks?filter=" + encodeURIComponent(show)).then(function (j) {
      var tb = $("rows"); tb.textContent = "";
      selected.clear(); syncBulk();
      j.checks.forEach(function (r) {
        var ck = el("input", { type: "checkbox", "aria-label": "Select the check started " + A.when(r.created_at) });
        ck.addEventListener("change", function () { if (ck.checked) selected.add(r.id); else selected.delete(r.id); syncBulk(); });
        var tags = [];
        if (r.attention) tags.push("Needs attention");
        if (r.wants_call) tags.push("Asked for a call");
        if (r.retake) tags.push("Retake");
        if (r.linked) tags.push("With Vision Assessment");
        tb.appendChild(el("tr", null, [
          el("td", { class: "ck" }, [ck]),
          el("td", { text: A.when(r.created_at) }),
          el("td", { text: r.device }),
          el("td", { text: statusWords(r) }),
          el("td", { text: r.settings.magnification ? r.settings.magnification + "%" : "—" }),
          el("td", { text: r.settings.contrast ? THEMES[r.settings.contrast] || r.settings.contrast : "—" }),
          el("td", { text: tags.join(", ") || "—" }),
          el("td", null, [el("button", { type: "button", class: "btn", text: "Open", "aria-label": "Open the check started " + A.when(r.created_at), onclick: function () { openCheck(r.id); } })]),
        ]));
      });
      if (!j.checks.length) tb.appendChild(el("tr", null, [el("td", { colspan: "8", class: "hint", text: j.total ? "No checks match this filter." : "No screen checks yet." })]));
      $("totals").textContent = j.total + " check" + (j.total === 1 ? "" : "s") + " in all · " + j.counts.needs_review + " to review · " + j.counts.unfinished + " not finished (" + (j.counts.ended || 0) + " ended early, " + (j.counts.left || 0) + " left without ending) · " + j.counts.call + " asked for a call" + (j.avgMinutes != null ? " · about " + j.avgMinutes + " min to finish on average" : "");
      A.setBadge("/admin/screen-checks/", j.counts.needs_review);
    }).catch(function (e) { $("totals").textContent = "⚠ " + e.message; });
  }
  function syncBulk() {
    $("del-selected").disabled = !selected.size;
    $("del-selected").textContent = selected.size ? "Delete selected (" + selected.size + ")" : "Delete selected";
    $("count").textContent = selected.size ? selected.size + " selected" : "";
  }
  $("f-show").addEventListener("change", function () { history.replaceState(null, "", "?show=" + this.value); loadList(); });
  $("sel-all").addEventListener("change", function () {
    var on = this.checked;
    [].forEach.call($("rows").querySelectorAll("input[type=checkbox]"), function (c) { c.checked = on; c.dispatchEvent(new Event("change")); });
  });

  // ---------------------------------------------------------------- one check
  function openCheck(id) {
    current = id; openedAt = Date.now();
    history.replaceState(null, "", location.pathname + location.search + "#" + id);
    api("GET", "/api/admin/checks/" + id).then(render).catch(function (e) { alert(e.message); });
  }
  function render(j) {
    var c = j.check;
    $("list").hidden = true; $("detail").hidden = false;
    $("detail-h").textContent = "Screen check, " + A.when(c.created_at) + (c.previous_check_id ? " (retake)" : "");
    var body = $("detail-body"); body.textContent = "";
    var facts = el("dl", { class: "kv" });
    function fact(k, v) { if (v) { facts.appendChild(el("dt", { text: k })); facts.appendChild(el("dd", null, [v])); } }
    fact("Status", c.state === "finished" ? "Finished " + A.when(c.finished_at) : c.state === "ended" ? "Ended early " + A.when(c.ended_at) : c.state_words || "Not finished");
    fact("Not reached", c.not_reached && c.not_reached.length ? c.not_reached.join(", ") : null);
    fact("Changed outside the tests", c.change_words && c.change_words.length ? el("ul", null, c.change_words.map(function (w) { return el("li", { text: w }); })) : null);
    fact("Device", c.device_words);
    fact("Goal", c.goal || "Not given");
    fact("Code", c.code);
    fact("Age range", c.age_range ? c.age_range.replace("_plus", " or older").replace("_", "–") : null);
    fact("ZIP", c.zip);
    fact("Contact", c.consent_contact && c.contact ? [c.contact.first_name, c.contact.phone, c.contact.email].filter(Boolean).join(", ") + (c.wants_call ? " (asked for a call)" : "") : "None given");
    if (c.assessment_session_id) fact("Vision Assessment", el("a", { href: "/admin/conversations/#" + c.assessment_session_id, text: "Open the linked conversation" }));
    body.appendChild(facts);
    if (j.attention) body.appendChild(el("p", { class: "danger-text", text: "⚠ Needs attention: very large text or a magnifier, or the person struggled. See the notes under each setting." }));

    // Review form: one fieldset per setting.
    var last = j.reviews[0] || null;
    var form = el("form", { id: "review-form", novalidate: true });
    form.appendChild(el("h3", { text: "Recommendations" }));
    j.steps.forEach(function (s) {
      var prev = last && last.decisions && last.decisions[s.setting];
      var fs = el("fieldset", { class: "review-set" }, [el("legend", { text: s.name })]);
      fs.appendChild(el("p", { text: s.summary }));
      if (s.flag_words && s.flag_words.length) fs.appendChild(el("p", { class: "hint", text: "Noticed: " + s.flag_words.join("; ") }));
      fs.appendChild(el("p", { class: "hint", text: s.tries + " answer" + (s.tries === 1 ? "" : "s") + (s.duration_ms ? " · " + Math.round(s.duration_ms / 1000) + " seconds" : "") + (s.recommended_value == null ? " · not finished" : "") }));
      var name = "d-" + s.setting;
      var edit = el("input", { class: "inp", type: "text", id: name + "-v", "aria-label": "Change " + s.name + " to", placeholder: "Change to…", value: prev && prev.value ? prev.value : "" });
      var row = el("div", { class: "choice-row", role: "radiogroup", "aria-label": "Decision for " + s.name });
      [["accept", "Accept"], ["edit", "Edit"], ["reject", "Reject"]].forEach(function (o) {
        var r = el("input", { type: "radio", name: name, value: o[0], id: name + "-" + o[0] });
        if (prev ? prev.decision === o[0] : o[0] === "accept" && s.recommended_value != null) r.checked = true;
        r.addEventListener("change", function () { edit.hidden = r.value !== "edit" || !r.checked; if (!edit.hidden) edit.focus(); });
        row.appendChild(el("label", { for: r.id, class: "choice" }, [r, " " + o[1]]));
      });
      edit.hidden = !(prev && prev.decision === "edit");
      fs.appendChild(row); fs.appendChild(edit);
      form.appendChild(fs);
    });
    form.appendChild(el("label", { class: "fl", for: "r-next", text: "Next steps" }));
    form.appendChild(el("textarea", { class: "inp", id: "r-next", rows: "3", placeholder: "For example: bring to Lion's Den for ZoomText at 2x on a 24-inch monitor" }, [last && last.next_steps ? last.next_steps : ""]));
    form.appendChild(el("label", { class: "fl", for: "r-notes", text: "Notes" }));
    form.appendChild(el("textarea", { class: "inp", id: "r-notes", rows: "3" }, [last && last.notes ? last.notes : ""]));
    form.appendChild(el("label", { class: "fl", for: "r-status", text: "Status after saving" }));
    var stSel = el("select", { class: "inp", id: "r-status" }, [["reviewed", "Reviewed"], ["closed", "Closed"], ["needs_review", "Still needs review"]].map(function (o) { return el("option", { value: o[0], text: o[1] }); }));
    form.appendChild(stSel);
    var msg = el("p", { class: "hint", role: "status", id: "r-msg" });
    form.appendChild(el("p", null, [el("button", { type: "submit", class: "btn primary", text: "Save review" }), " ", msg]));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var decisions = {};
      j.steps.forEach(function (s) {
        var r = form.querySelector('input[name="d-' + s.setting + '"]:checked');
        if (r) decisions[s.setting] = { decision: r.value, value: r.value === "edit" ? $("d-" + s.setting + "-v").value : null };
      });
      api("POST", "/api/admin/checks/" + c.id + "/review", { decisions: decisions, notes: $("r-notes").value, next_steps: $("r-next").value, staff_status: stSel.value, review_ms: Date.now() - openedAt })
        .then(function (r) { msg.className = "ok-text"; msg.textContent = "✓ Saved."; note.value = r.case_note; openedAt = Date.now(); /* a second save counts only the time since this one */ })
        .catch(function (err) { msg.className = "danger-text"; msg.textContent = "⚠ " + err.message; });
    });
    body.appendChild(form);

    // Case note
    body.appendChild(el("h3", { text: "Case note" }));
    body.appendChild(el("p", { class: "hint", text: "Plain text to paste into Unitus or another case system. It updates when you save the review." }));
    var note = el("textarea", { class: "inp case-note", id: "case-note", rows: "12", readonly: true, "aria-label": "Case note" }, [j.case_note]);
    var copyMsg = el("span", { class: "hint", role: "status" });
    body.appendChild(note);
    body.appendChild(el("p", null, [el("button", { type: "button", class: "btn", text: "Copy case note", onclick: function () {
      (navigator.clipboard ? navigator.clipboard.writeText(note.value) : Promise.reject()).then(function () { copyMsg.textContent = " ✓ Copied."; }).catch(function () { note.select(); copyMsg.textContent = " Selected — press Ctrl+C or ⌘C to copy."; });
    } }), copyMsg]));

    // Earlier checks by the same person (same code): what changed.
    if (j.history.length) {
      body.appendChild(el("h3", { text: "Other checks with this code" }));
      var mine = {}; j.steps.forEach(function (s) { mine[s.setting] = s.recommended_value; });
      var t = el("table", { class: "t" }, [el("caption", { class: "sr-only", text: "Earlier and later checks by the same person" }), el("thead", null, [el("tr", null, [el("th", { scope: "col", text: "Date" })].concat(Object.keys(NAMES).map(function (k) { return el("th", { scope: "col", text: NAMES[k] }); })))])]);
      var tb = el("tbody");
      j.history.forEach(function (h) {
        var vals = {}; h.steps.forEach(function (s) { vals[s.setting] = s.recommended_value; });
        tb.appendChild(el("tr", null, [el("td", { text: A.when(h.created_at) })].concat(Object.keys(NAMES).map(function (k) {
          var v = vals[k] == null ? "—" : vals[k];
          var changed = vals[k] != null && mine[k] != null && vals[k] !== mine[k];
          return el("td", { text: v + (changed ? " (now " + mine[k] + ")" : "") });
        }))));
      });
      t.appendChild(tb);
      body.appendChild(el("div", { class: "table-wrap" }, [t]));
    }

    // Past reviews
    if (j.reviews.length) {
      body.appendChild(el("h3", { text: "Review history" }));
      body.appendChild(el("ul", null, j.reviews.map(function (r) { return el("li", { text: A.when(r.created_at) + " by " + r.reviewer + (r.review_ms ? " · " + Math.round(r.review_ms / 60000) + " min" : "") }); })));
    }
    $("detail-h").focus();
  }
  $("back").addEventListener("click", function () { current = null; history.replaceState(null, "", location.pathname + location.search); loadList(); });

  // ---------------------------------------------------------------- delete
  var pending = [];
  function askDelete(ids) {
    pending = ids.slice();
    var n = pending.length;
    $("del-title").textContent = n === 1 ? "Delete this screen check?" : "Delete " + n + " screen checks?";
    $("del-warning").textContent = "You are about to permanently delete " + (n === 1 ? "1 screen check" : n + " screen checks") + " with every answer, result, review and contact detail in " + (n === 1 ? "it" : "them") + ".";
    $("del-input").value = ""; $("del-go").disabled = true; $("del-error").hidden = true;
    var d = $("del-dialog"); if (d.showModal) d.showModal(); else d.setAttribute("open", "");
    $("del-input").focus();
  }
  function closeDelete() { var d = $("del-dialog"); if (d.close) d.close(); else d.removeAttribute("open"); }
  $("del-input").addEventListener("input", function () { $("del-go").disabled = this.value !== "DELETE"; });
  $("del-cancel").addEventListener("click", closeDelete);
  $("del-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if ($("del-input").value !== "DELETE") return;
    $("del-go").disabled = true;
    api("POST", "/api/admin/checks/delete", { ids: pending, confirm: "DELETE" }).then(function (j) {
      closeDelete(); current = null;
      history.replaceState(null, "", location.pathname + location.search);
      loadList();
      setTimeout(function () { $("count").textContent = "✓ Deleted " + j.deleted + " check" + (j.deleted === 1 ? "" : "s") + "."; }, 400);
    }).catch(function (err) { $("del-error").textContent = "⚠ " + err.message; $("del-error").hidden = false; $("del-go").disabled = false; });
  });
  $("del-selected").addEventListener("click", function () { if (selected.size) askDelete(Array.from(selected)); });
  $("del-one").addEventListener("click", function () { if (current) askDelete([current]); });

  // ---------------------------------------------------------------- start
  var q = new URLSearchParams(location.search).get("show");
  if (q && [].some.call($("f-show").options, function (o) { return o.value === q; })) $("f-show").value = q;
  api("GET", "/api/admin/settings").then(function (r) { $("off-note").hidden = !!(r.settings.features && r.settings.features.screenCheck); }).catch(function () {});
  var deep = /^#([0-9a-f-]{36})$/.exec(location.hash);
  if (deep) openCheck(deep[1]); else loadList();
})();
