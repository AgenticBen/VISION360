/* Connect Claude & ChatGPT: connector URL, setup steps and status. */
(function () {
  "use strict";
  var A = window.V360Admin, el = A.el;
  var url = location.origin + "/api/mcp";
  document.getElementById("mcp-url").textContent = url;
  document.getElementById("cc-cmd").textContent = "claude mcp add --transport http vision360 " + url;
  document.getElementById("copy-url").addEventListener("click", function (e) {
    var b = e.currentTarget;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); }).catch(function () { b.textContent = "Select and copy"; });
  });
  Promise.all([A.api("GET", "/api/admin/overview"), fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }).then(function (r) { return r.json(); }).catch(function () { return null; })])
    .then(function (r) {
      var o = r[0], tools = r[1] && r[1].result ? r[1].result.tools.length : 0, s = o.settings;
      var gh = s.storage.kind === "github";
      var rows = [
        ["MCP connector", tools ? ["ok", "Working — " + tools + " tools available"] : ["bad", "Not responding"]],
        ["Saving to GitHub", gh ? ["ok", "Connected to " + s.storage.repo + " — published workflows are commits on main"] : ["amber", "Not connected — edits are kept on this server only and disappear when it restarts. Add V360_GITHUB_TOKEN in Vercel."]],
        ["Drafts, requests and change log", s.storage.data === "supabase" ? ["ok", "Supabase"] : s.storage.data === "github" ? ["ok", "GitHub (admin-data branch)"] : ["amber", "This server only (resets on restart)"]],
        ["Editing", s.editsOn ? ["ok", "On (set V360_FLOW_EDITS=off in Vercel to stop all edits)"] : ["bad", "Off (V360_FLOW_EDITS=off)"]],
        ["Admin sign-in", o.signInRequired ? ["ok", "Required"] : ["amber", "Off — anyone with the link can open the admin and edit"]],
        ["Connector key", s.mcpKeyRequired ? ["ok", "Required (V360_MCP_KEY header)"] : ["amber", "Not required"]],
        ["Live version", ["", o.commit === "local" ? "local" : o.commit.slice(0, 7)]]
      ];
      var dl = document.getElementById("status"); dl.textContent = "";
      rows.forEach(function (x) { dl.appendChild(el("dt", { text: x[0] })); dl.appendChild(el("dd", null, [el("span", { class: "status-line" }, [el("span", { class: "dot " + x[1][0] }), x[1][1]])])); });
    });
})();
