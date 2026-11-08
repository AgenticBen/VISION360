/* Home page: the display settings bar only. Text size and colors are the
   shared settings (display-settings.js), so a change here carries over to
   every page. */
(function () {
  "use strict";
  var BAR_KEY = "v360-demo-bar";
  var D = window.V360Display;
  var THEME_NAMES = { standard: "Standard colors", dark: "Dark", high: "High contrast" };
  var $ = function (id) { return document.getElementById(id); };
  var settings = D.get();

  function apply() {
    [].forEach.call(document.querySelectorAll("#display-bar [data-set]"), function (b) {
      b.setAttribute("aria-pressed", String(settings[b.getAttribute("data-set")] === b.getAttribute("data-value")));
    });
    $("dbar-summary").textContent = "Text " + settings.textSize + "% · " + THEME_NAMES[settings.theme];
  }
  function save() { settings = D.set({ textSize: settings.textSize, theme: settings.theme }); }
  D.onChange(function (d) { settings = d; apply(); });
  function setOpen(open, remember) {
    $("dbar-toggle").setAttribute("aria-expanded", String(open));
    $("dbar-body").hidden = !open;
    $("dbar-action").textContent = open ? "Hide" : "Show";
    $("display-bar").classList.toggle("is-collapsed", !open);
    if (remember) { try { localStorage.setItem(BAR_KEY, open ? "open" : "closed"); } catch (e) {} }
  }

  var barSaved = null;
  try { barSaved = localStorage.getItem(BAR_KEY); } catch (e) {}
  setOpen(barSaved !== "closed", false);
  apply();

  // The screen settings check appears once an admin switches it on.
  // (site-menu.js loads after this file and shares one cached lookup.)
  window.addEventListener("load", function () {
    (window.V360SiteFeatures ? window.V360SiteFeatures() : Promise.resolve({})).then(function (f) {
      if (f.screenCheck && $("go-check")) $("go-check").hidden = false;
      // With the check on, the Vision Assessment is the live test: say so.
      if (f.screenCheck) ["assess-text", "assess-go-text"].forEach(function (id) { var n = $(id); if (n && n.getAttribute("data-live")) n.textContent = n.getAttribute("data-live"); });
    }).catch(function () {});
  });

  $("dbar-toggle").addEventListener("click", function () { setOpen($("dbar-toggle").getAttribute("aria-expanded") !== "true", true); });
  $("display-bar").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-set]") : null;
    if (!b) return;
    settings[b.getAttribute("data-set")] = b.getAttribute("data-value");
    apply(); save();
    var a = $("announcer"); a.textContent = "";
    setTimeout(function () { a.textContent = b.closest(".dbar-group").querySelector(".dbar-label").textContent + ": " + b.textContent; }, 60);
  });
})();
