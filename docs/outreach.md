# Contacting organizations for people

After their suggestions, the Resource Assistant can offer to contact the best-matched organizations for the person and ask them to reach out. It's off until an admin switches it on in **Admin › Outreach**, and it stays in **demo mode** until `V360_OUTREACH_LIVE=on`.

## What the person hears and agrees to

1. Offer: "I can contact some of these organizations for you…"
2. Name, read back. Phone and/or email, read back (spelled out by voice).
3. Which organizations: "all of them" or numbers, or checkboxes on screen. Organizations whose listing says to contact them directly are never contacted.
4. An exact read-back: which organizations, by email or online form, the message, the contact details, and that nothing about health, money or other personal matters is shared. A clear yes is required.
5. Each organization is a separate job tied to the answer revision. Changing an answer, or "stop contacting them", cancels anything not yet sent.

Organizations get the person's name and contact details only. The wording is "may be eligible based on what they told us", never "qualifies" (fitness check FC20).

## Email

- Address: the listing's email when it is one plain address, or the address staff choose in Admin › Outreach.
- Demo mode: every referral email goes to `V360_OUTREACH_TEST_INBOX` (or the first exact address in `V360_EMAIL_ALLOWLIST`), subject starting `[DEMO]`, saying which organization it was meant for.
- Live: sent to the organization, the person copied, replies to `V360_OUTREACH_REPLY_TO`.

## Online forms

For organizations with an online referral form, staff build a **form recipe** (Admin › Outreach › Online forms): which field gets which detail (only name, phone, email, preferred contact, referrer and fixed referral wording), the submit button, and how to tell it worked.

1. **Inspect** opens the form in a safe browser and lists its fields (nothing typed). This also records the page's fingerprint; if the page later changes, the recipe needs approving again.
2. Choose sources (or **Draft with AI**, which sees only field labels), **Save**.
3. **Approve for testing** (type APPROVE).
4. **Dry run** fills it with made-up details without sending, and shows a picture.
5. **Approve for real**.

A form job:

- fills the form in a fresh **Vercel Sandbox** VM (headless Chromium, `runner/fill-form.mjs`), which may only reach the form's own web addresses;
- **stops at any CAPTCHA, bot check, 403/429, or changed page** (`runner/detect.mjs`). It never tries to get around them;
- then emails the organization instead (a backup email prepared at consent), or, with no email, gives staff a task with the answers ready to type in;
- in demo mode always fills the practice form at `/outreach-test-form/` (add `?challenge=1` to see the bot-check fallback), never the real one.

Form jobs run in their own function (`api/outreach.mjs`, up to 120 s), triggered by the person's page while it waits, by **Run now** in the admin, or by the next visit. The conversation function never runs them.

## Switching the browser on (not done yet)

The site has no dependencies today. To let form jobs run:

1. Add `"@vercel/sandbox"` to `dependencies` in `package.json`, and `node_modules/@vercel/sandbox/**` to `includeFiles` for `api/outreach.mjs` in `vercel.json`.
2. Build the snapshot once: `npm i --no-save @vercel/sandbox`, then `node scripts/form-runner-image.mjs` with `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`.
3. Set `V360_FORM_RUNNER_SNAPSHOT` in Vercel to the printed id, and redeploy.
4. Check that `networkPolicy` (allowed domains) is honoured by the SDK version installed; it limits where a person's details can go.

Vercel Sandbox is billed for active CPU and memory; one form run is roughly a minute on one vCPU.

Without these steps every form job falls back to email or a staff task, and Inspect / Dry run say the browser isn't set up.

## Before going live (`V360_OUTREACH_LIVE=on`)

Privacy and HIPAA review, data-sharing approval from Lions Services, agreement on which organizations may receive referrals (especially the 29 whose listing is "unclear"), and Resend set up with a verified domain.
