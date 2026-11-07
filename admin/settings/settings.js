/* Connect Claude & ChatGPT: connector URL, setup steps and status. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var url = location.origin + "/api/mcp";
  document.getElementById("mcp-url").textContent = url;
  document.getElementById("cc-cmd").textContent = "claude mcp add --transport http vision360 " + url + " --header \"x-v360-key: YOUR-KEY\"";
  document.getElementById("copy-url").addEventListener("click", function (e) {
    var b = e.currentTarget;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); }).catch(function () { b.textContent = "Select and copy"; });
  });
  // Admin password.
  var $ = function (id) { return document.getElementById(id); };
  $("pw-show").addEventListener("change", function () { ["pw-current", "pw-new", "pw-confirm"].forEach(function (id) { $(id).type = $("pw-show").checked ? "text" : "password"; }); });
  $("pw-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = $("pw-msg");
    msg.className = "hint"; msg.textContent = "";
    if ($("pw-new").value.length < 8) { msg.className = "danger-text"; msg.textContent = "⚠ The new password needs at least 8 characters."; return; }
    if ($("pw-new").value !== $("pw-confirm").value) { msg.className = "danger-text"; msg.textContent = "⚠ The two new passwords don't match."; return; }
    $("pw-save").disabled = true;
    A.api("POST", "/api/admin/password", { current: $("pw-current").value, password: $("pw-new").value, confirm: $("pw-confirm").value })
      .then(function () { $("pw-form").reset(); msg.className = "ok-text"; msg.textContent = "✓ Password changed. Everyone else has been signed out."; })
      .catch(function (err) { msg.className = "danger-text"; msg.textContent = "⚠ " + err.message; })
      .finally(function () { $("pw-save").disabled = false; });
  });

  Promise.all([A.api("GET", "/api/admin/overview"), fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then(function (r) { return r.json(); }).catch(function () { return null; })])
    .then(function (r) {
      var o = r[0], tools = r[1] && r[1].result ? r[1].result.tools.length : 0, s = o.settings;
      var gh = s.storage.kind === "github";
      var rows = [
        ["MCP connector", tools ? ["ok", "Working — " + tools + " tools available"] : ["bad", "Not responding"]],
        ["Saving to GitHub", gh ? ["ok", "Connected to " + s.storage.repo + " — each publish is a pull request that merges itself once the checks pass"] : ["amber", "Not connected — publishing is off. Add V360_GITHUB_TOKEN in Vercel (after V360_MCP_KEY)."]],
        ["Publishing", s.publishing === "on" ? ["ok", "On"] : s.publishing === "local" ? ["amber", "This machine only"] : ["amber", "Off — " + (s.publishingNote || "")]],
        ["Conversations", s.storage.sessions === "supabase" ? ["ok", "Supabase (" + (o.retentionDays ? "kept for " + o.retentionDays + " days; open follow-ups are kept until closed" : "kept until an admin deletes them") + ")"] : ["amber", "This server only (resets on restart). Add V360_SUPABASE_URL and V360_SUPABASE_SERVICE_KEY in Vercel."]],
        ["Drafts, requests and change log", s.storage.data === "supabase" ? ["ok", "Supabase"] : s.storage.data === "github" ? ["ok", "GitHub (admin-data branch)"] : ["amber", "This server only (resets on restart)"]],
        ["Editing", s.editsOn ? ["ok", "On (set V360_FLOW_EDITS=off in Vercel to stop all edits)"] : ["bad", "Off (V360_FLOW_EDITS=off)"]],
        ["Admin sign-in", o.signInRequired ? ["ok", "Password required"] : ["amber", "Off on this computer (V360_ADMIN_SIGNIN=off)"]],
        ["Connector and publish key", s.mcpKeyRequired ? ["ok", "Required (x-v360-key header for Claude; the editor asks once when you publish)"] : ["amber", "Not set — needed before GitHub is connected"]],
        ["Live version", ["", o.commit === "local" ? "local" : o.commit.slice(0, 7)]]
      ];
      var dl = document.getElementById("status"); dl.textContent = "";
      rows.forEach(function (x) { dl.appendChild(el("dt", { text: x[0] })); dl.appendChild(el("dd", null, [el("span", { class: "status-line" }, [el("span", { class: "dot " + x[1][0] }), x[1][1]])])); });
    });
})();
