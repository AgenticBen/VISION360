/* Home page: the display settings bar only (same saved settings as the
   assistant pages, so a change here carries over to them). */
(function () {
  "use strict";
  var KEY = "v360-demo-settings", BAR_KEY = "v360-demo-bar";
  var THEME_NAMES = { standard: "Standard colors", dark: "Dark", high: "High contrast" };
  var $ = function (id) { return document.getElementById(id); };
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) {}
  var settings = { textSize: saved.textSize || "150", theme: saved.theme || "high" };

  function apply() {
    document.documentElement.setAttribute("data-textsize", settings.textSize);
    document.documentElement.setAttribute("data-theme", settings.theme);
    [].forEach.call(document.querySelectorAll("#display-bar [data-set]"), function (b) {
      b.setAttribute("aria-pressed", String(settings[b.getAttribute("data-set")] === b.getAttribute("data-value")));
    });
    $("dbar-summary").textContent = "Text " + settings.textSize + "% · " + THEME_NAMES[settings.theme];
  }
  function save() {
    // Keep the assistant's other settings (voice, speed) as they are.
    try { localStorage.setItem(KEY, JSON.stringify(Object.assign({}, saved, settings))); } catch (e) {}
  }
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
