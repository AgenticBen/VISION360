// Spots pages that are asking "are you a person?" (CAPTCHAs, bot checks) or
// refusing automated visitors. The form runner STOPS when it sees any of
// these: it never tries to solve or get around them; the organization is
// emailed instead, or a staff member takes over.
//
// Pure (no browser), so it can be tested with plain HTML.
const SIGNS = [
  [/g-recaptcha|recaptcha\/api|grecaptcha|recaptcha\.net/i, "reCAPTCHA"],
  [/h-captcha|hcaptcha\.com/i, "hCaptcha"],
  [/cf-turnstile|challenges\.cloudflare\.com|turnstile\/v0/i, "Cloudflare Turnstile"],
  [/cf-chl-|cf_chl_|<title>\s*just a moment\.\.\.\s*<\/title>|attention required! \| cloudflare/i, "Cloudflare challenge"],
  [/verify (that )?you are (a )?human|are you a robot|i'?m not a robot|prove you'?re (a )?human|bot (check|detection)/i, "a human check"],
  [/arkoselabs|funcaptcha|perimeterx|px-captcha|datadome/i, "a bot-protection service"],
];

export function detectBlocker({ html = "", status = 200 } = {}) {
  if (status === 403) return "the site refused the visit (403)";
  if (status === 429) return "the site said too many requests (429)";
  if (status >= 500) return `the site had an error (${status})`;
  for (const [re, what] of SIGNS) if (re.test(html)) return `the page uses ${what}`;
  return null;
}

// A stable fingerprint of a form's fields, so a changed page is noticed
// before anything is typed into it.
export function fieldsKey(fields) {
  return fields.map((f) => `${f.selector}|${f.kind}`).sort().join("\n");
}
