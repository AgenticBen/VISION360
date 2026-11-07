/* Admin sign-in. On a brand-new local install with no password yet, the same
   form sets the first password (the hosted site never offers this). */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var next = params.get("next") || "/admin/";
  if (!/^\/admin(\/|$)/.test(next) || /^\/admin\/login/.test(next)) next = "/admin/";
  var setup = false;

  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "Sign-in failed."); return j; }); });
  }
  function fail(msg) { $("err").textContent = "⚠ " + msg; $("err").hidden = false; $("go").disabled = false; $("pw").focus(); }

  fetch("/api/admin/me", { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.json(); }).then(function (me) {
    if (me.signedIn) { location.replace(next); return; }
    if (me.canSetUp) {
      setup = true;
      $("gate-sub").textContent = "No admin password is set on this computer yet. Choose one (at least 8 characters).";
      $("confirm-row").hidden = false;
      $("pw").setAttribute("autocomplete", "new-password");
      $("go").textContent = "Set password and sign in";
    } else if (me.setupNeeded) {
      $("gate-sub").textContent = "No admin password is set up on this site yet. Ask the site owner to set one.";
      $("go").disabled = true;
    }
  }).catch(function () {});

  $("show").addEventListener("click", function () {
    var on = $("pw").type === "password";
    $("pw").type = on ? "text" : "password";
    $("pw2").type = $("pw").type;
    this.textContent = on ? "Hide" : "Show";
    this.setAttribute("aria-pressed", String(on));
  });

  $("signin").addEventListener("submit", function (e) {
    e.preventDefault();
    $("err").hidden = true;
    var pw = $("pw").value;
    if (!pw) return fail("Enter the password.");
    if (setup && pw !== $("pw2").value) return fail("The two passwords don't match.");
    $("go").disabled = true;
    post(setup ? "/api/admin/setup" : "/api/admin/login", { password: pw })
      .then(function () { location.replace(next); })
      .catch(function (err) { fail(err.message); });
  });
})();
