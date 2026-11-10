/* Screen settings check, in the browser.
 *
 * The browser shows each test and collects the answer (voice, keyboard or
 * touch); the server decides what comes next and keeps the results
 * (/api/check/*, server/lib/screen-check.mjs). Each finished test changes the
 * page right away through the shared display settings (display-settings.js),
 * so the person sees their new settings as they go.
 *
 * Talks first: the welcome plays a few seconds after the page opens, or on
 * the first tap or key press if the browser blocks sound. "I use a screen
 * reader" turns the talking off so the screen reader leads.
 *
 * The shell (Vision Assessment v2): a top bar with the steps and a Menu, the
 * test in the middle (two halves for each pair, top and bottom on phones), and
 * a caption bar with what was said and heard. Spoken commands
 * (voice-commands.js) work at any step: bigger, blue background, show menu,
 * go back, skip, end. Anything changed outside a test is sent to the server
 * so staff can see what the person reached for.
 */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  var D = window.V360Display;
  var K = window.V360Commands || null;
  var html = document.documentElement;
  var KEY = "v360-check";               // this tab's check id and token, to carry on after a reload
  var FROM_KEY = "v360-check-from";     // set by the Vision Assessment's "Check my screen settings" button
  var ASSIST_KEY = "v360-demo-settings"; // the assistant's own settings (speech rate)
  var NAMES = { speech_rate: "Speaking speed", magnification: "Text size", pictures: "Pictures", contrast: "Colors", cursor: "Pointer", bold: "Text weight" };
  // The same live test runs as the Vision Assessment (/assessment/). The older
  // question-and-answer version stays at /assessment/interview/.
  var ASSESS = /^\/assessment\/?$/.test(location.pathname);
  // "Try it" on the admin Workflows page: staff can run the test before it's
  // made live. The server only allows it for a signed-in admin.
  var PREVIEW = /(^|[?&])preview=1(&|$)/.test(location.search.slice(1));
  var INTERVIEW_URL = "/assessment/interview/";
  var PAGE_NAME = ASSESS ? "Vision Assessment" : "Screen settings check";
  if (ASSESS) { document.title = "Vision Assessment — Vision 360"; $("stage-h").textContent = PAGE_NAME; }

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var canListen = !!SR;
  var canSpeak = "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
  var natural = false;
  var C = null;            // wording (site/data/screen-check.json)
  var st = { sr: false, listenOn: true, rate: savedRate(), volume: 1, lastSay: "", repeats: 0, trialStart: 0, stepIdx: 0, plan: [], first: {}, phase: "start", resume: null, sides: null, closed: false };

  function savedRate() {
    try { var r = (JSON.parse(localStorage.getItem(ASSIST_KEY) || "{}") || {}).rate; return ["0.7", "0.85", "1", "1.2", "1.4"].indexOf(String(r)) !== -1 ? String(r) : "0.85"; } catch (e) { return "0.85"; }
  }
  function saveRate(r) {
    try { var s = JSON.parse(localStorage.getItem(ASSIST_KEY) || "{}") || {}; s.rate = String(r); localStorage.setItem(ASSIST_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function announce(t) { var a = $("announcer"); a.textContent = ""; setTimeout(function () { a.textContent = t; }, 60); }
  function alertNow(t) { var a = $("alerter"); a.textContent = ""; setTimeout(function () { a.textContent = t; }, 60); }

  // ------------------------------------------------------------- the server
  function api(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    if (st.token) headers.Authorization = "Bearer " + st.token;
    if (PREVIEW) headers["X-V360-Preview"] = "1";
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ("Server error " + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  // ------------------------------------------------------------- talking
  var audio = null, speakToken = 0;
  function stopSpeaking() {
    speakToken++;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    if (audio) { try { audio.pause(); } catch (e) {} audio = null; }
  }
  // Says a line. Fixed lines use the natural voice when it's on; anything
  // else uses the device's voice. Resolves when finished (or skipped).
  function say(text, rate) {
    st.lastSay = text;
    announce(text);
    if (text) $("caption").textContent = text;
    if (st.sr || !text) return Promise.resolve(false);
    stopListening();
    stopSpeaking();
    var my = speakToken;
    var r = String(rate || st.rate);
    setListen("speaking", "Speaking…");
    function device() {
      return new Promise(function (resolve) {
        if (!canSpeak || my !== speakToken) return resolve(false);
        var u = new SpeechSynthesisUtterance(text);
        u.lang = "en-US"; u.rate = Number(r) || 1; u.volume = st.volume;
        u.onend = function () { resolve(true); };
        u.onerror = function (e) { if (e && e.error === "not-allowed") st.blocked = true; resolve(false); };
        try { window.speechSynthesis.speak(u); } catch (e) { resolve(false); }
      });
    }
    var p;
    if (natural) {
      p = fetch("/api/tts-phrase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text, rate: Number(r) }) })
        .then(function (res) { if (!res.ok) throw new Error("tts"); return res.blob(); })
        .then(function (blob) {
          if (my !== speakToken) return false;
          return new Promise(function (resolve) {
            var url = URL.createObjectURL(blob);
            audio = new Audio(url);
            audio.volume = st.volume;
            audio.onended = function () { URL.revokeObjectURL(url); resolve(true); };
            audio.play().catch(function (e) { if (e && e.name === "NotAllowedError") st.blocked = true; resolve(false); });
          });
        })
        .catch(function () { return device(); });
    } else p = device();
    return p.then(function (ok) { if (my === speakToken) setListen("", ""); return ok; });
  }

  // ------------------------------------------------------------- listening
  var rec = null, waiting = null;
  function setListen(state, text) {
    $("listen-status").setAttribute("data-state", state || "");
    $("listen-text").textContent = text || (st.listenOn && canListen && !st.sr ? "" : "Not listening");
  }
  function stopListening() {
    if (rec) { try { rec.abort(); } catch (e) {} rec = null; }
  }
  // Listens once for an answer; global words (repeat, stop listening) are
  // handled here and listening starts again.
  function listen(onText) {
    waiting = onText;
    if (!canListen || st.sr || !st.listenOn || !onText) { setListen("", ""); return; }
    stopListening();
    var r = new SR();
    r.lang = "en-US"; r.interimResults = false; r.continuous = false; r.maxAlternatives = 1;
    var heard = "";
    r.onresult = function (ev) { for (var i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) heard += " " + ev.results[i][0].transcript; };
    r.onerror = function (ev) { if (ev.error === "not-allowed" || ev.error === "service-not-allowed" || ev.error === "audio-capture") { st.listenOn = false; syncListenBtn(); setListen("", "Microphone off — use the buttons or keyboard"); } };
    r.onend = function () {
      if (rec !== r) return;
      rec = null;
      var t = heard.trim();
      if (!t) { if (waiting === onText && st.listenOn) setTimeout(function () { if (waiting === onText && !rec) listen(onText); }, 250); return; }
      var n = norm(t);
      var cmd = K ? K.parse(t) : null;
      setListen("", "Heard: " + t);
      // The screen's own meaning first ("faster" on the speed test), then
      // commands that work anywhere, then the screen's answer.
      if (cmd && st.onCommand && st.onCommand(cmd) === true) return;
      if (cmd && K.isGlobal(cmd)) return command(cmd, "voice");
      if (st.busy) return;
      onText(t, n, cmd);
    };
    try { r.start(); rec = r; setListen("listening", "Listening…"); } catch (e) { setListen("", ""); }
  }
  function syncListenBtn() {
    var b = $("listen-btn");
    b.setAttribute("aria-pressed", String(st.listenOn));
    b.textContent = st.listenOn ? "Stop listening" : "Start listening";
    if (!st.listenOn) { stopListening(); setListen("", "Not listening"); }
  }
  function norm(t) { return String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim(); }
  var YES = /^(yes|yeah|yep|yup|sure|correct|right|that's right|it is|ok|okay|please|yes please)\b/;
  var NO = /^(no|nope|nah|not really|wrong|no thanks|no thank you)\b/;

  // ------------------------------------------------------------- screens
  var primary = null;
  // Shows one screen: title, text, body, buttons. Says `speak`, then listens.
  function screen(o) {
    stopListening();
    st.busy = false;
    st.onN = o.onN || null;
    st.onDigit = o.onDigit || null;
    st.onCommand = o.onCommand || null;
    if (o.resume !== undefined) st.resume = o.resume;
    $("stage-h").textContent = o.title;
    $("stage-sub").textContent = o.sub || "";
    $("stage-sub").hidden = !o.sub;
    var body = $("stage-body"); body.textContent = "";
    (o.body || []).forEach(function (n) { if (n) body.appendChild(n); });
    var acts = $("stage-actions"); acts.textContent = "";
    primary = null;
    (o.actions || []).forEach(function (a) {
      var b = el("button", { type: "button", class: "btn " + (a.primary ? "btn-primary" : "btn-secondary"), disabled: a.disabled ? true : null, onclick: a.onClick }, [a.label, a.keyHint ? el("span", { class: "hint-key", text: " (" + a.keyHint + ")" }) : null]);
      if (a.id) b.id = a.id;
      if (a.primary) primary = b;
      acts.appendChild(b);
    });
    $("progress").textContent = o.progress || "";
    var halves = body.querySelectorAll(".pair > .pair-side");
    st.sides = halves.length === 2 ? [halves[0], halves[1]] : null;
    renderDots();
    if (o.focus !== false) { try { (o.focusEl || $("stage")).focus({ preventScroll: false }); } catch (e) {} }
    st.trialStart = Date.now();
    st.repeats = 0;
    var p = o.speak ? say(o.speak, o.rate) : Promise.resolve();
    p.then(function () { if (o.listen) listen(o.listen); });
  }

  // Space presses the main button (unless typing or on another control).
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { stopSpeaking(); if (!$("a-menu").hidden) closeMenu(false); return; }
    var t = e.target;
    var inField = t && t.closest && t.closest("input, textarea, select, button, a, [contenteditable]");
    var typing = t && t.closest && t.closest("input, textarea, select, [contenteditable], #a-menu");
    // Left and right halves: arrow keys, or F and J (the keys with bumps).
    // They move to a half; Space or Enter picks it.
    if (st.sides && !typing && !e.altKey && !e.ctrlKey && !e.metaKey) {
      var k = e.key;
      var which = /^(ArrowLeft|ArrowUp|f|F)$/.test(k) ? 0 : /^(ArrowRight|ArrowDown|j|J)$/.test(k) ? 1 : -1;
      if (which !== -1 && !st.sides[which].disabled) { e.preventDefault(); st.sides[which].focus(); return; }
    }
    if ((e.key === " " || e.code === "Space") && !inField && primary && !primary.disabled) { e.preventDefault(); primary.click(); }
    if ((e.key === "n" || e.key === "N") && !inField && st.onN) { e.preventDefault(); st.onN(); }
    if (/^[1-4]$/.test(e.key) && !inField && st.onDigit) { e.preventDefault(); st.onDigit(Number(e.key)); }
  });
  $("repeat-btn").addEventListener("click", function () { st.repeats++; say(st.lastSay).then(function () { if (waiting) listen(waiting); }); });
  $("listen-btn").addEventListener("click", function () { st.listenOn = !st.listenOn; syncListenBtn(); if (st.listenOn && waiting) listen(waiting); });

  // ------------------------------------------------------------- device
  function detectDevice() {
    var ua = navigator.userAgent || "";
    var touchPts = navigator.maxTouchPoints || 0;
    var coarseOnly = window.matchMedia && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
    var d = { type: "computer", os: "other", key: "computer" };
    if (/iPhone|iPod/.test(ua)) d = { type: "phone", os: "ios", key: "iphone" };
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPts > 1)) d = { type: "tablet", os: "ios", key: "ipad" };
    else if (/Android/.test(ua)) d = /Mobile/.test(ua) ? { type: "phone", os: "android", key: "android_phone" } : { type: "tablet", os: "android", key: "android_tablet" };
    else if (/CrOS/.test(ua)) d = { type: "computer", os: "chromeos", key: "chromebook" };
    else if (/Macintosh|Mac OS X/.test(ua)) d = { type: "computer", os: "mac", key: "mac" };
    else if (/Windows/.test(ua)) d = { type: "computer", os: "windows", key: "windows" };
    d.touchOnly = d.type !== "computer" || !!coarseOnly;
    d.screenW = window.screen ? screen.width : null; d.screenH = window.screen ? screen.height : null; d.dpr = window.devicePixelRatio || 1;
    return d;
  }

  // ------------------------------------------------------------- the flow
  function showStart(resume) {
    var actions = [
      { label: "Start", primary: true, keyHint: "Space", onClick: function () { begin(); } },
      { label: "I use a screen reader", onClick: function () { st.sr = true; stopSpeaking(); stopListening(); $("voice-row").hidden = true; announce(C.say.screenReader); begin(); } },
      { label: "I have a code from before", onClick: function () { showCode(); } },
    ];
    if (resume) actions.unshift({ label: "Carry on where I left off", onClick: function () { carryOn(resume); } });
    if (ASSESS) actions.push({ label: "Answer questions instead", onClick: function () { location.href = INTERVIEW_URL; } });
    st.phase = "start";
    screen({ title: PAGE_NAME, resume: null,
      sub: ASSESS
        ? "A live check of what you can see on this screen: read short phrases out loud, name pictures, and pick the colors and pointer that are easiest for you. It takes about ten minutes. Answer by talking, with the keyboard, or by tapping."
        : "Find the text size, colors, speaking speed and pointer that are easiest for you. It takes about ten minutes. Answer by talking, with the keyboard, or by tapping.",
      body: [
        el("p", { class: "hint", text: "Your answers are kept private, for Lions Services staff only. This isn't a medical eye exam." }),
        ASSESS ? el("p", { class: "hint", text: "If your vision changed suddenly, or you have eye pain, please contact an eye doctor or urgent care today." }) : null,
        ASSESS ? el("p", { class: "hint", text: "Helping someone? Let the person with low vision sit at the screen and answer." }) : null,
      ], actions: actions, focus: false });
    // Talk first: a few seconds after opening, or on the first tap or key.
    var started = false;
    function welcome() { if (started || st.id || st.sr || st.leftStart) return; started = true; say(ASSESS && C.say.assessIntro ? C.say.assessIntro : C.say.intro).then(function (ok) { if (!ok && st.blocked) { started = false; } else listen(function (t, n) { if (/\b(ready|start|yes|begin|go)\b/.test(n)) begin(); }); }); }
    st.leftStart = false;
    clearTimeout(st.welcomeTimer);
    st.welcomeTimer = setTimeout(welcome, 5000);
    function first(e) { if (e.target && e.target.closest && e.target.closest(".stage-actions")) return; if (st.blocked || !started) { st.blocked = false; started = false; setTimeout(welcome, 50); } document.removeEventListener("pointerdown", first, true); }
    document.addEventListener("pointerdown", first, true);
  }

  // Leaving the start screen: the welcome mustn't play over the next one.
  function leaveStart() { st.leftStart = true; clearTimeout(st.welcomeTimer); stopSpeaking(); }
  function showCode() {
    leaveStart();
    var input = el("input", { id: "code-in", type: "text", autocomplete: "off", placeholder: "for example: maple 47 river" });
    var go = function () { if (input.value.trim()) begin(input.value); };
    screen({ title: "Your code from before", sub: "It's a word, a number and a word, like \"maple 47 river\". Say it or type it.",
      body: [el("form", { class: "answer-row", onsubmit: function (e) { e.preventDefault(); go(); } }, [el("label", { for: "code-in", text: "Your code" }), input])],
      actions: [{ label: "Start with my code", primary: true, onClick: go }, { label: "Back", onClick: function () { showStart(null); } }],
      focusEl: input, listen: function (t) { input.value = t; go(); } });
  }

  function begin(code) {
    leaveStart();
    var from = null;
    try { from = JSON.parse(sessionStorage.getItem(FROM_KEY) || "null"); } catch (e) {}
    var dev = detectDevice();
    if (st.sr) dev.skipPointer = true; // the pointer test needs a mouse and eyes on the screen
    st.deviceKey = dev.key;
    api("POST", "/api/check/start", { device: dev, from: from, code: code ? String(code) : undefined }).then(function (j) {
      try { sessionStorage.removeItem(FROM_KEY); sessionStorage.setItem(KEY, JSON.stringify({ id: j.id, token: j.token })); } catch (e) {}
      st.id = j.id; st.token = j.token; st.code = j.code; st.plan = j.plan; st.device = j.device;
      if (!st.sr && (canListen || canSpeak)) $("voice-row").hidden = false;
      syncListenBtn();
      if (st.sr) return showDevice();
      showPractice();
    }).catch(function (e) {
      alertNow(e.message);
      $("stage-sub").textContent = e.message;
    });
  }

  function carryOn(saved) {
    leaveStart();
    st.id = saved.id; st.token = saved.token;
    api("GET", "/api/check/" + st.id).then(function (j) {
      var c = j.check;
      st.code = c.code; st.plan = c.plan; st.device = c.device;
      if (c.status !== "started") return showResults(c);
      st.phase = "test";
      if (canListen || canSpeak) $("voice-row").hidden = false;
      syncListenBtn();
      var i = 0; while (i < c.steps.length && c.steps[i].done) i++;
      runStep(i);
    }).catch(function () { try { sessionStorage.removeItem(KEY); } catch (e) {} showStart(null); });
  }

  function showPractice() {
    st.phase = "pre";
    var done = false;
    var heard = function () { if (done) return; done = true; lock(); say(C.say.practiceHeard).then(showDevice); };
    var phone = !!(window.matchMedia && matchMedia("(max-width: 640px)").matches);
    var words = phone ? ["top", "bottom"] : ["left", "right"];
    screen({ title: "A quick practice", sub: "Say \"" + words[0] + "\" or \"" + words[1] + "\"" + (phone ? "," : ", press an arrow key,") + " or tap a box. You can say \"what can I say\" at any time.",
      body: [pairBox(function (which) { return { kids: [el("p", { class: "pair-text", text: "This is the " + words[which === "left" ? 0 : 1] + " box." })] }; }, heard)],
      speak: phone ? C.say.practicePhone : C.say.practice, resume: showPractice,
      listen: function onAns(t, n, cmd) { if (cmd && /^(left|right|yes|same)$/.test(cmd.cmd) || /\b(left|right|top|bottom|ready)\b/.test(n)) heard(); else listen(onAns); } });
  }

  function showDevice() {
    var name = (C.deviceNames && C.deviceNames[st.deviceKey]) || "a computer";
    var line = C.say.deviceAsk.replace("{device}", name);
    var yes = function () { showGoal(); };
    var no = function () { fixDevice(); };
    st.phase = "pre";
    screen({ title: "Your device", sub: "You're using " + name + ". Is that right?", resume: showDevice, actions: [{ label: "Yes", primary: true, keyHint: "Space", onClick: yes }, { label: "No", onClick: no }], speak: line, listen: function onAns(t, n) { if (YES.test(n)) yes(); else if (NO.test(n)) no(); else say(C.say.cantHear).then(function () { listen(onAns); }); } });
  }
  function fixDevice() {
    function pickType(type) {
      var d = Object.assign({}, st.device, { type: type, touchOnly: type !== "computer" });
      api("POST", "/api/check/" + st.id + "/details", { device: d }).then(function (j) { st.device = j.check.device; st.plan = j.check.plan; showGoal(); }).catch(function (e) { alertNow(e.message); });
    }
    screen({ title: "Which are you using?", resume: fixDevice, actions: [{ label: "A phone", onClick: function () { pickType("phone"); } }, { label: "A tablet", onClick: function () { pickType("tablet"); } }, { label: "A computer", onClick: function () { pickType("computer"); } }], speak: C.say.deviceFix, listen: function (t, n) {
      if (/phone|iphone|android/.test(n)) pickType("phone"); else if (/tablet|ipad/.test(n)) pickType("tablet"); else if (/computer|laptop|desktop|mac|windows|chromebook/.test(n)) pickType("computer"); else say(C.say.cantHear).then(fixDevice);
    } });
  }

  function showGoal() {
    var input = el("input", { id: "goal-in", type: "text", maxlength: "500", autocomplete: "off", placeholder: "For example: read email" });
    function save(text) {
      var g = String(text || "").trim();
      st.goal = g;
      (g ? api("POST", "/api/check/" + st.id + "/details", { goal: g }) : Promise.resolve()).then(function () { runStep(0); }).catch(function () { runStep(0); });
    }
    screen({ title: "What would you like to do on this device?", resume: showGoal, sub: "For example: read email, video call family, or read the news. Or skip this.", body: [el("div", { class: "field" }, [el("label", { for: "goal-in", text: "What you'd like to do" }), input])],
      actions: [{ label: "Next", primary: true, onClick: function () { save(input.value); } }, { label: "Skip", onClick: function () { save(""); } }],
      onCommand: function (c) { if (c.cmd === "skip") { save(""); return true; } return false; },
      speak: C.say.goal, listen: function (t, n) { if (/^skip\b/.test(n)) save(""); else { input.value = t; save(t); } } });
  }

  // ------------------------------------------------------------- the tests
  function progressText(i) { return "Step " + (i + 1) + " of " + st.plan.length + " · " + NAMES[st.plan[i]]; }
  function runStep(i) {
    st.stepIdx = i;
    if (i >= st.plan.length) return showReview();
    st.phase = "test";
    st.resume = function () { runStep(st.stepIdx); };
    var setting = st.plan[i];
    api("POST", "/api/check/" + st.id + "/step", { setting: setting }).then(function (r) { handle(setting, r); }).catch(function (e) { alertNow(e.message); });
  }
  // One answer per screen: lock the controls until the next screen shows.
  function lock() {
    st.busy = true;
    [].forEach.call(document.querySelectorAll("#stage button, #stage input, #stage select"), function (n) { n.disabled = true; });
  }
  function send(setting, trial) {
    if (st.busy) return;
    lock();
    trial.ms = Date.now() - st.trialStart;
    trial.repeats = st.repeats;
    stopListening();
    api("POST", "/api/check/" + st.id + "/trial", { setting: setting, trial: trial }).then(function (r) { handle(setting, r); }).catch(function (e) {
      // Already answered (for example from another tab): pick up where the server is.
      if (e.status === 409) return runStep(st.stepIdx);
      st.busy = false; alertNow(e.message); runStep(st.stepIdx);
    });
  }
  var DONE_LINE = { speech_rate: "rateKept", magnification: "magDone", pictures: "picDone", contrast: "contrastDone", cursor: "cursorDone", bold: "boldDone" };
  function handle(setting, r) {
    if (r.done) {
      applyResult(r.result);
      var line = C.say[DONE_LINE[setting]];
      if (setting === "cursor" && r.result.recommended_value === "not_tested") line = "";
      return say(line).then(function () { runStep(st.stepIdx + 1); });
    }
    var p = r.prompt;
    var firstTime = !st.first[setting]; st.first[setting] = true;
    if (p.kind === "rate") return showRate(p, firstTime);
    if (p.kind === "word") return showWord(p, firstTime);
    if (p.kind === "picture") return showPicture(p, firstTime);
    if (p.kind === "pair_theme") return showPair(setting, p, firstTime, "theme");
    if (p.kind === "pair_bold") return showPair(setting, p, firstTime, "bold");
    if (p.kind === "find_pointer") return showFindPointer(p, firstTime);
    if (p.kind === "pair_cursor") return showPair(setting, p, firstTime, "cursor");
    if (p.kind === "pick_cursor_size" || p.kind === "pick_cursor_color") return showPointerTiles(p);
  }
  function applyResult(res) {
    var a = res.apply || {};
    var patch = {};
    ["textSize", "theme", "cursor", "cursorColor", "bold"].forEach(function (k) { if (a[k] !== undefined) patch[k] = a[k]; });
    if (Object.keys(patch).length) D.set(patch); else D.set({});
    if (a.rate) { st.rate = String(a.rate); saveRate(a.rate); }
    st.onN = null;
  }

  function showRate(p, firstTime) {
    st.rate = p.rate;
    var go = function (answer) { send("speech_rate", { answer: answer }); };
    var RATE_LIST = ["0.7", "0.85", "1", "1.2", "1.4"];
    var at = RATE_LIST.indexOf(String(p.rate)) + 1;
    screen({ title: "How fast should I talk?", sub: "This is " + (p.atSlowest ? "my slowest speed" : p.atFastest ? "my fastest speed" : "speed " + at + " of " + RATE_LIST.length) + ". Choose faster, slower, or keep this.", progress: progressText(st.stepIdx),
      actions: [{ label: "Keep this speed", primary: true, keyHint: "Space", onClick: function () { go("keep"); } }, { label: "Faster", disabled: p.atFastest, onClick: function () { go("faster"); } }, { label: "Slower", disabled: p.atSlowest, onClick: function () { go("slower"); } }],
      speak: firstTime ? C.say.rateIntro : C.say.rateNow, rate: p.rate,
      onCommand: function (c) {
        if (c.cmd === "voice" && c.value === "slower" && !p.atSlowest) { go("slower"); return true; }
        if (c.cmd === "voice" && c.value === "faster" && !p.atFastest) { go("faster"); return true; }
        if (c.cmd === "yes" || c.cmd === "same") { go("keep"); return true; }
        return false;
      },
      listen: function (t, n) {
        if (/\b(faster|quicker|speed up|quick)\b/.test(n)) go("faster");
        else if (/\b(slower|slow down|too fast)\b/.test(n)) go("slower");
        else if (/\b(keep|good|fine|perfect|that's it|this one|just right)\b/.test(n)) go("keep");
        else say(C.say.cantHear).then(function () { showRate(p, false); });
      } });
  }

  function showWord(p, firstTime) {
    // A short phrase to read out loud, or (with older wording) one word.
    var phrase = /\s/.test(String(p.word).trim());
    var what = phrase ? "phrase" : "word";
    var input = el("input", { id: "word-in", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", maxlength: "120", "aria-label": "Type the " + what + " you see" });
    var go = function (answer) { send("magnification", { answer: answer }); };
    var cant = function () { send("magnification", { cant_tell: true }); };
    var box = el("div", { class: "word-box" + (phrase ? " phrase-box" : ""), "aria-hidden": "true" }, [el("span", { class: "word", style: "font-size:" + p.px + "px", text: p.word })]);
    screen({ title: phrase ? "Read this out loud" : "What word do you see?", sub: (phrase ? "Read the phrase out loud, or type it." : "Say the word, or type it.") + " If you can't read it, that's fine: choose \"I can't tell\".", progress: progressText(st.stepIdx) + " — " + what + " " + p.n,
      body: [box, el("form", { class: "answer-row", onsubmit: function (e) { e.preventDefault(); if (input.value.trim()) go(input.value); } }, [el("label", { for: "word-in", text: "Type the " + what }), input, el("button", { type: "submit", class: "btn btn-primary", text: "Done" })])],
      actions: [{ label: "I can't tell", onClick: cant }],
      speak: phrase ? (firstTime ? C.say.readIntro : C.say.readNext) : (firstTime ? C.say.magIntro + " " + C.say.magWord : C.say.magWord),
      // Here "bigger" means "I can't read this one yet": the next one is bigger.
      onCommand: function (c) { if (c.cmd === "bigger" || c.cmd === "cant_tell") { cant(); return true; } return false; },
      listen: function (t, n) { if (/\b(can't tell|cannot tell|can't see|cannot see|can't read|don't know|no idea|not sure|nothing)\b/.test(n)) cant(); else go(t); } });
  }

  // The four pictures, drawn as thick outlines in the page's text color.
  var PIC_LABEL = { house: "House", apple: "Apple", circle: "Circle", square: "Square" };
  function pictureSvg(name, px) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", px); svg.setAttribute("height", px); svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "pic");
    var d = {
      house: "M12 50 L50 14 L88 50 M24 40 V88 H76 V40",
      apple: "M50 32 C34 18 10 26 12 52 C14 78 34 94 50 84 C66 94 86 78 88 52 C90 26 66 18 50 32 Z M50 32 C50 22 54 14 62 10",
      square: "M14 14 H86 V86 H14 Z",
    }[name];
    var shape;
    if (name === "circle") { shape = document.createElementNS(ns, "circle"); shape.setAttribute("cx", "50"); shape.setAttribute("cy", "50"); shape.setAttribute("r", "37"); }
    else { shape = document.createElementNS(ns, "path"); shape.setAttribute("d", d); }
    shape.setAttribute("fill", "none"); shape.setAttribute("stroke", "currentColor"); shape.setAttribute("stroke-width", "9"); shape.setAttribute("stroke-linejoin", "round"); shape.setAttribute("stroke-linecap", "round");
    svg.appendChild(shape);
    return svg;
  }
  function showPicture(p, firstTime) {
    var go = function (answer) { send("pictures", { answer: answer }); };
    var cant = function () { send("pictures", { cant_tell: true }); };
    var box = el("div", { class: "word-box pic-box" }, [pictureSvg(p.picture, p.px)]);
    var acts = (p.choices || ["house", "apple", "circle", "square"]).map(function (c, i) { return { label: PIC_LABEL[c] || c, keyHint: String(i + 1), onClick: function () { go(c); } }; });
    acts.push({ label: "I can't tell", onClick: cant });
    screen({ title: "What picture do you see?", sub: "A house, an apple, a circle or a square. Say it, or press its button. If you can't tell, that's fine: choose \"I can't tell\".", progress: progressText(st.stepIdx) + " — picture " + p.n,
      body: [box], actions: acts,
      onDigit: function (k) { var c = (p.choices || [])[k - 1]; if (c) go(c); },
      speak: firstTime ? C.say.picIntro : C.say.picNext,
      onCommand: function (c) { if (c.cmd === "bigger" || c.cmd === "cant_tell") { cant(); return true; } return false; },
      listen: function (t, n) {
        if (/\b(can't tell|cannot tell|can't see|cannot see|don't know|no idea|not sure|nothing)\b/.test(n)) cant(); else go(t);
      } });
  }

  var SAMPLE = "Lions Services helps people in the Charlotte area live well with vision loss.";
  function pointerSvg(size, color) {
    var px = { xl: 128, large: 64, "default": 28 }[size] || 28;
    var fills = { black: ["#000000", "#ffffff"], white: ["#ffffff", "#000000"], yellow: ["#ffd24a", "#000000"] }[color] || ["#000000", "#ffffff"];
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", px); svg.setAttribute("height", px); svg.setAttribute("viewBox", "0 0 32 32"); svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M2 2 L2 26 L8.5 20 L13 30 L17 28 L12.5 18.5 L21 18.5 Z");
    path.setAttribute("fill", fills[0]); path.setAttribute("stroke", fills[1]); path.setAttribute("stroke-width", "2"); path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }
  function showPair(setting, p, firstTime, kind) {
    var go = function (answer) { send(setting, { answer: answer }); };
    var side = function (which) {
      var value = which === "left" ? p.left : p.right;
      if (kind === "theme") return { cls: "sample theme-" + value, kids: [el("p", { class: "pair-text", text: SAMPLE })] };
      if (kind === "bold") return { cls: "sample weight-" + value, kids: [el("p", { class: "pair-text", text: SAMPLE })] };
      return { cls: "sample", kids: [el("div", { class: "pointer-art" }, [pointerSvg(p.size, value)])] };
    };
    var title = kind === "cursor" ? "Which pointer is easier to see?" : "Which is easier to read?";
    var speak = kind === "theme" ? (firstTime ? C.say.contrastIntro : C.say.contrastNext) : kind === "bold" ? C.say.boldIntro : C.say.cursorColor;
    screen({ title: title, sub: "Choose a side, or \"About the same\".", progress: progressText(st.stepIdx),
      body: [pairBox(side, go)],
      actions: [{ label: "About the same", onClick: function () { go("same"); } }, { label: "I can't tell", onClick: function () { go("same"); } }],
      speak: speak,
      listen: function (t, n, cmd) {
        if (cmd && cmd.cmd === "left") go("left"); else if (cmd && cmd.cmd === "right") go("right");
        else if (cmd && (cmd.cmd === "same" || cmd.cmd === "cant_tell")) go("same");
        else if (/\b(left|top)\b/.test(n)) go("left"); else if (/\b(right|bottom)\b/.test(n)) go("right");
        else if (/\b(same|no difference|either|both|can't tell|don't know)\b/.test(n)) go("same");
        else say(C.say.cantHear).then(function () { showPair(setting, p, false, kind); });
      } });
  }

  // Four pointers at once. Moving the mouse over a tile turns the real
  // pointer into that one; click a tile, press 1 to 4, or say its number or
  // name. Round 1 is sizes, round 2 is colors for the chosen size.
  var POINTER_NAMES = { "default": "Normal", large: "Large", xl: "Extra large", xxl: "Huge", black: "Black", white: "White", yellow: "Yellow", pink: "Pink" };
  var NUMBER_WORDS = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4 };
  function showPointerTiles(p) {
    var sizes = p.kind === "pick_cursor_size";
    var choices = p.choices || [];
    var dark = html.getAttribute("data-theme") !== "standard";
    var go = function (answer) { send("cursor", { answer: answer }); };
    var Core = window.V360DisplayCore;
    var tiles = choices.map(function (c, i) {
      var size = sizes ? c : p.size, color = sizes ? (dark ? "white" : "black") : c;
      var art = el("span", { class: "pointer-art", "aria-hidden": "true" });
      var px = Core.CURSOR_PX[size] || 32;
      art.innerHTML = Core.cursorSvg(Math.min(px, 128), color);
      return el("button", { type: "button", class: "cursor-try pick-tile" + (sizes ? "" : " pick-color-" + c), "data-size": size, "data-color": color, onclick: function () { go(c); } },
        [el("span", { class: "pick-num", text: String(i + 1) }), el("span", { class: "pick-name", text: POINTER_NAMES[c] || c }), art]);
    });
    var acts = sizes ? [{ label: "I can't see any of them", keyHint: "N", onClick: function () { go("none"); } }] : [];
    screen({ title: sizes ? "Which pointer size is easiest to see?" : "Which pointer color is easiest to see?",
      sub: "Move the mouse over each box: the pointer changes to that one. Then click the one you like, press its number, or say it.",
      progress: progressText(st.stepIdx),
      body: [el("div", { class: "pick-grid" }, tiles)], actions: acts,
      onN: sizes ? function () { go("none"); } : null,
      onDigit: function (k) { if (choices[k - 1]) go(choices[k - 1]); },
      speak: sizes ? C.say.cursorSizeIntro : C.say.cursorColorIntro,
      onCommand: function (c) { if (sizes && c.cmd === "cant_tell") { go("none"); return true; } return false; },
      listen: function onAns(t, n) {
        var words = n.split(" ");
        for (var i = 0; i < words.length; i++) if (NUMBER_WORDS[words[i]] && choices[NUMBER_WORDS[words[i]] - 1]) return go(choices[NUMBER_WORDS[words[i]] - 1]);
        var m = n.match(/\b([1-4])\b/); if (m && choices[Number(m[1]) - 1]) return go(choices[Number(m[1]) - 1]);
        if (sizes) {
          if (/\bhuge\b|\bbiggest\b|\blargest\b/.test(n)) return go("xxl");
          if (/\bextra large\b|\bextra\b/.test(n)) return go("xl");
          if (/\blarge\b|\bbig\b/.test(n)) return go("large");
          if (/\bnormal\b|\bsmall\b|\bregular\b/.test(n)) return go("default");
          if (/\b(can't see|cannot see|none|neither|nothing)\b/.test(n)) return go("none");
        } else {
          for (var j = 0; j < choices.length; j++) if (new RegExp("\\b" + choices[j] + "\\b").test(n)) return go(choices[j]);
          if (/\bpurple\b|\bmagenta\b/.test(n)) return go("pink");
        }
        say(C.say.cantHear).then(function () { listen(onAns); });
      } });
  }

  function showFindPointer(p, firstTime) {
    // Show the pointer at this size for the test only (not saved yet), in a
    // color that shows on this page's background.
    var theme = html.getAttribute("data-theme");
    html.setAttribute("data-cursor", p.size === "default" ? "default" : p.size);
    html.setAttribute("data-cursor-color", theme === "standard" ? "black" : "white");
    var lost = function () { send("cursor", { answer: "lost" }); };
    var target = el("button", { type: "button", class: "target", text: "Click here" });
    target.addEventListener("pointerdown", function (e) { if (e.pointerType === "mouse" || e.pointerType === "pen") { e.preventDefault(); send("cursor", { answer: "found" }); } });
    target.addEventListener("click", function (e) { if (e.detail === 0) alertNow("Use the mouse for this one, or press N if you can't find the pointer."); });
    screen({ title: "Can you find the mouse pointer?", onN: lost, sub: "Move the mouse until you see the pointer, then click the round button. If you can't find it, choose \"I can't find it\" or press N.", progress: progressText(st.stepIdx),
      body: [el("div", { class: "target-wrap" }, [target])],
      actions: [{ label: "I can't find it", onClick: lost, keyHint: "N" }],
      speak: firstTime ? C.say.cursorIntro : C.say.cursorNext,
      listen: function onAns(t, n) { if (/\b(can't find|cannot find|don't see|can't see|where is it|no)\b/.test(n)) lost(); else listen(onAns); } });
  }

  // ------------------------------------------------------------- the end
  function resultList(c) {
    return el("ul", { class: "results" }, c.steps.filter(function (s) { return s.done; }).map(function (s) {
      return el("li", null, [el("span", { class: "k", text: NAMES[s.setting] }), s.summary]);
    }));
  }
  function showReview() {
    st.phase = "review";
    st.resume = showReview;
    api("GET", "/api/check/" + st.id).then(function (j) {
      var keep = function () { showContact(j.check); };
      screen({ title: "Your new settings", sub: "These are already on. Keep them, or change any of them later in Display settings.", body: [resultList(j.check)],
        actions: [{ label: "Keep these", primary: true, keyHint: "Space", onClick: keep }],
        speak: C.say.review, listen: function onAns(t, n) { if (/\b(keep|yes|good|done|fine|ok|okay)\b/.test(n)) keep(); else listen(onAns); } });
    }).catch(function (e) { alertNow(e.message); });
  }

  function showContact(c) {
    var yes = function () { contactForm(); };
    var no = function () { finish({ consent: false }); };
    screen({ title: "Would you like Lions Services to contact you?", sub: "A team member can help you set up these settings on your own phone or computer.", actions: [{ label: "Yes, please", primary: true, onClick: yes }, { label: "No, thanks", onClick: no }],
      speak: C.say.contactAsk, listen: function onAns(t, n) { if (YES.test(n)) yes(); else if (NO.test(n)) no(); else listen(onAns); } });
  }
  function contactForm() {
    function field(id, label, attrs) { return el("div", { class: "field" }, [el("label", { for: id, text: label }), el("input", Object.assign({ id: id, type: "text" }, attrs || {}))]); }
    var ages = [["", "Prefer not to say"], ["under_18", "Under 18"], ["18_34", "18–34"], ["35_54", "35–54"], ["55_64", "55–64"], ["65_74", "65–74"], ["75_plus", "75 or older"]];
    var form = el("form", { id: "contact-form", novalidate: true }, [
      field("c-name", "First name (optional)", { autocomplete: "given-name", maxlength: "80" }),
      field("c-phone", "Phone number", { type: "tel", autocomplete: "tel", inputmode: "tel", maxlength: "30" }),
      field("c-email", "Email (optional)", { type: "email", autocomplete: "email", maxlength: "200" }),
      el("label", { class: "check-line" }, [el("input", { type: "checkbox", id: "c-call" }), "Please call me"]),
      el("div", { class: "field" }, [el("label", { for: "c-age", text: "Age range (optional)" }), el("select", { id: "c-age" }, ages.map(function (a) { return el("option", { value: a[0], text: a[1] }); }))]),
      field("c-zip", "ZIP code (optional)", { inputmode: "numeric", maxlength: "5", autocomplete: "postal-code" }),
      el("label", { class: "check-line" }, [el("input", { type: "checkbox", id: "c-consent" }), "I give Lions Services permission to contact me about these settings."]),
      el("p", { id: "c-err", class: "danger-text", role: "alert", hidden: true }),
    ]);
    function submit() {
      var err = $("c-err");
      var phone = $("c-phone").value.trim(), email = $("c-email").value.trim();
      if (!phone && !email) { err.hidden = false; err.textContent = "⚠ Please give a phone number or an email address."; $("c-phone").focus(); return; }
      if (!$("c-consent").checked) { err.hidden = false; err.textContent = "⚠ Please tick the permission box, or go back and choose No, thanks."; $("c-consent").focus(); return; }
      finish({ consent: true, contact: { first_name: $("c-name").value, phone: phone, email: email }, wants_call: $("c-call").checked, age_range: $("c-age").value || null, zip: $("c-zip").value.trim() || null });
    }
    form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
    screen({ title: "How should we contact you?", sub: "Only Lions Services staff see this.", body: [form], actions: [{ label: "Send", primary: true, onClick: submit }, { label: "Back", onClick: function () { showContact(); } }], focusEl: null });
    try { $("c-name").focus(); } catch (e) {}
  }

  function finish(body) {
    api("POST", "/api/check/" + st.id + "/finish", body).then(function (j) { st.closed = true; showResults(j.check); }).catch(function (e) { alertNow(e.message); });
  }

  function summaryText(c) {
    var lines = ["My Vision 360 screen settings (" + new Date().toLocaleDateString() + "):"];
    c.steps.forEach(function (s) { if (s.done) lines.push("- " + NAMES[s.setting] + ": " + s.summary); });
    if (c.goal) lines.push("What I'd like to do: " + c.goal);
    lines.push("My code for next time: " + c.code);
    return lines.join("\n");
  }
  // ---- Set this up on your own device: the steps for each setting that changed.
  function guideKeys(c) {
    var set = c.settings || {}, keys = [];
    var mag = c.steps.filter(function (s) { return s.setting === "magnification"; })[0];
    if (set.textSize && set.textSize !== "100") keys.push(["textSize", "Bigger text"]);
    if (mag && (mag.flags || []).indexOf("needs_magnifier_or_zoom") !== -1) keys.push(["zoom", "Zoom in further"]);
    if (set.theme && set.theme !== "standard") keys.push(["contrast", "Colors and contrast"]);
    if (set.bold === "on") keys.push(["bold", "Bold text"]);
    keys.push(["speech", "Speaking speed"]);
    if (set.cursor && set.cursor !== "default") keys.push(["pointer", "A bigger pointer"]);
    return keys;
  }
  function guideSection(c) {
    var wrap = el("section", { class: "guide", "aria-labelledby": "guide-h" });
    var G = C.guides || {};
    var os = c.device && G[c.device.os] ? c.device.os : null;
    function render(sys) {
      wrap.textContent = "";
      var g = G[sys];
      wrap.appendChild(el("h2", { id: "guide-h", text: "Set this up on your " + g.name }));
      var all = [];
      guideKeys(c).forEach(function (k) {
        var steps = g[k[0]];
        if (!steps || !steps.length) return;
        wrap.appendChild(el("h3", { text: k[1] }));
        wrap.appendChild(el("ol", null, steps.map(function (x) { all.push(x); return el("li", { text: x }); })));
      });
      var row = el("div", { class: "stage-actions" });
      row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: "Read the steps aloud", onclick: function () { readSteps(all); } }));
      wrap.appendChild(row);
      wrap.appendChild(el("p", { class: "hint", text: "Menus can move a little between system versions. Lions Services can help: 704-921-1527." }));
      var other = el("p", { class: "hint" }, ["Different device? "]);
      Object.keys(G).filter(function (k) { return k.charAt(0) !== "_" && k !== sys; }).forEach(function (k, i) {
        if (i) other.appendChild(document.createTextNode(" · "));
        other.appendChild(el("button", { type: "button", class: "linkish", text: G[k].name, onclick: function () { render(k); } }));
      });
      wrap.appendChild(other);
    }
    if (os) render(os);
    else {
      wrap.appendChild(el("h2", { id: "guide-h", text: "Set this up on your own device" }));
      wrap.appendChild(el("p", { text: "Which do you use?" }));
      var row = el("div", { class: "stage-actions" });
      Object.keys(G).filter(function (k) { return k.charAt(0) !== "_"; }).forEach(function (k) { row.appendChild(el("button", { type: "button", class: "btn btn-secondary", text: G[k].name, onclick: function () { render(k); } })); });
      wrap.appendChild(row);
    }
    return wrap;
  }
  // One step at a time: "next" (or Space, or the Next button) moves on.
  function readSteps(steps) {
    var i = 0;
    var bar = el("div", { class: "stage-actions", id: "step-bar" });
    var next = el("button", { type: "button", class: "btn btn-primary", text: "Next step" });
    var stop = el("button", { type: "button", class: "btn btn-secondary", text: "Stop reading" });
    bar.appendChild(next); bar.appendChild(stop);
    var old = $("step-bar"); if (old) old.remove();
    $("stage-body").appendChild(bar);
    primary = next;
    function done() { bar.remove(); primary = null; stopListening(); }
    function one() {
      if (i >= steps.length) { say(C.say.guideDone); return done(); }
      var t = steps[i++];
      say(t).then(function () {
        listen(function onAns(x, n) {
          if (/\b(next|ok|okay|done|go on|continue)\b/.test(n)) one();
          else if (/\b(stop|that's enough|quit)\b/.test(n)) done();
          else listen(onAns);
        });
      });
    }
    next.addEventListener("click", one);
    stop.addEventListener("click", function () { stopSpeaking(); done(); });
    $("voice-row").hidden = st.sr;
    say(C.say.guideIntro).then(one);
  }

  // ---- Services that can help, from the directory's own data.
  function suggestSection(c) {
    var wrap = el("section", { class: "suggest", "aria-labelledby": "suggest-h" }, [el("h2", { id: "suggest-h", text: "Services that can help" })]);
    var mag = c.steps.filter(function (s) { return s.setting === "magnification"; })[0];
    var pics = c.steps.filter(function (s) { return s.setting === "pictures"; })[0];
    var needZoom = (mag && (mag.flags || []).some(function (f) { return f === "needs_magnifier_or_zoom" || f === "could_not_read_largest"; })) || (pics && (pics.flags || []).indexOf("could_not_see_largest_picture") !== -1);
    var cats = needZoom ? ["low_vision_clinic", "assistive_technology"] : ["assistive_technology"];
    fetch("/data/organizations.json").then(function (r) { return r.json(); }).then(function (orgs) {
      function rank(o) {
        var a = o.service_area || {};
        if ((a.counties || []).indexOf("Mecklenburg") !== -1) return 0;
        return a.verdict === "in_area" ? 1 : 2;
      }
      var shown = {};
      cats.forEach(function (cat) {
        var list = orgs.filter(function (o) {
          var a = o.service_area || {};
          return (o.categories || []).indexOf(cat) !== -1 && (o.categories || []).indexOf("veterans") === -1 && a.verdict !== "out_of_area" && a.verdict !== "statewide_travel_required" && !shown[o.id];
        }).sort(function (x, y) { return rank(x) - rank(y) || (y.id === "lions-services") - (x.id === "lions-services"); }).slice(0, 2);
        if (!list.length) return;
        wrap.appendChild(el("p", { class: "hint", text: (C.suggest && C.suggest[cat]) || "" }));
        wrap.appendChild(el("ul", { class: "results" }, list.map(function (o) {
          shown[o.id] = true;
          var ct = o.contacts || {};
          return el("li", null, [
            el("span", { class: "k" }, [el("a", { href: "/directory/#org-" + encodeURIComponent(o.id), text: o.name })]),
            o.one_line || "",
            ct.general_phone && /^[0-9 ()+\-]{7,20}$/.test(ct.general_phone.trim()) ? el("span", { class: "org-phone" }, [" Phone: ", el("a", { href: "tel:" + ct.general_phone.replace(/[^0-9+]/g, ""), text: ct.general_phone })]) : null,
          ]);
        })));
      });
      wrap.appendChild(el("p", null, ["To find more, ", el("a", { href: "/demo/", text: "talk to the Resource Assistant" }), " or browse the ", el("a", { href: "/directory/", text: "Org Directory" }), "."]));
    }).catch(function () { wrap.appendChild(el("p", null, [el("a", { href: "/directory/", text: "Browse the Org Directory" })])); });
    return wrap;
  }

  function showResults(c) {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    stopListening();
    st.phase = "post"; st.closed = c.status !== "started";
    var ended = c.status === "ended";
    var copyMsg = el("p", { class: "hint", role: "status", id: "copy-msg" });
    var body = [
      c.goal ? el("p", null, [el("strong", { text: "What you'd like to do: " }), c.goal]) : null,
      resultList(c),
      el("p", { text: "Your code for next time (to take the check again and see what changed):" }),
      el("p", { class: "code-box", text: c.code }),
      copyMsg,
      el("p", { class: "hint print-note", text: "Printing or saving as a PDF uses your colors and text size." }),
      guideSection(c),
      suggestSection(c),
    ];
    screen({ title: ended ? "Your results so far" : "Your screen settings", resume: null,
      sub: ended ? "You ended early. What you did is saved, and Lions Services staff will see it. These settings are on now, on this device." : "These settings are on now, on this device. Lions Services staff will see your results" + (c.status === "finished" ? "." : " when you finish."), body: body,
      actions: [
        { label: "Print or save as PDF", primary: true, onClick: function () { window.print(); } },
        { label: "Copy to share", onClick: function () { var t = summaryText(c); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { copyMsg.textContent = "✓ Copied. Paste it into an email or message to share it."; }).catch(function () { copyMsg.textContent = t; }); } },
      ],
      speak: ended ? null : C.say.finished });
    $("voice-row").hidden = true;
  }

  // ------------------------------------------------------------- the shell
  // Two halves to choose from (top and bottom on phones). make(which) gives
  // { cls, kids } for each half; tapping or clicking a half picks it.
  function pairBox(make, onPick) {
    return el("div", { class: "pair" }, ["left", "right"].map(function (which) {
      var o = make(which) || {};
      return el("button", { type: "button", class: "pair-side " + (o.cls || ""), "data-side": which, onclick: function () { onPick(which); } },
        [el("span", { class: "pair-tag" }, [el("span", { class: "tag-wide", text: which === "left" ? "Left" : "Right" }), el("span", { class: "tag-narrow", text: which === "left" ? "Top" : "Bottom" })])].concat(o.kids || []));
    }));
  }

  // Step dots in the top bar: one per test, done ones filled.
  function renderDots() {
    if (C) syncMenu();
    var ol = $("a-dots"); ol.textContent = "";
    if (st.phase !== "test" && st.phase !== "review") return;
    st.plan.forEach(function (setting, i) {
      ol.appendChild(el("li", { class: i < st.stepIdx || st.phase === "review" ? "done" : i === st.stepIdx ? "now" : "" }));
    });
  }

  // Say a short reply, then go back to listening for the same screen.
  function after(line) { return say(line).then(function () { if (waiting && !st.busy) listen(waiting); }); }

  var SIZE_STEPS = ["100", "125", "150", "200", "300", "400"];
  var CURSOR_STEPS = ["default", "large", "xl"];
  var RATE_STEPS = ["0.7", "0.85", "1", "1.2", "1.4"];
  var THEME_LINE = { standard: "themeStandard", blue: "themeBlue", dark: "themeDark", high: "themeHigh" };

  // A setting changed outside a test: shown now, and kept for staff.
  function record(setting, value, via) {
    if (!st.id || st.closed) return;
    api("POST", "/api/check/" + st.id + "/setting", { setting: setting, value: String(value), via: via, step: st.phase === "test" ? st.plan[st.stepIdx] : null }).catch(function () {});
  }
  function change(patch, via) {
    var before = D.get(), now = D.set(patch);
    Object.keys(patch).forEach(function (k) { if (before[k] !== now[k]) record(k, now[k], via); });
    syncMenu();
  }
  function voice(v, via, quiet) {
    var line;
    if (v === "louder" || v === "softer") {
      var was = st.volume;
      st.volume = Math.round(Math.max(0.4, Math.min(1, st.volume + (v === "louder" ? 0.2 : -0.2))) * 10) / 10;
      line = st.volume === was ? (v === "louder" ? "voiceLoudest" : "voiceSoftest") : v === "louder" ? "voiceLouder" : "voiceSofter";
    } else {
      var i = RATE_STEPS.indexOf(String(st.rate)), j = v === "slower" ? i - 1 : i + 1;
      if (j < 0) line = "voiceSlowest";
      else if (j >= RATE_STEPS.length) line = "voiceFastest";
      else { st.rate = RATE_STEPS[j]; saveRate(st.rate); record("rate", st.rate, via); line = v === "slower" ? "voiceSlower" : "voiceFaster"; }
    }
    syncMenu();
    return quiet ? Promise.resolve() : after(C.say[line]);
  }
  // Commands that work at any step.
  function command(c, via) {
    var s = D.get(), i, j;
    switch (c.cmd) {
      case "repeat": st.repeats++; return after(st.lastSay);
      case "stop_listening": st.listenOn = false; syncListenBtn(); return say(C.say.stopped);
      case "help": return after(C.say.help);
      case "menu": return c.value === "hide" ? closeMenu(true) : openMenu(true);
      case "end": return askEnd();
      case "back": return goBack();
      case "skip": return skipStep();
      case "voice": return voice(c.value, via);
      case "bigger": case "smaller":
        i = SIZE_STEPS.indexOf(s.textSize); j = c.cmd === "bigger" ? i + 1 : i - 1;
        if (j >= SIZE_STEPS.length) return after(C.say.sizeMax);
        if (j < 0) return after(C.say.sizeMin);
        change({ textSize: SIZE_STEPS[j] }, via);
        return after(C.say[c.cmd === "bigger" ? "sizeUp" : "sizeDown"]);
      case "too_bright":
        j = { standard: "blue", blue: "dark" }[s.theme];
        if (!j) return after(C.say.themeAlready);
        change({ theme: j }, via);
        return after(C.say[THEME_LINE[j]]);
      case "theme":
        if (s.theme === c.value) return after(C.say.themeAlready);
        change({ theme: c.value }, via);
        return after(C.say[THEME_LINE[c.value]]);
      case "bold":
        change({ bold: c.value }, via);
        return after(C.say[c.value === "on" ? "boldOn" : "boldOff"]);
      case "pointer":
        i = CURSOR_STEPS.indexOf(s.cursor); j = c.value === "bigger" ? i + 1 : i - 1;
        if (j >= CURSOR_STEPS.length) return after(C.say.pointerMax);
        if (j < 0) return after(C.say.pointerMin);
        change({ cursor: CURSOR_STEPS[j] }, via);
        return after(C.say[c.value === "bigger" ? "pointerBigger" : "pointerSmaller"]);
    }
    return Promise.resolve();
  }

  // ---- the menu (non-modal: the test keeps listening while it's open)
  function syncMenu() {
    var cur = D.get();
    [].forEach.call(document.querySelectorAll("#a-menu [data-set]"), function (b) {
      b.setAttribute("aria-pressed", String(String(cur[b.getAttribute("data-set")]) === b.getAttribute("data-value")));
    });
    var at = RATE_STEPS.indexOf(String(st.rate));
    $("m-rate").textContent = "Speed: " + (at <= 0 ? "slowest" : at >= RATE_STEPS.length - 1 ? "fastest" : (at + 1) + " of " + RATE_STEPS.length);
    $("m-slower").disabled = at <= 0;
    $("m-faster").disabled = at >= RATE_STEPS.length - 1;
    $("m-pause").setAttribute("aria-pressed", String(!st.listenOn));
    $("m-pause").textContent = st.listenOn ? "Pause listening" : "Start listening";
    $("m-pointer").hidden = !!(st.device && st.device.touchOnly);
    var inTests = !!st.id && !st.closed && (st.phase === "test" || st.phase === "review");
    $("m-back").disabled = !inTests || (st.phase === "test" && st.stepIdx === 0);
    $("m-skip").disabled = !st.id || st.closed || st.phase !== "test";
  }
  function openMenu(spoken) {
    $("a-menu").hidden = false;
    $("menu-btn").setAttribute("aria-expanded", "true");
    syncMenu();
    try { $("a-menu").focus(); } catch (e) {}
    return spoken ? after(C.say.menuOpen) : Promise.resolve();
  }
  function closeMenu(spoken) {
    var wasOpen = !$("a-menu").hidden;
    $("a-menu").hidden = true;
    $("menu-btn").setAttribute("aria-expanded", "false");
    if (wasOpen) { try { $("menu-btn").focus(); } catch (e) {} }
    return spoken ? after(C.say.menuClosed) : Promise.resolve();
  }
  $("menu-btn").addEventListener("click", function () { if ($("a-menu").hidden) openMenu(false); else closeMenu(false); });
  $("m-close").addEventListener("click", function () { closeMenu(false); });
  $("a-menu").addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-set]") : null;
    if (!b) return;
    var patch = {}; patch[b.getAttribute("data-set")] = b.getAttribute("data-value");
    change(patch, "menu");
  });
  $("m-slower").addEventListener("click", function () { voice("slower", "menu", true); });
  $("m-faster").addEventListener("click", function () { voice("faster", "menu", true); });
  $("m-repeat").addEventListener("click", function () { st.repeats++; after(st.lastSay); });
  $("m-pause").addEventListener("click", function () { st.listenOn = !st.listenOn; syncListenBtn(); syncMenu(); if (st.listenOn && waiting) listen(waiting); });
  $("m-end").addEventListener("click", function () { closeMenu(false); askEnd(); });
  $("m-back").addEventListener("click", function () { closeMenu(false); goBack(); });
  $("m-reset").addEventListener("click", function () {
    var before = D.get(), now = D.reset();
    Object.keys(now).forEach(function (k) { if (before[k] !== now[k]) record(k, now[k], "menu"); });
    syncMenu();
    announce("Display settings reset to the standard look on this device.");
  });
  $("m-skip").addEventListener("click", function () { closeMenu(false); skipStep(); });

  // ---- go back, skip, end
  function goBack() {
    var prev = st.phase === "review" ? st.plan.length - 1 : st.phase === "test" ? st.stepIdx - 1 : -1;
    if (!st.id || st.closed || prev < 0) return after(C.say.backFirst);
    stopListening();
    var setting = st.plan[prev];
    return api("POST", "/api/check/" + st.id + "/back", { setting: setting }).then(function () {
      st.first[setting] = false;
      return say(C.say.back);
    }).then(function () { runStep(prev); }).catch(function (e) { alertNow(e.message); });
  }
  function skipStep() {
    if (!st.id || st.closed || st.phase !== "test") return after(C.say.notInTest);
    var setting = st.plan[st.stepIdx];
    stopListening(); lock();
    return api("POST", "/api/check/" + st.id + "/skip", { setting: setting }).then(function () { return say(C.say.skipped); })
      .then(function () { runStep(st.stepIdx + 1); })
      .catch(function (e) { if (e.status === 409) return runStep(st.stepIdx + 1); st.busy = false; alertNow(e.message); });
  }
  function askEnd() {
    if (!st.id || st.closed) return after(C.say.nothingToEnd);
    closeMenu(false);
    stopListening();
    var resume = st.resume;
    var phase = st.phase;
    return api("GET", "/api/check/" + st.id).then(function (j) {
      var c = j.check;
      var done = c.steps.filter(function (x) { return x.done; });
      var notYet = c.steps.filter(function (x) { return !x.done; });
      var keep = function () { st.phase = phase; say(C.say.keepGoing).then(function () { if (resume) resume(); else runStep(st.stepIdx); }); };
      screen({ title: "End the assessment now?", sub: "Everything you've done so far is saved for Lions Services staff.",
        body: [
          el("h2", { class: "a-sub-h", text: "Saved" }),
          done.length ? resultList(c) : el("p", { text: "No tests finished yet." }),
          notYet.length ? el("h2", { class: "a-sub-h", text: "Not reached" }) : null,
          notYet.length ? el("ul", { class: "a-not-reached" }, notYet.map(function (x) { return el("li", { text: NAMES[x.setting] }); })) : null,
        ],
        actions: [{ label: "End and save", primary: true, keyHint: "Space", onClick: endNow }, { label: "Keep going", onClick: keep }],
        speak: C.say.endAsk,
        onCommand: function (k) {
          if (k.cmd === "end" || k.cmd === "yes") { endNow(); return true; }
          if (k.cmd === "no") { keep(); return true; }
          return false;
        },
        listen: function onAns(t, n) { if (/\b(keep going|keep|continue|carry on|go on)\b/.test(n)) keep(); else listen(onAns); } });
    }).catch(function (e) { alertNow(e.message); });
  }
  function endNow() {
    if (st.busy) return;
    lock();
    var at = st.phase === "test" ? st.plan[st.stepIdx] : undefined;
    api("POST", "/api/check/" + st.id + "/end", { at: at }).then(function (j) {
      st.closed = true;
      say(C.say.ended);
      showResults(j.check);
    }).catch(function (e) {
      if (e.status === 409) return api("GET", "/api/check/" + st.id).then(function (j) { showResults(j.check); });
      st.busy = false; alertNow(e.message);
    });
  }

  function listCommands() {
    var dl = $("m-commands"); dl.textContent = "";
    (C.commands || []).forEach(function (row) { dl.appendChild(el("dt", { text: row[0] })); dl.appendChild(el("dd", { text: row[1] })); });
  }

  // ------------------------------------------------------------- start
  Promise.all([
    fetch("/data/screen-check.json", { cache: "no-store" }).then(function (r) { return r.json(); }),
    fetch("/api/site", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return {}; }),
    fetch("/api/health").then(function (r) { return r.json(); }).catch(function () { return {}; }),
    // Staff trying the test before it's live: are they signed in to the admin?
    PREVIEW ? fetch("/api/admin/settings", { cache: "no-store", credentials: "same-origin" }).then(function (r) { return r.ok; }).catch(function () { return false; }) : Promise.resolve(false),
  ]).then(function (all) {
    C = all[0];
    listCommands();
    syncMenu();
    natural = !!(all[2].tts && all[2].tts.provider === "elevenlabs");
    var live = !!(all[1].features && all[1].features.screenCheck);
    if (!live && PREVIEW && all[3]) {
      // Try it: a note at the top says the public can't see this yet.
      var note = el("p", { class: "a-preview", role: "note", text: "Preview for staff: the public still sees the question-and-answer Vision Assessment until you make this test live on the Workflows page." });
      document.body.insertBefore(note, document.body.firstChild);
      live = true;
    }
    if (!live) {
      // The Vision Assessment never shows a closed page: until the live test
      // is made live on the Workflows page, it opens the question-and-answer version.
      if (ASSESS) { location.replace(INTERVIEW_URL); return; }
      screen({ title: "Screen settings check", sub: "This check isn't open yet.", body: [el("p", null, [el("a", { href: "/", text: "Go to the Vision 360 home page" })])], focus: false });
      return;
    }
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) {}
    showStart(saved && saved.id ? saved : null);
  }).catch(function () {
    $("stage-sub").textContent = "The check couldn't load. Please try again in a moment.";
  });
  window.addEventListener("pagehide", function () { stopSpeaking(); stopListening(); });
})();
