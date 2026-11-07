/* One set of display settings for every page: text size, colors and the
   pointer. A change on any page (the directory, the home page, the assistant,
   the Vision Assessment, the guide) carries over to the others.

   Load it in <head>, before any stylesheet that depends on it, so the page
   never paints in the wrong size or colors:

     <script src="/display-settings.js" data-default-size="150" data-default-theme="high"></script>

   The data-default-* attributes are what the page shows to someone who has
   never chosen anything. Nothing is saved until they do.

   Saved in localStorage under "v360-display" (this device only). Older
   saved settings (the assistant's "v360-demo-settings" and the directory's
   "vrd-display-v1") are read once, so nobody loses what they chose.

   Sets on <html>:
     data-textsize  100 | 125 | 150 | 200
     data-theme     standard | dark | high   (assistant, home pages)
     data-contrast  normal | high            (directory, guide: dark shows as normal)
     data-cursor    default | large | xl     (a bigger pointer, on computers)
     data-cursor-color  black | white | yellow
*/
(function (root) {
  "use strict";
  var D = {};
  D.KEY = "v360-display";
  D.LEGACY_ASSISTANT = "v360-demo-settings";
  D.LEGACY_DIRECTORY = "vrd-display-v1";
  D.SIZES = ["100", "125", "150", "200"];
  D.THEMES = ["standard", "dark", "high"];
  D.CURSORS = ["default", "large", "xl"];
  D.CURSOR_COLORS = ["black", "white", "yellow"];
  D.CURSOR_PX = { large: 64, xl: 128 };

  function pick(v, list, dflt) { v = v == null ? "" : String(v); return list.indexOf(v) !== -1 ? v : dflt; }

  // Valid settings from anything, filling gaps from the page's defaults.
  D.normalize = function (raw, defaults) {
    raw = raw || {}; defaults = defaults || {};
    return {
      textSize: pick(raw.textSize, D.SIZES, pick(defaults.textSize, D.SIZES, "100")),
      theme: pick(raw.theme, D.THEMES, pick(defaults.theme, D.THEMES, "standard")),
      cursor: pick(raw.cursor, D.CURSORS, "default"),
      cursorColor: pick(raw.cursorColor, D.CURSOR_COLORS, "black")
    };
  };

  function parse(text) { try { var v = JSON.parse(text || "null"); return v && typeof v === "object" ? v : null; } catch (e) { return null; } }

  // What this person chose, or null if they never chose anything.
  // `get` reads a localStorage key (passed in so this can be tested).
  D.saved = function (get) {
    var now = parse(get(D.KEY));
    if (now) return now;
    var a = parse(get(D.LEGACY_ASSISTANT));
    if (a && (a.textSize || a.theme)) return { textSize: a.textSize, theme: a.theme };
    var d = parse(get(D.LEGACY_DIRECTORY));
    if (d && (d.textsize || d.contrast)) return { textSize: d.textsize, theme: d.contrast === "high" ? "high" : "standard" };
    return null;
  };

  // The attributes to put on <html>.
  D.attributes = function (s) {
    return {
      "data-textsize": s.textSize,
      "data-theme": s.theme,
      "data-contrast": s.theme === "high" ? "high" : "normal",
      "data-cursor": s.cursor,
      "data-cursor-color": s.cursorColor
    };
  };

  // A plain arrow pointer drawn at the chosen size, with an outline in the
  // opposite color so it shows on any background.
  D.cursorCss = function () {
    var fills = { black: ["#000000", "#ffffff"], white: ["#ffffff", "#000000"], yellow: ["#ffd24a", "#000000"] };
    var css = "";
    Object.keys(D.CURSOR_PX).forEach(function (size) {
      var px = D.CURSOR_PX[size];
      D.CURSOR_COLORS.forEach(function (color) {
        var f = fills[color];
        var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + px + "' height='" + px + "' viewBox='0 0 32 32'>" +
          "<path d='M2 2 L2 26 L8.5 20 L13 30 L17 28 L12.5 18.5 L21 18.5 Z' fill='" + f[0] + "' stroke='" + f[1] + "' stroke-width='2' stroke-linejoin='round'/></svg>";
        var url = "url(\"data:image/svg+xml," + encodeURIComponent(svg) + "\") 1 1, auto";
        css += "html[data-cursor='" + size + "'][data-cursor-color='" + color + "'], html[data-cursor='" + size + "'][data-cursor-color='" + color + "'] * { cursor: " + url + " !important; }\n";
      });
    });
    return css;
  };

  root.V360DisplayCore = D;

  // ---- in the browser -------------------------------------------------
  if (typeof document === "undefined" || !document.documentElement) return;
  var script = document.currentScript;
  var html = document.documentElement;
  var defaults = {
    textSize: (script && script.getAttribute("data-default-size")) || html.getAttribute("data-textsize") || "100",
    theme: (script && script.getAttribute("data-default-theme")) || "standard"
  };
  function get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  var listeners = [];
  var current = D.normalize(D.saved(get), defaults);

  function apply() {
    var attrs = D.attributes(current);
    Object.keys(attrs).forEach(function (k) { html.setAttribute(k, attrs[k]); });
  }
  var style = document.createElement("style");
  style.id = "v360-display-cursor";
  style.textContent = D.cursorCss();
  (document.head || html).appendChild(style);
  apply();

  root.V360Display = {
    get: function () { return Object.assign({}, current); },
    defaults: function () { return Object.assign({}, defaults); },
    // Change one or more settings, save them and redraw.
    set: function (patch) {
      current = D.normalize(Object.assign({}, current, patch || {}), defaults);
      try { window.localStorage.setItem(D.KEY, JSON.stringify(current)); } catch (e) { /* private mode */ }
      apply();
      listeners.forEach(function (fn) { try { fn(Object.assign({}, current)); } catch (e) {} });
      return Object.assign({}, current);
    },
    onChange: function (fn) { listeners.push(fn); }
  };
  // Another tab changed them: follow along.
  window.addEventListener("storage", function (e) {
    if (e.key !== D.KEY) return;
    current = D.normalize(parse(e.newValue), defaults);
    apply();
    listeners.forEach(function (fn) { try { fn(Object.assign({}, current)); } catch (er) {} });
  });
})(typeof window !== "undefined" ? window : globalThis);
