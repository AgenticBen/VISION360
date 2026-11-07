/* Vision 360 CONNECT demo — browser side.
 *
 * The browser is a thin client. All intake, confirmation, matching and action
 * rules run on the server (/api). Voice and typing call the same endpoint, so
 * switching modes keeps the same session and the same confirmed answers.
 *
 * Voice uses the browser's own speech services (Web Speech API):
 *   - SpeechRecognition turns speech into text. Interim words are shown as
 *     "still listening" and are never sent; only a final transcript is sent,
 *     and the server only ever PROPOSES answers from it.
 *   - speechSynthesis reads the assistant's turn aloud. The spoken text and the
 *     displayed text come from the same server turn.
 * No API keys live in this file.
 */
(function () {
  "use strict";

  var SETTINGS_KEY = "v360-demo-settings";
  var DEFAULTS = { textSize: "150", theme: "high", readAloud: true, rate: "1", bargeIn: false, announce: true, voiceName: "", endSilence: "2000" };
  var RATES = ["0.7", "0.85", "1", "1.2", "1.4"];
  var SILENCES = ["1200", "2000", "3200"];

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  };

  // --------------------------------------------------------------- settings
  var settings = loadSettings();
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch (e) {}
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = s[k] !== undefined ? s[k] : DEFAULTS[k]; });
    if (RATES.indexOf(String(out.rate)) === -1) out.rate = Number(out.rate) < 0.8 ? "0.7" : Number(out.rate) < 1 ? "0.85" : "1";
    if (SILENCES.indexOf(String(out.endSilence)) === -1) out.endSilence = DEFAULTS.endSilence;
    // Text size and colors are shared with every page (display-settings.js).
    if (window.V360Display) { var d = window.V360Display.get(); out.textSize = d.textSize; out.theme = d.theme; }
    return out;
  }
  function saveSettings() {
    // Voice, speed and the like stay on this page's own key; text size and
    // colors go to the shared settings, which redraw the page.
    var own = {};
    Object.keys(settings).forEach(function (k) { if (k !== "textSize" && k !== "theme") own[k] = settings[k]; });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(own)); } catch (e) {}
    if (window.V360Display) {
      var d = window.V360Display.get();
      if (d.textSize !== settings.textSize || d.theme !== settings.theme) window.V360Display.set({ textSize: settings.textSize, theme: settings.theme });
    } else {
      document.documentElement.setAttribute("data-textsize", settings.textSize);
      document.documentElement.setAttribute("data-theme", settings.theme);
    }
    syncBar();
  }
  // Changed on another page or tab: follow along.
  if (window.V360Display) window.V360Display.onChange(function (d) { settings.textSize = d.textSize; settings.theme = d.theme; syncBar(); });

  // Display settings bar: always on screen under the heading, collapsible.
  var BAR_KEY = "v360-demo-bar";
  var THEME_NAMES = { standard: "Standard colors", dark: "Dark", high: "High contrast" };
  function syncBar() {
    [].forEach.call(document.querySelectorAll("#display-bar [data-set]"), function (b) {
      b.setAttribute("aria-pressed", String(String(settings[b.getAttribute("data-set")]) === b.getAttribute("data-value")));
    });
    var sum = $("dbar-summary");
    if (sum) sum.textContent = "Text " + settings.textSize + "% · " + (THEME_NAMES[settings.theme] || "") + " · Read aloud " + (settings.readAloud ? "on" : "off");
  }
  function setBarOpen(open, save) {
    $("dbar-toggle").setAttribute("aria-expanded", String(open));
    $("dbar-body").hidden = !open;
    $("dbar-action").textContent = open ? "Hide" : "Show";
    $("display-bar").classList.toggle("is-collapsed", !open);
    if (save) { try { localStorage.setItem(BAR_KEY, open ? "open" : "closed"); } catch (e) {} }
  }
  (function () {
    var saved = null;
    try { saved = localStorage.getItem(BAR_KEY); } catch (e) {}
    setBarOpen(saved !== "closed", false);
  })();
  $("dbar-toggle").addEventListener("click", function () { setBarOpen($("dbar-toggle").getAttribute("aria-expanded") !== "true", true); });
  $("display-bar").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-set]") : null;
    if (!b) return;
    var key = b.getAttribute("data-set"), v = b.getAttribute("data-value");
    settings[key] = key === "readAloud" ? v === "true" : v;
    saveSettings();
    if (key === "readAloud" && !settings.readAloud) stopSpeaking("settings");
    announce(b.closest(".dbar-group").querySelector(".dbar-label").textContent + ": " + b.textContent, true);
  });
  saveSettings();

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var canSpeak = "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
  var canListen = !!SR;

  // Natural voice (ElevenLabs) is generated on the server, only for the
  // assistant's own replies; the key never reaches the browser.
  var NATURAL = "__natural";
  var natural = { available: false, audio: null, url: null };
  function useNatural() { return natural.available && (settings.voiceName === NATURAL || !settings.voiceName); }

  // ----------------------------------------------------------- voices
  // Browsers expose the voices installed on the device. Quality varies hugely:
  // macOS ships novelty voices ("Albert", "Bad News", "Zarvox"…) next to very
  // natural "Premium"/"Enhanced" ones, and Chrome adds Google network voices.
  // Rank them so the most natural English voice is chosen by default.
  var NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ|fred|junior|ralph|kathy|grandma|grandpa|rocko|shelley|flo|eddy|reed|sandy)\b/i;
  var GOOD_NAMES = /(ava|zoe|samantha|allison|evan|nathan|joelle|noelle|serena|susan|tom|nicky|aaron|daniel|karen|moira|tessa|jenny|aria|guy|emma|brian)/i;
  function voiceScore(v) {
    var n = v.name || "", sc = 0;
    if (!/^en/i.test(v.lang || "")) return -100;
    if (NOVELTY.test(n)) return -50;
    if (/premium/i.test(n)) sc += 40;
    if (/enhanced/i.test(n)) sc += 30;
    if (/natural|neural|online/i.test(n)) sc += 30;
    if (/^google/i.test(n)) sc += 25;
    if (GOOD_NAMES.test(n)) sc += 10;
    if (/^en[-_]US/i.test(v.lang || "")) sc += 5;
    if (v.default) sc += 2;
    return sc;
  }
  function rankedVoices() {
    if (!canSpeak) return [];
    return window.speechSynthesis.getVoices().filter(function (v) { return voiceScore(v) > -50; })
      .sort(function (a, b) { return voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name); });
  }
  function currentVoice() {
    var list = rankedVoices();
    if (!list.length) return null;
    for (var i = 0; i < list.length; i++) if (list[i].name === settings.voiceName) return list[i];
    return list[0];
  }
  function fillVoiceSelect() {
    var sel = $("voice-select");
    if (!sel) return;
    var list = rankedVoices();
    sel.textContent = "";
    if (natural.available) sel.appendChild(el("option", { value: NATURAL, text: "Natural voice (ElevenLabs) — recommended" }));
    if (!list.length && natural.available) { sel.value = useNatural() ? NATURAL : ""; return; }
    if (!list.length) { sel.appendChild(el("option", { value: "", text: "Default voice" })); $("voice-hint").textContent = "No voices are listed yet. Try again in a moment."; return; }
    var cur = currentVoice();
    list.forEach(function (v, i) {
      var label = v.name + " (" + v.lang + ")" + (i === 0 && !natural.available ? " — recommended" : "");
      sel.appendChild(el("option", { value: v.name, text: label }));
    });
    sel.value = useNatural() ? NATURAL : (cur ? cur.name : "");
    var hint = "The most natural voices on this device are listed first.";
    if (!list.some(function (v) { return /premium|enhanced|natural|neural|google/i.test(v.name); })) {
      hint += " On a Mac you can add much better voices: System Settings → Accessibility → Spoken Content → System voice → Manage Voices, then download an English \u201cPremium\u201d or \u201cEnhanced\u201d voice (for example Ava or Zoe) and reload this page.";
    }
    $("voice-hint").textContent = hint;
  }
  if (canSpeak) {
    try { window.speechSynthesis.onvoiceschanged = fillVoiceSelect; } catch (e) {}
    setTimeout(fillVoiceSelect, 300);
  }

  var dlg = $("settings");
  var settingsReturnFocus = null;
  function openSettings() {
    var f = dlg.querySelector("form");
    f.readAloud.checked = !!settings.readAloud;
    f.rate.value = settings.rate;
    f.endSilence.value = settings.endSilence;
    fillVoiceSelect();
    f.bargeIn.checked = !!settings.bargeIn;
    f.announce.checked = !!settings.announce;
    $("speed-row").hidden = !canSpeak;
    $("speed-unsupported").hidden = canSpeak;
    f.readAloud.disabled = !canSpeak;
    settingsReturnFocus = document.activeElement;
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    var first = f.querySelector("input:not([disabled]), select");
    if (first) first.focus();
  }
  dlg.addEventListener("change", function (e) {
    var t = e.target;
    if (!t.name) return;
    settings[t.name] = t.type === "checkbox" ? t.checked : t.value;
    saveSettings();
    if (t.name === "readAloud" && !t.checked) stopSpeaking("settings");
  });
  dlg.addEventListener("close", function () {
    if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
  });
  $("open-settings").addEventListener("click", openSettings);
  $("voice-sample").addEventListener("click", function () {
    if (useNatural()) {
      stopNaturalAudio();
      var a = new Audio("/api/tts-sample?rate=" + encodeURIComponent(settings.rate));
      natural.audio = a;
      a.play().catch(function () { alertNow("The natural voice couldn't play right now."); });
      return;
    }
    if (!canSpeak) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    var u = new SpeechSynthesisUtterance("Hi, I'm the Vision 360 assistant. Tell me a little about what's going on, and I'll help you find the right services.");
    var v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-US";
    u.rate = Number(settings.rate) || 1;
    window.speechSynthesis.speak(u);
  });

  // ------------------------------------------------------------- app state
  var app = {
    sessionId: null, token: null, revision: 0, mode: "text", state: null,
    busy: false, queue: [], ended: false, lastTurn: null, seenActions: {},
  };

  // Which workflow this page runs: /f/<id> (a shared link or QR code), ?flow=<id>,
  // or the main workflow the admin picked for the home page.
  var ON_ASSESSMENT = /^\/assessment\/?$/.test(location.pathname);
  var FLOW = (ON_ASSESSMENT ? "vision-assessment" : null) || (location.pathname.match(/^\/f\/([a-z0-9-]{1,40})\/?$/) || [])[1] || new URLSearchParams(location.search).get("flow") || null;
  app.flow = { id: FLOW, routing: true };
  // The question on the start screen, which the assistant also asks out loud.
  var PH = window.V360_PHRASES;
  var ASK = ON_ASSESSMENT ? PH.ASKS.assessment : PH.ASKS.demo;
  function setAsk(q, sub) { ASK = { q: q, sub: sub }; $("start-h").textContent = q; $("start-sub").textContent = sub; }
  setAsk(ASK.q, ASK.sub);
  if (ON_ASSESSMENT) { document.title = "Vision Assessment — Vision 360"; $("page-h").textContent = "Vision Assessment"; }
  fetch("/api/assistant" + (FLOW ? "?flow=" + encodeURIComponent(FLOW) : ""), { cache: "no-store" }).then(function (r) {
    if (r.status === 404) throw new Error("gone");
    return r.json();
  }).then(function (j) {
    app.flow = j.flow;
    if (!j.flow.routing && !ON_ASSESSMENT) {
      document.title = j.flow.title + " — Vision 360 CONNECT";
      $("page-h").textContent = j.flow.title;
      setAsk("Would you like to fill in the " + j.flow.title + " together?", "I'll ask one question at a time and read your answers back. You can tell me whenever you're ready!");
    }
  }).catch(function (e) {
    if (e.message !== "gone") return;
    $("start-h").textContent = "This form isn't available";
    var box = $("start-sub");
    box.textContent = "";
    box.appendChild(el("span", null, ["This link doesn't lead to a form that's open right now. ", el("a", { href: "/demo", text: "Go to the Vision 360 CONNECT assistant" }), "."]));
    $("start-voice").disabled = true; $("start-text").disabled = true;
  });

  // Tell people plainly when this deployment can't keep data or send email.
  fetch("/api/health").then(function (r) { return r.json(); }).then(function (h) {
    if (h.tts && h.tts.provider === "elevenlabs") { natural.available = true; fillVoiceSelect(); }
    var notes = [];
    if (h.storage === "ephemeral") notes.push("This preview has no permanent database yet, so a conversation can be lost if the server restarts.");
    if (h.emailTransport === "outbox") notes.push("Email isn't connected yet: an emailed plan goes to a test outbox and is not actually sent.");
    if (h.aiUnderstanding && h.aiUnderstanding.on) notes.push("AI understanding is on: when the assistant can't follow an answer, your words are sent to an AI model (through Vercel AI Gateway) to work out which choice you meant. You still confirm everything before anything is suggested.");
    // Setup notes (email not connected, etc.) live in the guide's privacy
    // section; this page stays to the question and the two buttons.
    void notes;
  }).catch(function () {
    var n = $("env-notice"); n.hidden = false; n.textContent = "The server isn't reachable right now. Please try again in a moment.";
  });

  if (!canListen) {
    var vs = $("voice-support");
    vs.hidden = false;
    vs.textContent = "Talking isn't available in this browser. Type works here. Talking works in recent Chrome, Edge and Safari.";
    $("start-voice").querySelector(".big-sub").textContent = "Talking isn't available in this browser.";
  }

  // ---------------------------------------------------------------- status
  var STATUS_TEXT = {
    connecting: "Connecting…", listening: "Listening — take your time; I'll answer when you pause", thinking: "Thinking…",
    speaking: "Speaking — press Stop speaking to interrupt", paused: "Microphone muted", ready: "Ready — type your message",
    disconnected: "Voice disconnected", error: "Problem", ended: "Session ended", waiting: "Waiting for you",
  };
  var lastAnnouncedStatus = null;
  function setStatus(state, text) {
    var p = $("status");
    p.setAttribute("data-state", state);
    $("status-text").textContent = text || STATUS_TEXT[state] || state;
    // Only announce changes that matter, not every listening/thinking flicker.
    if (["disconnected", "error", "paused", "ended"].indexOf(state) !== -1 && lastAnnouncedStatus !== state) announce($("status-text").textContent, true);
    lastAnnouncedStatus = state;
  }

  function announce(text, force) {
    if (!force && !settings.announce) return;
    var a = $("announcer");
    a.textContent = "";
    setTimeout(function () { a.textContent = text; }, 60);
  }
  function alertNow(text) {
    var a = $("alerter");
    a.textContent = "";
    setTimeout(function () { a.textContent = text; }, 60);
  }

  // ------------------------------------------------------------------ log
  var log = $("log");
  // Follow new messages only while the person is at the bottom of the log.
  var following = true;
  function atBottom() { return following; }
  function scrollIfFollowing(wasAtBottom) {
    if (wasAtBottom) { log.scrollTop = log.scrollHeight; $("new-msg").hidden = true; }
    else $("new-msg").hidden = false;
  }
  log.addEventListener("scroll", function () {
    following = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (following) $("new-msg").hidden = true;
  });
  $("new-msg").addEventListener("click", function () { log.scrollTop = log.scrollHeight; $("new-msg").hidden = true; log.focus(); });

  function addMessage(who, text, opts) {
    opts = opts || {};
    var follow = atBottom();
    var li = el("li", { class: "msg " + (who === "you" ? "you" : "bot") + (opts.pending ? " pending" : "") });
    li.appendChild(el("span", { class: "who", text: who === "you" ? (opts.voice ? "You (spoken)" : "You") : "Vision 360 assistant" }));
    var p = el("p", { text: text });
    li.appendChild(p);
    if (opts.turnId) li.setAttribute("data-turn", opts.turnId);
    log.appendChild(li);
    scrollIfFollowing(follow);
    return li;
  }

  function markInterrupted(turnId) {
    var li = log.querySelector('[data-turn="' + turnId + '"]');
    if (li && !li.querySelector(".tag")) li.appendChild(el("span", { class: "tag", text: "Speech stopped early — not all of this was read aloud" }));
  }

  // ------------------------------------------------------------------- API
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function api(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    if (app.token) headers.Authorization = "Bearer " + app.token;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || ("Server error " + r.status)); e.status = r.status; e.code = j.code || null; throw e; }
          return j;
        });
      });
  }

  // ------------------------------------------------ welcome and display
  // Spoken before anything else: is the display comfortable, then the
  // page's question. Display commands ("bigger text", "less contrast") work
  // here and at any point in the conversation, without leaving this device.
  var SIZES = PH.SIZES;
  function welcomeText() { return PH.welcome(ASK, settings.textSize, settings.theme); }
  var localN = 0;
  function localTurn(text, showCard) {
    addMessage("bot", text);
    announce(text);
    if (showCard) { var panel = $("panel"); panel.textContent = ""; panel.appendChild(welcomeCard()); }
    if (settings.readAloud && (canSpeak || natural.available)) speak(text, "local-" + (++localN));
    else afterAssistant();
  }
  function welcomeTurn() {
    // Heard it on the start screen already: don't repeat it all.
    var text = pre.heard ? PH.listening : welcomeText();
    localTurn(text, true);
  }
  function welcomeCard() {
    var card = el("section", { class: "card", "aria-labelledby": "wh" });
    card.appendChild(el("h3", { id: "wh", text: ASK.q }));
    var row = el("div", { class: "action-row" });
    row.appendChild(el("button", { type: "button", class: "btn btn-primary", text: "Yes, let's start", onclick: function () { addMessage("you", "Yes"); proceed(); } }));
    row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: "Bigger text", onclick: function () { handleLocal("bigger text", { text: "Bigger text" }); } }));
    row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: "Smaller text", onclick: function () { handleLocal("smaller text", { text: "Smaller text" }); } }));
    row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: settings.theme === "high" ? "Less contrast" : "High contrast", onclick: function () { var t = settings.theme === "high" ? "less contrast" : "high contrast"; handleLocal(t, { text: t.charAt(0).toUpperCase() + t.slice(1) }); } }));
    card.appendChild(row);
    return card;
  }
  function proceed() {
    if (!app.welcome) return;
    app.welcome = false;
    stopSpeaking("proceed", true);
    hideBarForConversation();
    var h = app.held; app.held = null;
    if (h) applyTurn(h.turn, h.state);
  }
  function norm(t) { return String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim(); }
  // Returns { set: {key: value}, say } or null.
  function displayCommand(raw, loose) {
    var t = norm(raw);
    if (!t || t.split(" ").length > 12) return null;
    var aboutDisplay = /\b(text|font|print|letters|words|writing|screen|size|zoom|contrast|colou?rs?|dark mode|light mode|bright|brightness)\b/.test(t);
    if (!loose && !aboutDisplay) return null;
    var i = SIZES.indexOf(String(settings.textSize));
    // Contrast goes in steps, so "less contrast" or "more contrast" can be
    // said again and again: standard, dark, high.
    if (/\b(high|full|maximum|max|highest) contrast\b|yellow on black/.test(t) && !/\b(less|lower|reduce|not)\b/.test(t)) {
      return settings.theme === "high" ? { say: PH.say.highAlready } : { set: { theme: "high" }, say: PH.say.toHigh };
    }
    if (/\b(more|higher|increase|raise|turn up|stronger)( the)? contrast\b|\bcontrast (up|higher)\b/.test(t)) {
      if (settings.theme === "high") return { say: PH.say.highAlready };
      if (settings.theme === "dark") return { set: { theme: "high" }, say: PH.say.toHigh };
      return { set: { theme: "dark" }, say: PH.say.moreToDark };
    }
    if (/dark (mode|colou?rs?|theme|background)/.test(t)) {
      return settings.theme === "dark" ? { say: PH.say.darkAlready } : { set: { theme: "dark" }, say: PH.say.toDark };
    }
    if (/\b(less|lower|reduce|softer|decrease|turn down|too much|not so much|no)( the)? contrast\b|\bcontrast (down|lower)\b|\bless bright\b|\btoo (bright|harsh|much)\b|\b(normal|regular|standard|default) colou?rs?\b|light mode|white background/.test(t)) {
      if (settings.theme === "high") return { set: { theme: "dark" }, say: PH.say.lessFromHigh };
      if (settings.theme === "dark") return { set: { theme: "standard" }, say: PH.say.lessFromDark };
      return { say: PH.say.lessAlready };
    }
    if (/\b(bigger|larger|increase|enlarge|zoom in|more zoom)\b/.test(t) && !/\b(too big|too large)\b/.test(t)) {
      if (i >= SIZES.length - 1) return { say: PH.say.sizeMax };
      var up = SIZES[i + 1];
      return { set: { textSize: up }, say: PH.say.sizeTo(up) };
    }
    if (/\b(smaller|decrease|reduce|zoom out|less zoom|too big|too large|shrink)\b/.test(t)) {
      if (i <= 0) return { say: PH.say.sizeMin };
      var down = SIZES[i - 1];
      return { set: { textSize: down }, say: PH.say.sizeTo(down) };
    }
    return null;
  }
  function isNo(raw) { var t = norm(raw); return t.split(" ").length <= 6 && /^(no|nope|nah|not (now|yet|really|today)|no thanks?|no thank you|maybe later|later|i'm not ready|not ready)\b/.test(t); }
  function isFine(raw) { var t = norm(raw); return t.split(" ").length <= 8 && /\b(it's |that's |looks |is )?(good|fine|great|perfect|comfortable|that works|easy to read|i can see it)\b/.test(t) && !/\b(yes|yeah|yep|sure|please|help|start|ready)\b/.test(t); }
  // Handles words that never need the server. Returns true when handled.
  function handleLocal(text, display) {
    var cmd = displayCommand(text, app.welcome);
    if (cmd) {
      addMessage("you", (display && display.text) || text, { voice: display && display.voice });
      if (cmd.set) { Object.keys(cmd.set).forEach(function (k) { settings[k] = cmd.set[k]; }); saveSettings(); }
      localTurn(cmd.say + (app.welcome ? PH.better(ASK) : ""), app.welcome);
      return true;
    }
    if (!app.welcome) return false;
    addMessage("you", (display && display.text) || text, { voice: display && display.voice });
    if (isNo(text)) { localTurn(PH.notReady, true); return true; }
    if (isFine(text)) { localTurn(PH.fine(ASK), true); return true; }
    proceed();
    return true;
  }

  function startSession(mode) {
    stopPreListen();
    app.mode = mode;
    $("start").hidden = true;
    $("convo").hidden = false;
    $("ended").hidden = true;
    setStatus("connecting");
    var body = { noticeAccepted: true, mode: mode };
    if (FLOW) body.flow = FLOW;
    return api("POST", "/api/session", body).then(function (j) {
      app.sessionId = j.sessionId;
      app.token = j.token;
      if (j.state) { app.state = j.state; app.revision = j.state.revision; }
      app.held = { turn: j.turn, state: j.state };
      app.welcome = true;
      updateModeUi();
      // They've heard the welcome and said yes (or pressed Space, Talk or
      // Type after hearing it): go straight into the conversation.
      if (app.saidYes || pre.heard) {
        if (app.saidYes) addMessage("you", app.saidYes, { voice: true });
        if (mode === "voice") voice.on = true;
        proceed();
        if (mode === "voice") startVoice(); else $("message").focus();
        return;
      }
      // Otherwise the welcome first: check the display is comfortable and
      // ask the page's question. The server's first turn waits for a yes.
      if (mode === "voice") { voice.on = true; welcomeTurn(); startVoice(); }
      else { welcomeTurn(); $("message").focus(); }
    }).catch(function (e) {
      setStatus("error", "Couldn't start: " + e.message);
      alertNow("Couldn't start the session. " + e.message + " Please try again in a moment.");
      $("start").hidden = false; $("convo").hidden = true;
    });
  }

  // Sends one user turn. Turns are queued so they reach the server in order.
  function sendTurn(payload, display) {
    if (app.ended) return;
    if (payload.text && handleLocal(payload.text, display)) return;
    payload.clientTurnId = uid();
    payload.mode = app.mode;
    payload.revision = app.revision;
    if (display) addMessage("you", display.text, { voice: display.voice });
    app.queue.push(payload);
    pump();
  }

  function pump() {
    if (app.busy || !app.queue.length) return;
    app.busy = true;
    var payload = app.queue.shift();
    setStatus("thinking");
    stopListening(true);
    var attempt = 0;
    (function go() {
      api("POST", "/api/session/" + app.sessionId + "/turn", payload).then(function (j) {
        app.busy = false;
        applyTurn(j.turn, j.state);
        pump();
      }).catch(function (e) {
        if (attempt === 0 && (!e.status || e.status >= 500)) { attempt++; return setTimeout(go, 800); } // same clientTurnId: safe to retry
        // A save collided with another save of this conversation: nothing was
        // stored, so sending the same turn again is safe.
        if (e.code === "conflict" && attempt < 2) { attempt++; return setTimeout(go, 300); }
        app.busy = false;
        app.queue = [];
        var msg = e.code === "conflict" ? "Your conversation was busy, so that message wasn't saved. Please send it again." :
          e.status === 409 ? "This session has ended." :
          (e.status === 404 || e.status === 410) ? "Sorry — the demo server lost this conversation. The hosted demo doesn't have a permanent database yet, so this can happen. Please press End session, then start a new one." :
          "I couldn't reach the server, so that message wasn't processed. Your earlier answers are safe. Please try sending it again.";
        addMessage("bot", msg);
        alertNow(msg);
        setStatus("error", "Couldn't reach the server");
        afterAssistant();
      });
    })();
  }

  // --------------------------------------------------------------- turns
  function applyTurn(turn, state) {
    if (state) { app.state = state; app.revision = state.revision; }
    if (!turn) return;
    if (turn.silent) { afterAssistant(); return; }
    app.lastTurn = turn;
    addMessage("bot", turn.text, { turnId: turn.turnId });
    announce(turn.text);
    var panelEl = $("panel");
    var focusWasInPanel = panelEl.contains(document.activeElement);
    renderPanel(turn, app.state);
    // The button that was pressed is gone now. Keep keyboard and screen-reader
    // users in place: move focus to the message box rather than the page top.
    if (focusWasInPanel && !panelEl.contains(document.activeElement) && !$("composer").hidden) {
      try { $("message").focus({ preventScroll: false }); } catch (e) {}
    }
    // Typing help: email keyboard when an address is expected.
    var box = $("message");
    var inp = turn.question && turn.question.input;
    box.setAttribute("inputmode", inp ? inp.inputmode : turn.expect === "email" ? "email" : "text");
    box.setAttribute("autocomplete", inp ? inp.autocomplete : "off");
    box.setAttribute("maxlength", String(inp ? inp.maxlength : 500));
    box.setAttribute("placeholder", inp && inp.placeholder ? inp.placeholder : turn.expect === "email" || (inp && inp.inputmode === "email") ? "Type your email address" : inp && inp.inputmode === "tel" ? "Type the phone number" : turn.expect === "name" ? "Type your first name" : inp ? "Type your answer" : "");
    if (inp && app.mode !== "voice") { try { box.focus({ preventScroll: true }); } catch (e) {} }
    if (turn.expect === "ended") {
      // Say goodbye first, then close everything down.
      if (settings.readAloud && (canSpeak || natural.available)) { app.endAfterSpeech = true; speak(turn.speech || turn.text, turn.turnId); }
      else finishSession(false);
      return;
    }
    if (settings.readAloud && (canSpeak || natural.available)) speak(turn.speech || turn.text, turn.turnId);
    else afterAssistant();
    watchActions();
  }

  function afterAssistant() {
    if (app.ended) return;
    if (app.endAfterSpeech) { app.endAfterSpeech = false; finishSession(false); return; }
    if (app.mode === "voice" && voice.on && !voice.muted) startListening();
    else if (app.mode === "voice" && voice.muted) setStatus("paused");
    else if (app.mode === "voice" && !voice.on) setStatus("disconnected", "Voice is off — press Start voice again, or type below");
    else setStatus("ready");
  }

  // ---------------------------------------------------------------- panel
  function renderPanel(turn, state) {
    var panel = $("panel");
    panel.textContent = "";
    if (turn.recap || (state && state.phase === "recap" && turn.expect === "confirm_recap")) panel.appendChild(recapCard(turn.recap || { revision: state.revision, items: state.answers }));
    else if (turn.question) panel.appendChild(questionCard(turn.question));
    else if (turn.expect === "block_offer") panel.appendChild(blockOfferCard());
    else if (turn.expect === "yes_no") panel.appendChild(yesNoCard());
    if (turn.consent) panel.appendChild(consentCard(turn.consent));
    var results = turn.results || (state && state.results);
    if (results && ["results", "email_address", "email_confirm_address", "email_consent", "staff_contact", "staff_confirm"].indexOf(state.phase) !== -1) {
      panel.appendChild(resultsSection(results));
    }
    renderActions(state);
  }

  function quickButtons(question) {
    var row = el("div", { class: "action-row" });
    if (!question.required) row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: "I don't know", onclick: function () { sendTurn({ action: "unknown" }, { text: "I don't know" }); } }));
    if (question.skippable) row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: "Skip", onclick: function () { sendTurn({ action: "skip" }, { text: "Skip" }); } }));
    if (question.sensitive && !question.required) row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: "Prefer not to say", onclick: function () { sendTurn({ action: "decline" }, { text: "I'd rather not say" }); } }));
    row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: "Why do you ask?", onclick: function () { sendTurn({ text: "why do you ask" }, { text: "Why do you ask?" }); } }));
    return row;
  }

  function questionCard(question) {
    var card = el("section", { class: "card", "aria-labelledby": "qh" });
    card.appendChild(el("h3", { id: "qh", text: question.prompt_screen || question.prompt }));
    if (question.help) card.appendChild(el("p", { class: "hint", text: question.help }));
    if (question.input) card.appendChild(el("p", { class: "hint", text: (question.required ? "Required. " : "") + (app.mode === "voice" ? "Say your answer, or type it in the box below." : "Type your answer in the box below.") }));
    if (question.type === "multi") {
      var fs = el("fieldset", { class: "multi" }, [el("legend", { class: "sr-only", text: question.prompt_screen || question.prompt })]);
      var grid = el("div", { class: "grid" });
      question.options.forEach(function (o) {
        grid.appendChild(el("label", null, [el("input", { type: "checkbox", value: o.value }), o.label]));
      });
      fs.appendChild(grid);
      card.appendChild(fs);
      card.appendChild(el("button", { type: "button", class: "btn btn-primary", text: "Done — use these", onclick: function () {
        var vals = [].slice.call(fs.querySelectorAll("input:checked")).map(function (i) { return i.value; });
        if (!vals.length) { alertNow("Choose at least one, or use Skip."); return; }
        var labels = question.options.filter(function (o) { return vals.indexOf(o.value) !== -1; }).map(function (o) { return o.label; });
        sendTurn({ choice: { questionId: question.id, value: vals } }, { text: labels.join(", ") });
      } }));
    } else {
      var opts = el("div", { class: "options", role: "group", "aria-label": "Choices" });
      question.options.forEach(function (o) {
        opts.appendChild(el("button", { type: "button", class: "btn", text: o.label, onclick: function () {
          sendTurn({ choice: { questionId: question.id, value: o.value } }, { text: o.label });
        } }));
      });
      card.appendChild(opts);
    }
    card.appendChild(quickButtons(question));
    return card;
  }

  function yesNoCard() {
    var card = el("section", { class: "card" });
    card.appendChild(el("div", { class: "action-row", role: "group", "aria-label": "Answer yes or no" }, [
      el("button", { type: "button", class: "btn btn-primary", text: "Yes", onclick: function () { sendTurn({ text: "yes" }, { text: "Yes" }); } }),
      el("button", { type: "button", class: "btn", text: "No", onclick: function () { sendTurn({ text: "no" }, { text: "No" }); } }),
    ]));
    return card;
  }

  function blockOfferCard() {
    var card = el("section", { class: "card" });
    card.appendChild(el("h3", { text: "Answer these questions, or skip this section?" }));
    card.appendChild(el("div", { class: "action-row" }, [
      el("button", { type: "button", class: "btn btn-primary", text: "Answer them", onclick: function () { sendTurn({ action: "answer_section", text: "answer them" }, { text: "Answer them" }); } }),
      el("button", { type: "button", class: "btn", text: "Skip this section", onclick: function () { sendTurn({ text: "skip this section" }, { text: "Skip this section" }); } }),
    ]));
    return card;
  }

  function recapCard(recap) {
    var card = el("section", { class: "card recap", "aria-labelledby": "rh" });
    card.appendChild(el("h3", { id: "rh", text: "Please check your answers" }));
    card.appendChild(el("p", { class: "hint", text: app.flow && app.flow.routing === false ? "Nothing is sent until you confirm. Change anything that's wrong." : "Nothing is suggested until you confirm. Change anything that's wrong." }));
    var ul = el("ul", { class: "recap-list" });
    (recap.items || []).forEach(function (it) {
      var value = it.display;
      var li = el("li", null, [
        el("span", null, [el("span", { class: "k", text: it.label + ": " }), value]),
        el("button", { type: "button", class: "btn btn-secondary", text: "Change", "aria-label": "Change " + it.label, onclick: function () {
          sendTurn({ action: "edit_answer", questionId: it.questionId }, { text: "Change " + it.label.toLowerCase() });
        } }),
      ]);
      ul.appendChild(li);
    });
    card.appendChild(ul);
    var rev = recap.revision;
    card.appendChild(el("div", { class: "action-row" }, [
      el("button", { type: "button", class: "btn btn-primary", text: "Yes, that's all correct", onclick: function () {
        sendTurn({ action: "confirm_recap", revision: rev }, { text: "Yes, that's all correct" });
      } }),
    ]));
    return card;
  }

  function consentCard(c) {
    var card = el("section", { class: "card recap", "aria-labelledby": "ch" });
    card.appendChild(el("h3", { id: "ch", text: "Send this email?" }));
    card.appendChild(el("p", { text: "One email to " + c.recipient + " with " + c.matchCount + " suggested services, their contact details and next steps. Your answers about health, money, housing and other personal matters are not included." }));
    card.appendChild(el("div", { class: "action-row" }, [
      el("button", { type: "button", class: "btn btn-primary", text: "Yes, send it", onclick: function () { sendTurn({ text: "yes" }, { text: "Yes, send it" }); } }),
      el("button", { type: "button", class: "btn", text: "No, don't send", onclick: function () { sendTurn({ text: "no" }, { text: "No, don't send" }); } }),
    ]));
    return card;
  }

  function resultsSection(results) {
    var wrap = el("section", { "aria-labelledby": "resh" });
    wrap.appendChild(el("h2", { id: "resh", text: "Suggested services (" + results.matches.length + ")" }));
    wrap.appendChild(el("p", { class: "hint", text: results.shownBecause + " Each organization decides who qualifies — contact them to confirm." }));
    if (results.unresolved && results.unresolved.length) {
      wrap.appendChild(el("p", { class: "uncertain", text: "Some answers weren't known or were skipped, so some suggestions may change once those are clearer." }));
    }
    wrap.appendChild(el("div", { class: "action-row" }, [
      el("button", { type: "button", class: "btn btn-primary", text: "Email me this plan", onclick: function () { sendTurn({ action: "request_email" }, { text: "Email me this plan" }); } }),
      el("button", { type: "button", class: "btn", text: "Ask a staff member to follow up", onclick: function () { sendTurn({ action: "request_staff" }, { text: "Ask a staff member to follow up" }); } }),
      el("button", { type: "button", class: "btn btn-secondary", text: "I'm all done", onclick: function () { sendTurn({ action: "finish" }, { text: "I'm all done" }); } }),
    ]));
    var ol = el("ol", { class: "results", style: "list-style:none;padding:0;margin:0.8rem 0 0" });
    results.matches.forEach(function (m) { ol.appendChild(el("li", null, [matchCard(m)])); });
    wrap.appendChild(ol);
    (results.handoffs || []).forEach(function (h) {
      var c = el("section", { class: "card gap" }, [el("h3", { text: h.headline }), el("p", { text: h.body })]);
      h.referTo.forEach(function (r) {
        c.appendChild(el("p", null, [el("a", { href: r.url, text: r.name }), r.contacts.general_phone ? " — " : "", r.contacts.general_phone ? telLink(r.contacts.general_phone) : null]));
      });
      if (h.missingRecordNote) c.appendChild(el("p", { class: "hint", text: h.missingRecordNote }));
      wrap.appendChild(c);
    });
    return wrap;
  }

  function telLink(phone) {
    var first = String(phone).split(/[;,]/)[0].trim();
    var digits = first.replace(/[^0-9]/g, "");
    return digits.length >= 10 ? el("a", { href: "tel:" + digits, text: phone }) : document.createTextNode(phone);
  }

  function linkOrText(url, label) {
    return /^https?:\/\//.test(url || "") ? el("a", { href: url, target: "_blank", rel: "noopener", text: label || url }) : document.createTextNode(url || "");
  }

  function matchCard(m) {
    var card = el("article", { class: "card", "aria-labelledby": "m-" + m.id });
    card.appendChild(el("h3", { id: "m-" + m.id, text: m.rank + ". " + m.name }));
    if (m.parent) card.appendChild(el("p", { class: "hint", text: "Part of " + m.parent.name }));
    card.appendChild(el("p", { text: m.oneLine }));
    if (m.reasons.length) {
      card.appendChild(el("p", { style: "font-weight:700;margin-bottom:0", text: "Why it's suggested" }));
      card.appendChild(el("ul", null, m.reasons.slice(0, 3).map(function (r) { return el("li", { text: r }); })));
    }
    var dl = el("dl");
    function row(k, v) { if (v) { dl.appendChild(el("dt", { text: k })); dl.appendChild(el("dd", null, [typeof v === "string" ? document.createTextNode(v) : v])); } }
    if (m.accessPath[0]) row("First step", m.accessPath[0].action + (m.accessPath[0].detail ? " — " + m.accessPath[0].detail : ""));
    if (m.contacts.general_phone) row("Phone", telLink(m.contacts.general_phone));
    if (m.contacts.general_email) row("Email", el("a", { href: "mailto:" + m.contacts.general_email, text: m.contacts.general_email }));
    if (m.contacts.website) row("Website", linkOrText(m.contacts.website));
    if (m.contacts.intake_form_url) row("Referral form", linkOrText(m.contacts.intake_form_url));
    row("Cost", m.cost);
    row("Typical wait", m.typicalWait);
    card.appendChild(dl);
    m.uncertainty.forEach(function (u) { card.appendChild(el("p", { class: "uncertain", text: u })); });

    var det = el("details", null, [el("summary", { text: "All steps, eligibility and documents" })]);
    if (m.accessPath.length) {
      det.appendChild(el("p", { style: "font-weight:700;margin-bottom:0", text: "How to get started" }));
      var ol = el("ol");
      m.accessPath.forEach(function (s) {
        var li = el("li", null, [el("strong", { text: s.action }), s.detail ? el("span", { text: " — " + s.detail }) : null, s.duration ? el("span", { class: "hint", text: " (" + s.duration + ")" }) : null]);
        if (s.branches.length) {
          li.appendChild(el("ul", null, s.branches.map(function (b) {
            return el("li", null, [el("em", { text: "If " + b.condition.charAt(0).toLowerCase() + b.condition.slice(1) + ": " }), b.note || "", b.goto ? " " : "", b.goto ? el("a", { href: b.goto.url, text: "See " + b.goto.name }) : null]);
          })));
        }
        ol.appendChild(li);
      });
      det.appendChild(ol);
    }
    if (m.whoQualifies.length) { det.appendChild(el("p", { style: "font-weight:700;margin-bottom:0", text: "Who qualifies" })); det.appendChild(el("ul", null, m.whoQualifies.map(function (x) { return el("li", { text: x }); }))); }
    if (m.documentation.length) { det.appendChild(el("p", { style: "font-weight:700;margin-bottom:0", text: "Documents" })); det.appendChild(el("ul", null, m.documentation.map(function (x) { return el("li", { text: x }); }))); }
    if (m.cautions && m.cautions.length) { det.appendChild(el("p", { style: "font-weight:700;margin-bottom:0", text: "Things to check" })); det.appendChild(el("ul", null, m.cautions.map(function (x) { return el("li", { text: x }); }))); }
    det.appendChild(el("p", { class: "hint", text: "Listing last verified " + (m.lastVerified || "date unknown") + (m.confidence ? " · confidence " + m.confidence : "") + "." }));
    det.appendChild(el("p", null, [el("a", { href: m.url, text: "Open the full listing in the directory" })]));
    card.appendChild(det);
    return card;
  }

  // -------------------------------------------------------------- actions
  var ACTION_TEXT = {
    queued: ["wait", "Email: queued — waiting to be handed to the email service."],
    running: ["wait", "Email: sending now…"],
    retrying: ["wait", "Email: the email service didn't answer. Trying again shortly."],
    provider_accepted: ["ok", "Email: accepted by the email service. That means it was handed over for delivery; it doesn't prove it arrived."],
    mock_written: ["mock", "Email: written to the demo's local test outbox. It was NOT sent to a real inbox."],
    failed: ["bad", "Email: failed to send. Nothing was delivered. A staff member has been asked to follow up."],
    cancelled: ["bad", "Email: cancelled, because your answers changed after you agreed. Nothing was sent."],
  };
  function renderActions(state) {
    var old = $("action-box");
    if (old) old.remove();
    if (!state || !state.actions || !state.actions.length) return;
    var box = el("div", { id: "action-box", role: "status" });
    state.actions.forEach(function (a) {
      var t = ACTION_TEXT[a.status] || ["wait", "Email: " + a.status];
      box.appendChild(el("p", { class: "action-status " + t[0], text: t[1] }));
    });
    $("panel").appendChild(box);
  }

  var actionTimer = null;
  function watchActions() {
    if (actionTimer) return;
    var pending = function (s) { return s && s.actions && s.actions.some(function (a) { return ["queued", "running", "retrying"].indexOf(a.status) !== -1; }); };
    if (!pending(app.state)) return;
    actionTimer = setInterval(function () {
      if (app.ended) { clearInterval(actionTimer); actionTimer = null; return; }
      api("GET", "/api/session/" + app.sessionId + "/state").then(function (j) {
        var before = JSON.stringify((app.state.actions || []).map(function (a) { return a.status; }));
        app.state = j.state;
        var after = JSON.stringify((j.state.actions || []).map(function (a) { return a.status; }));
        if (before !== after) {
          renderActions(j.state);
          j.state.actions.forEach(function (a) {
            if (!app.seenActions[a.id + a.status] && ACTION_TEXT[a.status] && ["provider_accepted", "mock_written", "failed", "cancelled"].indexOf(a.status) !== -1) {
              app.seenActions[a.id + a.status] = true;
              announce(ACTION_TEXT[a.status][1], true);
            }
          });
        }
        if (!pending(j.state)) { clearInterval(actionTimer); actionTimer = null; }
      }).catch(function () {});
    }, 2000);
  }

  // ---------------------------------------------------------------- voice
  var voice = { on: false, muted: false, rec: null, listening: false, speaking: false, speakingTurn: null, finalText: "", pendingLi: null, sendTimer: null, spokenChars: 0, interruptedTurn: null };

  function startVoice() {
    if (!canListen) { fallbackToText("Talking isn't available in this browser, so I've switched to typing. Your conversation continues below."); return; }
    setStatus("connecting", "Asking for your microphone…");
    var gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? navigator.mediaDevices.getUserMedia({ audio: true }) : Promise.resolve(null);
    gum.then(function (stream) {
      // Permission check only; recognition opens its own capture. Release at once.
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      voice.on = true; voice.muted = false;
      updateModeUi();
      if (!voice.speaking) afterAssistant(); else setStatus("speaking");
    }).catch(function (err) {
      var name = err && err.name;
      var why = name === "NotAllowedError" || name === "SecurityError" ? "Microphone permission was not given" :
        name === "NotFoundError" ? "No microphone was found" : "The microphone couldn't be started";
      fallbackToText(why + ", so I've switched to typing. Your conversation continues below — nothing is lost.");
    });
  }

  function fallbackToText(message) {
    stopSpeaking("fallback", true);
    stopListening(); voice.on = false;
    app.mode = "text";
    updateModeUi();
    if (app.sessionId) api("POST", "/api/session/" + app.sessionId + "/event", { type: "mode_switch", mode: "text" }).catch(function () {});
    addMessage("bot", message);
    alertNow(message);
    setStatus("ready");
    $("message").focus();
  }

  function makeRecognizer() {
    var r = new SR();
    r.lang = "en-US";
    r.interimResults = true;
    // Keep listening through short pauses; the end of the person's turn is
    // decided below by a silence timer (Settings: wait 1, 2 or 3 seconds).
    r.continuous = true;
    r.maxAlternatives = 1;
    r.onresult = function (ev) {
      var interim = "", fin = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) fin += t; else interim += t;
      }
      if (voice.speaking && settings.bargeIn && (interim + fin).trim().split(/\s+/).length >= 2) {
        stopSpeaking("barge-in");
      }
      if (fin) voice.finalText = (voice.finalText + " " + fin).trim();
      voice.interimText = interim.trim();
      showPending((voice.finalText + " " + interim).trim());
      armSilenceTimer();
    };
    r.onerror = function (ev) {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") { fallbackToText("Microphone permission was turned off, so I've switched to typing. Nothing is lost."); return; }
      if (ev.error === "audio-capture") { fallbackToText("I can't hear a microphone any more, so I've switched to typing. Nothing is lost."); return; }
      // network or other: stop and let the person decide; no silent reconnect.
      voice.on = false;
      voice.listening = false;
      clearPending();
      setStatus("disconnected", "Voice disconnected (" + ev.error + "). Press Start voice again, or type below.");
      $("reconnect").hidden = false;
    };
    r.onend = function () {
      voice.listening = false;
      clearSilenceTimer();
      // If the browser ended the capture mid-sentence (it does after long
      // stretches), keep what we have and carry on listening rather than
      // sending half an answer — unless the person's turn is over.
      if (!voice.turnOver && voice.on && !voice.muted && !app.ended && app.mode === "voice" && (voice.finalText || voice.interimText)) {
        if (voice.interimText) voice.finalText = (voice.finalText + " " + voice.interimText).trim();
        voice.interimText = "";
        var keep = voice.finalText;
        setTimeout(function () { if (!voice.listening && voice.on && !voice.muted) { startListening(true); voice.finalText = keep; showPending(keep); armSilenceTimer(); } }, 150);
        return;
      }
      voice.turnOver = false;
      if (voice.interimText) voice.finalText = (voice.finalText + " " + voice.interimText).trim();
      voice.interimText = "";
      var text = voice.finalText.replace(/\s+/g, " ").trim();
      voice.finalText = "";
      if (text) {
        clearPending();
        sendTurn({ text: text }, { text: text, voice: true });
        return;
      }
      clearPending();
      // Keep listening while the session is in voice mode and the person hasn't muted.
      if (voice.on && !voice.muted && !voice.speaking && !app.busy && app.mode === "voice" && !app.ended) {
        setTimeout(function () { if (voice.on && !voice.muted && !voice.speaking && !app.busy && !voice.listening) startListening(); }, 250);
      }
    };
    return r;
  }

  // End of turn: once the person has said something, wait for a pause of
  // settings.endSilence ms with no new words, then finish the turn.
  function clearSilenceTimer() { if (voice.silenceTimer) { clearTimeout(voice.silenceTimer); voice.silenceTimer = null; } }
  function armSilenceTimer() {
    clearSilenceTimer();
    if (!(voice.finalText || voice.interimText)) return;
    $("done-talking").hidden = false;
    voice.silenceTimer = setTimeout(endTurn, Number(settings.endSilence) || 2000);
  }
  function endTurn() {
    clearSilenceTimer();
    if (!voice.listening) return;
    voice.turnOver = true;
    $("done-talking").hidden = true;
    try { voice.rec.stop(); } catch (e) {}  // stop() (not abort) delivers the last words, then onend sends them
  }
  $("done-talking").addEventListener("click", endTurn);

  function showPending(text) {
    if (!text) return;
    if (!voice.pendingLi) {
      voice.pendingLi = addMessage("you", text, { pending: true, voice: true });
      voice.pendingLi.querySelector(".who").textContent = "You (still listening — I'll answer when you pause)";
    } else {
      voice.pendingLi.querySelector("p").textContent = text;
    }
  }
  function clearPending() {
    if (voice.pendingLi) { voice.pendingLi.remove(); voice.pendingLi = null; }
  }

  function startListening(resume) {
    if (!voice.on || voice.muted || voice.listening || app.ended) return;
    if (voice.speaking && !settings.bargeIn) return;
    try {
      voice.rec = voice.rec || makeRecognizer();
      if (!resume) { voice.finalText = ""; voice.interimText = ""; voice.turnOver = false; }
      voice.rec.start();
      voice.listening = true;
      if (!voice.speaking) setStatus("listening");
    } catch (e) { /* already started */ }
  }

  function stopListening(keepOn) {
    clearSilenceTimer();
    $("done-talking").hidden = true;
    voice.turnOver = true;  // an abort is never "mid-sentence": don't auto-resume
    if (voice.rec && voice.listening) { try { voice.rec.abort(); } catch (e) {} }
    voice.listening = false;
    clearPending();
    if (!keepOn) voice.finalText = "";
  }

  // Speech: split into sentences (long single utterances get cut off in some
  // browsers) and track how far we got so an interruption can be reported.
  function stopNaturalAudio() {
    if (natural.audio) { try { natural.audio.pause(); } catch (e) {} natural.audio = null; }
    if (natural.url) { try { URL.revokeObjectURL(natural.url); } catch (e) {} natural.url = null; }
  }

  function speak(text, turnId) {
    if (useNatural() && app.sessionId && app.lastTurn && turnId === app.lastTurn.turnId) return speakNatural(text, turnId, sessionAudio);
    if (useNatural() && String(turnId).indexOf("local-") === 0) return speakNatural(text, turnId, phraseAudio);
    return speakDevice(text, turnId);
  }
  function sessionAudio(text, turnId) {
    return fetch("/api/session/" + app.sessionId + "/tts", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + app.token }, body: JSON.stringify({ turnId: turnId, rate: settings.rate }) });
  }
  // The assistant's fixed lines (welcome, display replies): the server voices
  // only lines listed in /voice-phrases.js.
  function phraseAudio(text) {
    return fetch("/api/tts-phrase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text, rate: settings.rate }) });
  }

  // Natural voice: fetch the audio for this exact reply, play it, and fall
  // back to the device voice if anything goes wrong.
  function speakNatural(text, turnId, getAudio) {
    stopSpeaking("new-turn", true);
    voice.speaking = true;
    voice.speakingTurn = turnId;
    $("stop-speaking").disabled = false;
    setStatus("speaking");
    if (!settings.bargeIn) stopListening(true); else startListening();
    getAudio(text, turnId)
      .then(function (r) { if (!r.ok) throw new Error("tts " + r.status); return r.blob(); })
      .then(function (blob) {
        if (!voice.speaking || voice.speakingTurn !== turnId) return;
        natural.url = URL.createObjectURL(blob);
        var a = new Audio(natural.url);
        natural.audio = a;
        a.onended = function () {
          if (voice.speakingTurn !== turnId) return;
          voice.speaking = false; voice.speakingTurn = null;
          $("stop-speaking").disabled = true;
          stopNaturalAudio();
          afterAssistant();
        };
        return a.play();
      })
      .catch(function () {
        if (voice.speakingTurn !== turnId) return;
        voice.speaking = false; voice.speakingTurn = null;
        speakDevice(text, turnId);
      });
  }

  function speakDevice(text, turnId) {
    if (!canSpeak) { afterAssistant(); return; }
    stopSpeaking("new-turn", true);
    var chunks = String(text).match(/[^.!?]+[.!?]+["')]*|[^.!?]+$/g) || [text];
    voice.speaking = true;
    voice.speakingTurn = turnId;
    voice.spokenChars = 0;
    $("stop-speaking").disabled = false;
    setStatus("speaking");
    if (!settings.bargeIn) stopListening(true); else startListening();
    var i = 0;
    (function next() {
      if (!voice.speaking || voice.speakingTurn !== turnId) return;
      if (i >= chunks.length) {
        voice.speaking = false; voice.speakingTurn = null;
        $("stop-speaking").disabled = true;
        afterAssistant();
        return;
      }
      var u = new SpeechSynthesisUtterance(chunks[i].trim());
      var v = currentVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-US";
      u.rate = Number(settings.rate) || 1;
      u.onend = function () { voice.spokenChars += chunks[i].length; i++; next(); };
      u.onerror = function () { i++; next(); };
      window.speechSynthesis.speak(u);
    })();
  }

  function stopSpeaking(reason, silent) {
    if (!canSpeak && !natural.audio && !voice.speaking) return;
    var wasTurn = voice.speakingTurn;
    var was = voice.speaking;
    voice.speaking = false;
    voice.speakingTurn = null;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    stopNaturalAudio();
    $("stop-speaking").disabled = true;
    if (was && wasTurn && !silent) {
      markInterrupted(wasTurn);
      if (app.sessionId) api("POST", "/api/session/" + app.sessionId + "/event", { type: "speech_interrupted", turnId: wasTurn }).catch(function () {});
      if (reason !== "barge-in") afterAssistant();
    }
  }

  // ------------------------------------------------------------ controls
  $("stop-speaking").addEventListener("click", function () { stopSpeaking("button"); });
  $("replay").addEventListener("click", function () {
    if (!app.lastTurn) return;
    if (canSpeak && settings.readAloud) speak(app.lastTurn.speech || app.lastTurn.text, app.lastTurn.turnId);
    else { announce(app.lastTurn.text, true); }
  });
  $("mic-toggle").addEventListener("click", function () {
    voice.muted = !voice.muted;
    this.setAttribute("aria-pressed", voice.muted ? "true" : "false");
    this.textContent = voice.muted ? "Unmute microphone" : "Mute microphone";
    if (voice.muted) { stopListening(); setStatus("paused"); }
    else { voice.on = true; afterAssistant(); }
  });
  $("reconnect").addEventListener("click", function () { $("reconnect").hidden = true; voice.rec = null; startVoice(); });

  $("to-text").addEventListener("click", function () {
    stopSpeaking("mode-switch", true); stopListening(); voice.on = false;
    app.mode = "text"; updateModeUi();
    api("POST", "/api/session/" + app.sessionId + "/event", { type: "mode_switch", mode: "text" }).then(function (j) { if (j.state) app.state = j.state; }).catch(function () {});
    setStatus("ready");
    addMessage("bot", "Switched to typing. Everything so far is kept.");
    $("message").focus();
  });
  $("to-voice").addEventListener("click", function () {
    if (!canListen) { alertNow("Talking isn't available in this browser."); return; }
    app.mode = "voice"; updateModeUi();
    api("POST", "/api/session/" + app.sessionId + "/event", { type: "mode_switch", mode: "voice" }).then(function (j) { if (j.state) app.state = j.state; }).catch(function () {});
    addMessage("bot", "Switched to talking. Everything so far is kept.");
    voice.rec = null;
    startVoice();
  });

  function updateModeUi() {
    var isVoice = app.mode === "voice";
    $("voice-controls").hidden = !isVoice;
    $("to-text").hidden = !isVoice;
    $("to-voice").hidden = isVoice || !canListen;
  }

  $("composer").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("message");
    var text = input.value.trim();
    if (!text) return;
    if (voice.speaking) stopSpeaking("typed");
    input.value = "";
    sendTurn({ text: text }, { text: text });
  });

  document.addEventListener("keydown", function (e) {
    // Escape stops speech (unless a dialog is open — it closes that instead).
    if (e.key === "Escape" && voice.speaking && !dlg.open) stopSpeaking("escape");
  });

  $("end-session").addEventListener("click", function () {
    if (app.sessionId) api("POST", "/api/session/" + app.sessionId + "/end", {}).catch(function () {});
    finishSession(true);
  });
  $("restart").addEventListener("click", function () { window.location.reload(); });

  // After the Vision Assessment: offer the screen settings check (when it's
  // switched on), linked to this conversation by its own token.
  var checkOn = false;
  if (ON_ASSESSMENT) fetch("/api/site", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) { checkOn = !!(j.features && j.features.screenCheck); }).catch(function () {});
  $("to-check").addEventListener("click", function () {
    try { sessionStorage.setItem("v360-check-from", JSON.stringify({ sessionId: app.sessionId, token: app.token })); } catch (e) {}
    location.href = "/screen-check/";
  });

  function finishSession(userEnded) {
    app.ended = true;
    stopSpeaking("end", true);
    stopListening();
    voice.on = false;
    if (voice.rec) { try { voice.rec.abort(); } catch (e) {} voice.rec = null; }
    if (actionTimer) { clearInterval(actionTimer); actionTimer = null; }
    setStatus("ended");
    $("composer").querySelector("input").disabled = true;
    $("send").disabled = true;
    $("voice-controls").hidden = true;
    $("ended").hidden = false;
    $("check-cta").hidden = !(ON_ASSESSMENT && checkOn && app.sessionId);
    $("ended-h").focus();
  }

  window.addEventListener("pagehide", function () { stopSpeaking("leave", true); stopListening(); });

  // Five seconds after the page opens, say the welcome, then listen: saying
  // yes starts the conversation, and "bigger text" or "less contrast" change
  // the display. Most browsers only allow speech after the first tap or key
  // press; if it's blocked, the welcome plays on the first one.
  var pre = { heard: false, blocked: false, due: false, rec: null, listening: false, until: 0 };
  function sayStart(text, done) {
    // Never listen while the assistant is talking (it would hear itself).
    pre.speaking = true;
    function onDone(ok) { if (!pre.speaking) return; pre.speaking = false; done(ok); }
    stopPreListen();
    function device() {
      if (!canSpeak) { onDone(false); return; }
      try { window.speechSynthesis.cancel(); } catch (e) {}
      var u = new SpeechSynthesisUtterance(text);
      var v = currentVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-US";
      u.rate = Number(settings.rate) || 1;
      u.onstart = function () { pre.heard = true; };
      u.onend = function () { onDone(true); };
      u.onerror = function (e) { if (e.error === "not-allowed") pre.blocked = true; onDone(false); };
      try { window.speechSynthesis.speak(u); } catch (e) { onDone(false); }
    }
    if (!useNatural()) return device();
    stopNaturalAudio();
    phraseAudio(text).then(function (r) { if (!r.ok) throw new Error("tts " + r.status); return r.blob(); }).then(function (blob) {
      if (app.sessionId) return;
      natural.url = URL.createObjectURL(blob);
      var a = new Audio(natural.url);
      natural.audio = a;
      a.onended = function () { stopNaturalAudio(); onDone(true); };
      return a.play().then(function () { pre.heard = true; }, function (e) {
        stopNaturalAudio();
        if (e && e.name === "NotAllowedError") { pre.blocked = true; onDone(false); } else device();
      });
    }).catch(function () { device(); });
  }
  function onStartScreen() { return !app.sessionId && !$("start").hidden && !$("start-voice").disabled; }
  function speakOnStart() {
    if (pre.heard || !pre.due || !onStartScreen() || !settings.readAloud) return;
    pre.blocked = false;
    sayStart(welcomeText(), function (ok) { if (ok) startPreListen(); });
  }
  setTimeout(function () { pre.due = true; speakOnStart(); }, 5000);
  function firstPress(e) {
    var t = e.target;
    if (e.type === "keydown" && (e.key === " " || e.code === "Space" || e.key === "Enter")) return;
    if (t && t.closest && t.closest("#start-voice, #start-text")) return;
    if (pre.heard) { document.removeEventListener("pointerdown", firstPress, true); document.removeEventListener("keydown", firstPress, true); return; }
    if (pre.blocked) setTimeout(speakOnStart, 50);
  }
  document.addEventListener("pointerdown", firstPress, true);
  document.addEventListener("keydown", firstPress, true);

  // Listening on the start screen, for a few minutes after the welcome.
  function startPreListen() {
    if (!canListen || !onStartScreen() || pre.speaking) return;
    if (!pre.until) pre.until = Date.now() + 3 * 60 * 1000;
    if (Date.now() > pre.until || pre.listening) return;
    var r = new SR();
    r.lang = "en-US"; r.interimResults = false; r.continuous = false; r.maxAlternatives = 1;
    var heard = "";
    r.onresult = function (ev) { for (var i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) heard += " " + ev.results[i][0].transcript; };
    r.onerror = function (ev) { if (ev.error === "not-allowed" || ev.error === "service-not-allowed" || ev.error === "audio-capture") pre.until = 1; };
    r.onend = function () {
      pre.listening = false; pre.rec = null;
      var text = heard.trim();
      if (!onStartScreen()) return;
      if (text) return startReply(text);
      setTimeout(startPreListen, 300);
    };
    try { r.start(); pre.rec = r; pre.listening = true; } catch (e) { pre.listening = false; }
  }
  function stopPreListen() {
    if (pre.rec) { try { pre.rec.abort(); } catch (e) {} }
    pre.rec = null; pre.listening = false;
  }
  function startReply(text) {
    var cmd = displayCommand(text, true);
    if (cmd) {
      if (cmd.set) { Object.keys(cmd.set).forEach(function (k) { settings[k] = cmd.set[k]; }); saveSettings(); }
      return sayStart(cmd.say + PH.better(ASK), function () { pre.until = 0; startPreListen(); });
    }
    if (isNo(text)) return sayStart(PH.notReady, function () { pre.until = 0; startPreListen(); });
    if (isFine(text)) return sayStart(PH.fine(ASK), function () { pre.until = 0; startPreListen(); });
    app.saidYes = text;
    startSession("voice");
  }

  // Once the conversation is under way, fold the display settings away to
  // leave room for it (without changing what's remembered for next time).
  function hideBarForConversation() { if ($("dbar-toggle").getAttribute("aria-expanded") === "true") setBarOpen(false, false); }

  $("start-voice").addEventListener("click", function () { startSession(canListen ? "voice" : "text").then(function () { if (!canListen) fallbackToText("Talking isn't available in this browser, so we'll type instead."); }); });
  $("start-text").addEventListener("click", function () { startSession("text"); });

  // Space bar on the start screen starts the conversation (talking where the
  // browser can listen, typing otherwise), so someone sent straight to this
  // link can just press Space. Ignored while typing in a field, on a focused
  // control (Space already presses it) or with a dialog open.
  function startFromKey() {
    if ($("start-voice").disabled) return;
    $("start-voice").click();
  }
  document.addEventListener("keydown", function (e) {
    if (e.key !== " " && e.code !== "Space" && e.key !== "Enter") return;
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if ($("start").hidden || dlg.open || app.sessionId) return;
    var t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, button, a, summary, [contenteditable], [role='button'], dialog")) return;
    e.preventDefault();
    startFromKey();
  });
})();
