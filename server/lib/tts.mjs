// Optional natural voice through ElevenLabs.
//
// ON when ELEVENLABS_API_KEY is set (server-side only — never sent to the
// browser) AND the admin has switched it on (Money › Estimated costs, kept in
// settings/site.json as voice.elevenlabs). The server only ever voices the assistant's own last reply for
// that session, so this can't be used to turn arbitrary text into speech.
// If it fails, the page falls back to the device's built-in voice.

export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // ElevenLabs premade voice "Rachel"
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";    // low-latency model

export function ttsKeySet(env) {
  return !!env.ELEVENLABS_API_KEY;
}

// switchOn: the admin's natural-voice switch.
export function ttsEnabled(env, switchOn) {
  return ttsKeySet(env) && !!switchOn;
}

export function ttsInfo(env, switchOn) {
  return ttsEnabled(env, switchOn)
    ? { provider: "elevenlabs", voiceId: env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID, model: env.ELEVENLABS_MODEL || DEFAULT_TTS_MODEL }
    : { provider: "browser" };
}

// ElevenLabs accepts speed 0.7–1.2.
function speedFor(rate) {
  const r = Number(rate) || 1;
  return Math.max(0.7, Math.min(1.2, r <= 1 ? r : 1 + (r - 1) * 0.5));
}

export async function synthesize(env, fetchImpl, { text, rate }) {
  const voice = env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: String(text).slice(0, 2500),
      model_id: env.ELEVENLABS_MODEL || DEFAULT_TTS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: speedFor(rate) },
    }),
    signal: AbortSignal.timeout(Number(env.V360_TTS_TIMEOUT_MS || 12000)),
  });
  if (!res.ok) {
    const e = new Error("ElevenLabs " + res.status);
    e.status = res.status;
    throw e;
  }
  return Buffer.from(await res.arrayBuffer());
}
