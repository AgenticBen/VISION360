// Contacting organizations for the person, after their suggestions.
//
//   offer  -> name (read back) -> contact (read back) -> which organizations
//          -> exact read-back of what will be sent -> clear yes -> queued
//
// Pure like dialogue.mjs: no storage, providers or HTTP. What the person agreed
// to is queued as one action per organization (session.work.enqueueAction),
// tied to the answer revision, so a later correction cancels anything not yet
// sent. Which organizations can be reached, and whether emails go to the real
// organization or the demo test inbox, comes in with each turn (input.outreach,
// built by outreach-directory.mjs).
import { createHash } from "node:crypto";
import { normalize, yesNo, strictConfirm, parseEmail, parsePhone, spellEmail, spellPhone, detectGlobal } from "./understand.mjs";
import { joinList } from "./phrasing.mjs";
import { buildOrgReferral, ORG_EMAIL_PURPOSE } from "./outreach-mail.mjs";

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 };
const STOP_RE = / (stop|cancel|don't|do not) (contacting|emailing|sending|contact|email|send) (them|the organizations|the organisations|those|anyone|the referrals|the emails) /;
const LEAVE_RE = / (cancel|never mind|nevermind|forget it|no thanks|no thank you|don't contact|do not contact) /;

// "My name is jane q. smith" -> "Jane Q Smith". Null when it doesn't look like a name.
export function cleanName(text) {
  let t = String(text || "").replace(/[.,!?;:"]/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^(yes|yeah|okay|ok|sure)\s+/i, "").replace(/^(my|her|his|their) (full )?name is\s+/i, "").replace(/^(the name is|it's|it is|i'm|i am|call me|use|please use|they're|she's|he's)\s+/i, "");
  t = t.replace(/[^A-Za-z' -]/g, "").replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  if (!words.length || words.length > 4 || !/[a-z]/i.test(t) || t.length > 60) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// "one and three", "1, 3", "the first and the fourth", "all of them".
export function parsePicks(text, max) {
  const n = normalize(text);
  if (/ (all|every|everyone|all of them|both|each) /.test(n)) return "all";
  const out = new Set();
  for (const m of n.matchAll(/ (\d{1,2})(?= )/g)) out.add(Number(m[1]));
  for (const [w, v] of Object.entries(NUMBER_WORDS)) if (n.includes(` ${w} `)) out.add(v);
  return [...out].filter((x) => x >= 1 && x <= max).sort((a, b) => a - b);
}

export function createOutreachDialogue(h) {
  // h: { reply, currentResults, staffQuestion, whoFor }

  function reachable(session, info) {
    const results = h.currentResults(session);
    if (!results || !info || !info.enabled) return [];
    return results.matches.filter((m) => info.orgs[m.id]);
  }

  // Offer once per set of suggestions, when at least one can be reached.
  function offerable(session, info) {
    const o = session.state.outreach;
    if (o && o.done && o.revision === session.revision) return false;
    return reachable(session, info).length > 0;
  }

  function offerText() {
    return "One more thing: I can contact some of these organizations for you and ask them to reach out to you. Would you like that?";
  }

  function leave(session, lead) {
    const st = session.state;
    st.phase = "results";
    st.wrapStep = "staff";
    st.outreach = { done: true, revision: session.revision, sent: (st.outreach && st.outreach.sent) || [] };
    return h.reply(session, [...lead, h.staffQuestion(session)], { expect: "results" });
  }

  function begin(session, info) {
    const st = session.state;
    st.phase = "outreach";
    st.outreach = { step: "name", revision: session.revision, sent: (st.outreach && st.outreach.sent) || [] };
    const w = h.whoFor(session);
    if (!w.self && w.name) {
      st.outreach.helper = st.names.caller || null;
      return h.reply(session, [`Great. They'll be contacting ${w.name}. What's ${w.name}'s full name? Or say that's fine to use ${w.name}.`], { expect: "name" });
    }
    const caller = st.names.caller;
    return h.reply(session, [caller ? `Great. What name should I give them? I can say ${caller}, or you can tell me your full name.` : "Great. What name should I give them? Your full name is best, but a first name is fine."], { expect: "name" });
  }

  function askContact(session) {
    const st = session.state;
    st.outreach.step = "contact";
    const known = st.email && st.email.address;
    if (known && !st.outreach.email) {
      return h.reply(session, [`How should they reach ${st.outreach.name}? Should they use ${known}? And what phone number can they call? Say no phone if you'd rather they only email. Since this is a demo, please use made-up details.`], { expect: "contact" });
    }
    return h.reply(session, [`What phone number and email should they use to reach ${st.outreach.name}? You can give one or both. Since this is a demo, please use made-up details.`], { expect: "contact" });
  }

  function contactReadBack(session) {
    const o = session.state.outreach;
    o.step = "contact_confirm";
    const bits = [];
    if (o.phone) bits.push(`by phone at ${o.phone}`);
    if (o.email) bits.push(`by email at ${o.email}`);
    const speechBits = [];
    if (o.phone) speechBits.push(`by phone at ${spellPhone(o.phone)}`);
    if (o.email) speechBits.push(`by email at ${spellEmail(o.email)}`);
    return h.reply(session, [`So they can reach ${o.name} ${joinList(bits)}. Is that right?`], { expect: "yes_no", speech: `So they can reach ${o.name} ${joinList(speechBits)}. Is that right?` });
  }

  function pickList(session, info) {
    const results = h.currentResults(session);
    return results.matches.map((m) => ({ rank: m.rank, id: m.id, name: m.name, channel: info.orgs[m.id] ? info.orgs[m.id].channel : null }));
  }

  function askPick(session, info) {
    const st = session.state;
    st.outreach.step = "pick";
    const list = pickList(session, info);
    const can = list.filter((x) => x.channel);
    const cannot = list.length - can.length;
    const named = can.map((x) => `number ${x.rank}, ${x.name}`);
    const parts = [`I can contact ${can.length === 1 ? "one of them" : can.length + " of them"} by email: ${joinList(named)}.`];
    if (cannot) parts.push(`${cannot === 1 ? "One other one" : cannot + " others"} I can't reach this way, so ${cannot === 1 ? "its phone number is" : "their phone numbers are"} on the screen and in your plan.`);
    parts.push(can.length === 1 ? "Shall I contact them?" : "Would you like me to contact all of them, or just some? Say all of them, or the numbers, like one and three.");
    return h.reply(session, parts, { expect: "outreach_pick", outreachPick: { orgs: list } });
  }

  // The exact emails that would be sent, rebuilt the same way at consent and at the yes.
  function buildTargets(session, info) {
    const o = session.state.outreach;
    const results = h.currentResults(session);
    const person = { name: o.name, helperName: o.helper || null, phone: o.phone || null, email: o.email || null, preferred: o.phone ? "phone" : "email" };
    const targets = o.picks.map((rank) => results.matches.find((m) => m.rank === rank)).filter((m) => m && info.orgs[m.id]).map((m) => {
      const intendedTo = info.orgs[m.id].email;
      const demo = !info.live;
      const mail = buildOrgReferral(m, person, { demo, intendedTo });
      return { orgId: m.id, orgName: m.name, channel: "email", intendedTo, to: demo ? info.testInbox : intendedTo, demoRedirect: demo, cc: !demo && person.email ? person.email : null, replyTo: info.replyTo || null, mail };
    });
    const hash = createHash("sha256").update(targets.map((t) => [t.orgId, t.to, t.mail.hash].join(":")).join("|")).digest("hex");
    return { targets, hash, results };
  }

  function consentText(session, info, targets) {
    const o = session.state.outreach;
    const how = [o.phone ? `by phone at ${o.phone}` : null, o.email ? `email at ${o.email}` : null].filter(Boolean).join(" or ");
    const parts = [
      `Here's exactly what I'll do. I'll email ${joinList(targets.map((t) => t.orgName))}:`,
      `"I'm contacting you on behalf of ${o.name}. Based on what they told us, they may be eligible for your services. Please reach out ${how}."`,
      "I won't share your answers about health, money or anything else personal.",
    ];
    if (!info.live) parts.push("Since this is a demo, these emails go to a test inbox, not the real organizations.");
    parts.push("Shall I go ahead?");
    return parts;
  }

  function askConsent(session, info) {
    const st = session.state;
    const { targets, hash } = buildTargets(session, info);
    if (!targets.length) return leave(session, ["I can't reach any of those by email, so I haven't contacted anyone."]);
    st.outreach.step = "consent";
    st.outreach.consent = { revision: session.revision, hash, live: !!info.live };
    return h.reply(session, consentText(session, info, targets), { expect: "consent", outreachConsent: { orgs: targets.map((t) => ({ id: t.orgId, name: t.orgName })), name: st.outreach.name, phone: st.outreach.phone || null, email: st.outreach.email || null, demo: !info.live } });
  }

  function handle(session, text, info) {
    const st = session.state;
    const o = st.outreach || {};
    const n = normalize(text);
    const yn = yesNo(text);
    if (!info || !info.enabled) return leave(session, ["Contacting organizations isn't available right now, so I haven't contacted anyone."]);
    if (LEAVE_RE.test(n) || detectGlobal(text).noEmail) return leave(session, ["Okay, I won't contact anyone."]);

    if (o.step === "name") {
      const w = h.whoFor(session);
      const fallback = !w.self && w.name ? w.name : st.names.caller;
      let name = null;
      if (fallback && (yn === "yes" || / (that's fine|thats fine|that's good|fine|that works|use that) /.test(n))) name = fallback;
      else name = cleanName(text);
      if (!name) return h.reply(session, ["Sorry, I didn't catch the name. What name should I give them?"], { expect: "name" });
      o.name = name;
      o.step = "name_confirm";
      return h.reply(session, [`I'll tell them the name is ${name}. Is that right?`], { expect: "yes_no" });
    }
    if (o.step === "name_confirm") {
      if (yn === "no") { o.step = "name"; return h.reply(session, ["Okay. What name should I give them?"], { expect: "name" }); }
      const other = yn !== "yes" ? cleanName(text) : null;
      if (other && other !== o.name && !strictConfirm(text)) { o.name = other; return h.reply(session, [`Okay, ${other}. Is that right?`], { expect: "yes_no" }); }
      if (!strictConfirm(text)) return h.reply(session, [`Is ${o.name} right? Say yes, or tell me the name to use.`], { expect: "yes_no" });
      return askContact(session);
    }
    if (o.step === "contact" || o.step === "contact_more") {
      const known = st.email && st.email.address;
      const email = parseEmail(text);
      const phone = parsePhone(text);
      if (email) o.email = email;
      if (phone) o.phone = phone;
      if (!email && known && !o.email && o.step === "contact" && (yn === "yes" || / (that one|that email|use that|same email|that address) /.test(n))) o.email = known;
      if (/ no (phone|number|calls) /.test(n)) o.noPhone = true;
      if (/ no (email|e mail) /.test(n)) o.noEmail = true;
      if (!o.phone && !o.email) {
        if (o.noPhone && o.noEmail) return leave(session, ["Without a phone number or email they can't reach you, so I haven't contacted anyone."]);
        return h.reply(session, ["Sorry, I didn't get that. What phone number or email should they use?"], { expect: "contact" });
      }
      if (o.step === "contact" && !o.phone && !o.noPhone) { o.step = "contact_more"; return h.reply(session, ["And what phone number can they call? Or say no phone."], { expect: "contact" }); }
      if (o.step === "contact" && !o.email && !o.noEmail) { o.step = "contact_more"; return h.reply(session, ["And is there an email they can use? Or say no email."], { expect: "contact" }); }
      return contactReadBack(session);
    }
    if (o.step === "contact_confirm") {
      if (yn === "no") { o.phone = null; o.email = null; o.noPhone = false; o.noEmail = false; return askContact(session); }
      // "Yes, but use 704 555 0100": anything new is read back again.
      const phone = parsePhone(text), email = parseEmail(text);
      if ((phone && phone !== o.phone) || (email && email !== o.email)) { if (phone) o.phone = phone; if (email) o.email = email; return contactReadBack(session); }
      if (!strictConfirm(text)) return h.reply(session, ["Are those details right? Say yes, or tell me what to change."], { expect: "yes_no" });
      return askPick(session, info);
    }
    if (o.step === "pick") {
      const list = pickList(session, info).filter((x) => x.channel);
      let picks = parsePicks(text, Math.max(...pickList(session, info).map((x) => x.rank)));
      if (picks === "all" || (list.length === 1 && yn === "yes")) picks = list.map((x) => x.rank);
      if (yn === "no" && (!picks.length)) return leave(session, ["Okay, I won't contact anyone."]);
      const ok = picks.filter((r) => list.some((x) => x.rank === r));
      const skipped = picks.filter((r) => !list.some((x) => x.rank === r));
      if (!ok.length) return h.reply(session, [skipped.length ? `I can't reach number ${joinList(skipped.map(String))} by email.` : "Sorry, which ones?", "Say all of them, or the numbers, like one and three."], { expect: "outreach_pick", outreachPick: { orgs: pickList(session, info) } });
      o.picks = ok;
      return askConsent(session, info);
    }
    if (o.step === "consent") {
      if (o.consentInterrupted) {
        o.consentInterrupted = false;
        const again = buildTargets(session, info);
        if (again.hash !== o.consent.hash) return leave(session, ["Something changed after I asked, so I haven't contacted anyone."]);
        return h.reply(session, ["Before I contact anyone, let me finish that question, since it was cut off.", ...consentText(session, info, again.targets)], { expect: "consent" });
      }
      if (!strictConfirm(text)) {
        if (yn === "no") return leave(session, ["Okay, I won't contact anyone."]);
        return h.reply(session, ["I just need a clear yes before I contact them. Shall I go ahead?"], { expect: "consent" });
      }
      if (o.consent.revision !== session.revision) return leave(session, ["Your answers changed after I asked, so I haven't contacted anyone."]);
      const { targets, hash, results } = buildTargets(session, info);
      if (hash !== o.consent.hash || !!info.live !== o.consent.live) return leave(session, ["Something changed after I asked, so I haven't contacted anyone."]);
      const sent = [];
      let firstId = null;
      for (const t of targets) {
        const res = session.work.enqueueAction(session, {
          type: "org_referral_email",
          destination: `org:${t.orgId}:${t.intendedTo}`,
          purpose: ORG_EMAIL_PURPOSE,
          recommendationId: results.recommendationId,
          method: "explicit_yes",
          payload: { to: t.to, intendedTo: t.intendedTo, demoRedirect: t.demoRedirect, cc: t.cc, replyTo: t.replyTo, orgId: t.orgId, orgName: t.orgName, channel: t.channel, subject: t.mail.subject, text: t.mail.text, html: t.mail.html, hash: t.mail.hash },
        });
        if (!firstId) firstId = res.action.id;
        if (!res.duplicate) sent.push({ actionId: res.action.id, orgId: t.orgId, orgName: t.orgName, channel: t.channel, demoRedirect: t.demoRedirect });
      }
      session.work.audit("caller", "outreach_authorized", { orgs: targets.map((t) => t.orgId), demo: !info.live });
      st.phase = "results";
      st.wrapStep = "staff";
      st.outreach = { done: true, revision: session.revision, sent: [...(o.sent || []), ...sent] };
      const lead = sent.length
        ? [`Done. I'm contacting ${sent.length === 1 ? sent[0].orgName : sent.length + " organizations"} now. You'll see each one's status on the screen. If any can't be reached, a Lions Services staff member will follow up.`, !info.live ? "Since this is a demo, the emails go to a test inbox." : ""]
        : ["I've already contacted them, so I haven't sent anything twice."];
      return h.reply(session, [...lead, h.staffQuestion(session)], { expect: "results", actionId: firstId });
    }
    return leave(session, []);
  }

  // "Stop contacting them" after the yes: cancels any email not yet sent.
  function stopRequest(session, text) {
    if (!STOP_RE.test(normalize(text))) return null;
    const o = session.state.outreach;
    if (!o || !o.sent || !o.sent.length) return null;
    const n = session.work.cancelActions(["org_referral_email"], "Stopped by the person");
    session.work.audit("caller", "outreach_stopped", { cancelled: n });
    return h.reply(session, [n ? `Okay, I've stopped. ${n === 1 ? "One email that hadn't gone out yet" : n + " emails that hadn't gone out yet"} won't be sent.` : "Those emails have already gone out, so there's nothing left to stop. A Lions Services staff member can let them know if you've changed your mind.", h.staffQuestion(session)], { expect: "results" });
  }

  function closeBit(session) {
    const o = session.state.outreach;
    if (!o || !o.sent || !o.sent.length) return null;
    const live = session.work.actionsForSession().filter((a) => a.type === "org_referral_email" && !["cancelled", "failed"].includes(a.status)).length;
    return live ? `I've asked ${live === 1 ? "one organization" : live + " organizations"} to contact you` : null;
  }

  function interrupted(session, turnId) {
    const st = session.state;
    if (st.phase === "outreach" && st.outreach && st.outreach.step === "consent" && st.lastAssistant && st.lastAssistant.turnId === turnId) {
      st.outreach.consentInterrupted = true;
      return true;
    }
    return false;
  }

  function snapshot(session) {
    const o = session.state.outreach;
    return o ? { step: o.step || null, sent: o.sent || [] } : null;
  }

  return { offerable, offerText, begin, handle, stopRequest, closeBit, interrupted, snapshot };
}
