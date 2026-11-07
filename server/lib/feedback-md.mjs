// Feedback as Markdown, for the admin page's "Copy as Markdown", the .md
// download and the MCP connector. One formatter so all three match.
export const TOOL_NAMES = { assistant: "Resource Assistant", assessment: "Vision Assessment", form: "Form" };
const MODE_NAMES = { spoken: "spoken", typed: "typed", spoken_edited: "spoken, then edited" };

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/(\d+)\/(\d+)\/(\d+),?/, "$3-$1-$2");
}

export function feedbackItemMarkdown(f) {
  const bits = [when(f.created_at), f.tool === "form" && f.flow_title ? f.flow_title : TOOL_NAMES[f.tool] || f.tool];
  if (f.mode) bits.push(MODE_NAMES[f.mode] || f.mode);
  if (f.rating) bits.push(`★ ${f.rating}/5`);
  const lines = [`## ${bits.join(" · ")}`, ""];
  if (f.text) lines.push(...String(f.text).split(/\r?\n/).map((l) => "> " + l));
  else lines.push("_(No written feedback, rating only.)_");
  lines.push("", `Conversation: ${f.session_id}${f.conversation_exists === false ? " (deleted)" : ""}`);
  return lines.join("\n");
}

export function feedbackMarkdown(items, { exportedAt = new Date(), filters = "" } = {}) {
  const head = `# Vision 360 feedback — ${items.length} item${items.length === 1 ? "" : "s"} (exported ${when(exportedAt.toISOString()).slice(0, 10)})`;
  return [head, filters ? `_Filters: ${filters}_` : null, "", ...items.map((f) => feedbackItemMarkdown(f) + "\n")].filter((x) => x !== null).join("\n").trimEnd() + "\n";
}
