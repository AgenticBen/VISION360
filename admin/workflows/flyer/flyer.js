/* Fills the flyer for ?flow=<id> from /api/flows; the QR code comes from /api/qr. */
(function () {
  "use strict";
  var id = new URLSearchParams(location.search).get("flow") || "";
  var $ = function (x) { return document.getElementById(x); };
  document.getElementById("print").addEventListener("click", function () { window.print(); });
  fetch("/api/flows", { credentials: "same-origin", cache: "no-store" }).then(function (r) {
    if (r.status === 401) { location.href = "/admin/login/?next=" + encodeURIComponent(location.pathname + location.search); throw new Error("sign in"); }
    return r.json();
  }).then(function (j) {
    var f = (j.flows || []).filter(function (x) { return x.id === id; })[0];
    if (!f || !f.url) { $("f-title").textContent = f ? "Publish this workflow first" : "No workflow called " + id; $("print").disabled = true; return; }
    $("f-title").textContent = f.title;
    $("f-desc").textContent = f.routing
      ? "Find vision-loss services in the Charlotte area by talking or typing with our assistant."
      : "Answer a few questions by talking or typing, and the Lions Services team will follow up.";
    // A form's own introduction reads better on a flyer than its admin description.
    fetch("/api/assistant?flow=" + encodeURIComponent(f.id), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (a) {
      if (a.flow && a.flow.intro && !f.routing) $("f-desc").textContent = a.flow.intro;
    }).catch(function () {});
    $("f-qr").src = f.qr;
    $("f-qr").alt = "QR code that opens " + f.url;
    $("f-url").textContent = f.url.replace(/^https?:\/\//, "");
    document.title = "Vision 360 - " + f.title + " - flyer";
  }).catch(function () {});
})();
