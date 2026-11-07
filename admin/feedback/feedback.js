/* Feedback: what people said at the end of a conversation, and their rating.
   Filters at the top, Markdown copy (one item or everything shown) and a .md
   download, and permanent delete that needs DELETE typed to confirm. */
(function () {
  "use strict";
  var A = window.V360Admin;
  var $ = function (id) { return document.getElementById(id); };
  var el = A.el;
  var TOOL = { assistant: "Resource Assistant", assessment: "Vision Assessment", form: "Form" };
  var MODE = { spoken: "Spoken", typed: "Typed", spoken_edited: "Spoken, then edited" };
  var FIELDS = ["tool", "rating", "from", "to", "q"];
  var PAGE = 50;
  var shown = [], selected = new Set(), total = 0;

  try { localStorage.setItem("v360-feedback-seen", new Date().toISOString()); } catch (e) {}

  function params(offset, md) {
    var q = new URLSearchParams();
    FIELDS.forEach(function (k) { var v = $("f-" + k).value.trim(); if (v) q.set(k, v); });
    var url = location.pathname + (q.toString() ? "?" + q.toString() : "");
    if (url !== location.pathname + location.search) history.replaceState(null, "", url);
    if (md) q.set("format", "md"); else { q.set("limit", PAGE); q.set("offset", offset || 0); }
    return "/api/admin/feedback?" + q.toString();
  }
  function readFilters() {
    var q = new URLSearchParams(location.search);
    FIELDS.forEach(function (k) { var v = q.get(k); if (v != null) $("f-" + k).value = v; });
  }

  function stars(n) { return n ? "★".repeat(n) + "☆".repeat(5 - n) : ""; }
  // Clipboard API first; if the browser refuses, the older copy command.
  function copy(text, done) {
    function legacy() {
      var t = el("textarea", { style: "position:fixed;top:0;left:0;opacity:0" }); t.value = text; document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) {} t.remove();
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, legacy);
    else legacy();
  }
  function flash(btn, text) { var was = btn.textContent; btn.textContent = text; setTimeout(function () { btn.textContent = was; }, 2500); }

  function item(f) {
    var ck = el("input", { type: "checkbox", "aria-label": "Select this feedback" });
    ck.checked = selected.has(f.id);
    ck.addEventListener("change", function () { if (ck.checked) selected.add(f.id); else selected.delete(f.id); updateBulk(); });
    var cbtn = el("button", { type: "button", class: "btn sm", text: "Copy as Markdown" });
    cbtn.addEventListener("click", function () { copy(f.markdown, function (ok) { flash(cbtn, ok ? "Copied ✓" : "Couldn't copy"); }); });
    var tool = f.tool === "form" && f.flow_title ? f.flow_title : TOOL[f.tool] || f.tool;
    var meta = el("p", { class: "fb-meta" }, [
      el("strong", { text: A.when ? A.when(f.created_at) : new Date(f.created_at).toLocaleString() }),
      el("span", { class: "chip sky", text: tool }),
      f.mode ? el("span", { class: "chip", text: MODE[f.mode] || f.mode }) : null,
      f.rating ? el("span", { class: "chip ok", title: f.rating + " out of 5", "aria-label": "Rated " + f.rating + " out of 5", text: stars(f.rating) + " " + f.rating + "/5" }) : null,
    ]);
    var body = f.text ? el("blockquote", { class: "fb-text", text: f.text }) : el("p", { class: "hint", text: "No written feedback, rating only." });
    var conv = f.conversation_exists
      ? el("a", { href: "/admin/conversations/#" + f.session_id, text: "Open the conversation" })
      : el("span", { class: "hint", text: "Conversation deleted" });
    return el("li", { class: "fb-item" }, [el("div", { class: "fb-ck" }, [ck]), el("div", { class: "fb-main" }, [meta, body, el("p", { class: "fb-foot" }, [conv, cbtn])])]);
  }

  function updateBulk() {
    $("del-selected").disabled = !selected.size;
    $("del-selected").textContent = selected.size ? "Delete selected (" + selected.size + ")" : "Delete selected";
    $("sel-all").checked = shown.length > 0 && shown.every(function (f) { return selected.has(f.id); });
  }

  function load(offset) {
    offset = offset || 0;
    if (!offset) { shown = []; $("rows").textContent = ""; }
    A.api("GET", params(offset)).then(function (j) {
      total = j.total;
      j.items.forEach(function (f) { shown.push(f); $("rows").appendChild(item(f)); });
      if (!shown.length) $("rows").appendChild(el("li", { class: "hint", text: "No feedback matches these filters yet." }));
      $("count").textContent = "Showing " + shown.length + " of " + total + ".";
      $("more").hidden = shown.length >= total;
      var s = j.stats || {};
      $("st-items").textContent = s.items != null ? String(s.items) : "–";
      $("st-rating").textContent = s.averageRating != null ? s.averageRating + " / 5" : "–";
      $("st-rate").textContent = s.responseRate != null ? Math.round(s.responseRate * 100) + "%" : "–";
      updateBulk();
    }).catch(function (e) { $("count").textContent = "⚠ " + e.message; });
  }

  function markdown() {
    return fetch(params(0, true), { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
  }
  $("copy-all").addEventListener("click", function () {
    var b = this;
    markdown().then(function (md) { copy(md, function (ok) { flash(b, ok ? "Copied " + total + " item" + (total === 1 ? "" : "s") + " ✓" : "Couldn't copy"); }); }, function () { flash(b, "Couldn't load"); });
  });
  $("download").addEventListener("click", function () {
    var b = this;
    markdown().then(function (md) {
      var a = el("a", { href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })), download: "vision360-feedback-" + new Date().toISOString().slice(0, 10) + ".md" });
      document.body.appendChild(a); a.click(); a.remove();
    }, function () { flash(b, "Couldn't load"); });
  });

  var timer = null;
  $("filters").addEventListener("input", function (e) { clearTimeout(timer); timer = setTimeout(function () { selected.clear(); load(0); }, e.target.id === "f-q" ? 350 : 0); });
  $("filters").addEventListener("submit", function (e) { e.preventDefault(); });
  $("f-clear").addEventListener("click", function () { FIELDS.forEach(function (k) { $("f-" + k).value = ""; }); selected.clear(); load(0); });
  $("more").addEventListener("click", function () { load(shown.length); });
  $("sel-all").addEventListener("change", function () {
    var on = this.checked;
    shown.forEach(function (f) { if (on) selected.add(f.id); else selected.delete(f.id); });
    [].forEach.call(document.querySelectorAll(".fb-ck input"), function (c) { c.checked = on; });
    updateBulk();
  });

  // ---- Delete: always asks, and needs DELETE typed exactly ----
  var pending = [];
  function closeDelete() { var d = $("del-dialog"); if (d.close) d.close(); else d.removeAttribute("open"); }
  $("del-selected").addEventListener("click", function () {
    pending = Array.from(selected);
    var n = pending.length;
    $("del-title").textContent = n === 1 ? "Delete this feedback?" : "Delete " + n + " feedback items?";
    $("del-warning").textContent = "You are about to permanently delete " + (n === 1 ? "1 feedback item" : n + " feedback items") + ". The conversations they came from are not affected.";
    $("del-input").value = ""; $("del-go").disabled = true; $("del-error").hidden = true;
    var d = $("del-dialog"); if (d.showModal) d.showModal(); else d.setAttribute("open", "");
    $("del-input").focus();
  });
  $("del-input").addEventListener("input", function () { $("del-go").disabled = this.value !== "DELETE"; });
  $("del-cancel").addEventListener("click", closeDelete);
  $("del-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if ($("del-input").value !== "DELETE") return;
    $("del-go").disabled = true;
    A.api("POST", "/api/admin/feedback/delete", { ids: pending, confirm: "DELETE" }).then(function (j) {
      closeDelete(); selected.clear(); load(0);
      setTimeout(function () { $("count").textContent = "✓ Deleted " + j.deleted + ". " + $("count").textContent; }, 400);
    }).catch(function (err) { $("del-error").textContent = "⚠ " + err.message; $("del-error").hidden = false; $("del-go").disabled = false; });
  });

  readFilters();
  load(0);
})();
