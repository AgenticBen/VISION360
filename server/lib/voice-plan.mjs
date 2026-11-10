// What the natural voice (ElevenLabs) costs on the plan Lions Services pays
// for, per conversation and per month. ElevenLabs bills in credits, not
// dollars: the plan buys a fixed number of credits a month, and each spoken
// character uses some credits.
//
// Defaults are Ben's Starter plan as of November 2026: $6 a month for 40,000
// credits, renewing on the 3rd. The rate (0.2 credits per character, so one
// credit is about 5 characters) was measured from the ElevenLabs dashboard
// for Nov 3-10, 2026: 65,200 characters used 13,035 credits. Each can be
// changed without code in Vercel:
//   V360_TTS_PLAN_NAME, V360_TTS_PLAN_USD, V360_TTS_PLAN_CREDITS,
//   V360_TTS_CREDITS_PER_CHAR, V360_TTS_PLAN_RENEWS_DAY
export const PLAN_DEFAULTS = Object.freeze({ name: "Starter", usd: 6, credits: 40000, creditsPerChar: 0.2, renewsDay: 3 });
// That week had 49 sessions on the site (44 conversations and 5 screen
// checks), so about 1,330 characters each, counting fixed lines and testing.
export const MEASURED = Object.freeze({ from: "2026-11-03", to: "2026-11-10", chars: 65200, credits: 13035, requests: 389, sessions: 49 });

function num(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// usage: { conversations, ttsChars } for the same period (last 30 days).
export function voicePlan(env = {}, usage = {}) {
  const plan = {
    name: String(env.V360_TTS_PLAN_NAME || PLAN_DEFAULTS.name).slice(0, 40),
    usd: num(env.V360_TTS_PLAN_USD, PLAN_DEFAULTS.usd),
    credits: Math.round(num(env.V360_TTS_PLAN_CREDITS, PLAN_DEFAULTS.credits)),
    creditsPerChar: num(env.V360_TTS_CREDITS_PER_CHAR, PLAN_DEFAULTS.creditsPerChar),
    renewsDay: Math.min(28, Math.round(num(env.V360_TTS_PLAN_RENEWS_DAY, PLAN_DEFAULTS.renewsDay))),
  };
  const usdPerCredit = plan.usd / plan.credits;
  const per1kUsd = +(1000 * plan.creditsPerChar * usdPerCredit).toFixed(4);
  const conversations = Number(usage.conversations) || 0;
  const chars = Number(usage.ttsChars) || 0;
  // This site's own numbers once it has some; until then, the measured week.
  const own = conversations > 0 && chars > 0;
  const charsPerConversation = own ? Math.round(chars / conversations) : Math.round(MEASURED.chars / MEASURED.sessions);
  const creditsPerConversation = charsPerConversation == null ? null : Math.max(1, Math.round(charsPerConversation * plan.creditsPerChar));
  return {
    plan, measured: MEASURED,
    usdPerCredit: +usdPerCredit.toFixed(6),
    per1kUsd,
    period: { conversations, chars, credits: Math.round(chars * plan.creditsPerChar) },
    charsPerConversation,
    perConversationSource: own ? "site" : "measured",
    creditsPerConversation,
    usdPerConversation: creditsPerConversation == null ? null : +(creditsPerConversation * usdPerCredit).toFixed(4),
    conversationsPerPlan: creditsPerConversation ? Math.floor(plan.credits / creditsPerConversation) : null,
  };
}
