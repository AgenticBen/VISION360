/* The assistant's own fixed lines on the Resource Assistant and Vision
   Assessment pages: the welcome, the display check and the replies to
   "bigger text", "less contrast" and so on.

   The page builds what it says from here, and the server reads this same
   file (server/lib/phrases.mjs) to list every line it may voice with the
   natural (ElevenLabs) voice. Only these exact lines can be voiced, so the
   endpoint can't be used to turn arbitrary text into speech. */
(function (root) {
  "use strict";
  var P = {};
  P.SIZES = ["100", "125", "150", "200"];
  P.THEMES = ["standard", "dark", "high"];
  P.SIZE_WORDS = { "100": "regular size", "125": "large", "150": "extra large", "200": "the largest size" };
  P.THEME_WORDS = { standard: "standard colors, dark text on white", dark: "dark colors, light text on a dark background", high: "high contrast, yellow and white on black" };
  P.ASKS = {
    demo: { q: "Would you like help understanding the services available?", sub: "You can tell me the answer whenever you're ready!" },
    assessment: { q: "Would you like to check how your vision affects everyday things?", sub: "It takes about five minutes, and it isn't a medical exam. You can tell me the answer whenever you're ready!" }
  };

  function lower(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
  P.displayNow = function (size, theme) { return "The text is " + P.SIZE_WORDS[size] + ", with " + P.THEME_WORDS[theme] + "."; };
  P.welcome = function (ask, size, theme) {
    return P.displayNow(size, theme) + " If you'd like the text bigger or smaller, or less contrast, just tell me. " + ask.q + " " + ask.sub;
  };
  P.listening = "I'm listening. Tell me if you'd like the text bigger, smaller or with less contrast, or say yes to begin.";
  P.notReady = "That's okay. I'm here whenever you're ready. Just say yes, or tell me if you'd like the text bigger or smaller.";
  P.fine = function (ask) { return "Good. " + ask.q + " Just say yes when you're ready."; };
  P.better = function (ask) { return " Is that better? When you're ready, " + lower(ask.q); };

  // Replies to display commands, by situation.
  P.say = {
    sizeTo: function (size) { return "Done. The text is now " + P.SIZE_WORDS[size] + ", " + size + " percent."; },
    sizeMax: "The text is already at the largest size. Your device's zoom can make it bigger still.",
    sizeMin: "The text is already at the regular size.",
    highAlready: "The colors are already high contrast.",
    toHigh: "Done. I've switched to high contrast, yellow and white on black.",
    darkAlready: "The colors are already dark.",
    toDark: "Done. I've switched to dark colors.",
    moreToDark: "Done. I've raised the contrast a step, to dark colors: light text on a dark background. Say more contrast again for the highest contrast.",
    lessFromHigh: "Done. I've lowered the contrast to dark colors: light text on a dark background. Say less contrast again for dark text on white.",
    lessFromDark: "Done. I've switched to standard colors: dark text on white.",
    lessAlready: "These are already the standard colors, dark text on white."
  };

  // Feedback at the end of a conversation.
  P.feedback = {
    ask: "Before you go, would you tell us how this went, and what would make it better? You can talk, type, or say skip.",
    heard: "Here's what I heard. You can change it, then press Send, or say send.",
    rate: "Thank you. How helpful was this, from 1 to 5?",
    rateOnly: "How helpful was this, from 1 to 5? You can say a number, or say skip.",
    rateAgain: "Sorry, I didn't catch that. Say a number from 1 to 5, or say skip.",
    thanks: "Thank you. Your feedback helps Lions Services make this better.",
    skipped: "No problem. Thank you for using Vision 360."
  };

  // A spoken or typed rating: "4", "four", "five out of five", "a three".
  // Returns 1-5, "skip", or null when it isn't clear.
  P.parseRating = function (raw) {
    var t = String(raw || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (/^(skip|no thanks?|no thank you|pass|rather not|i'd rather not|none)\b/.test(t)) return "skip";
    var words = { one: 1, two: 2, three: 3, four: 4, five: 5, won: 1, to: null, too: null, for: 4, fore: 4 };
    var found = [];
    t.split(" ").forEach(function (w) { if (/^[1-5]$/.test(w)) found.push(Number(w)); else if (words[w]) found.push(words[w]); });
    if (/\bout of\b/.test(t) && found.length >= 1) return found[0];
    if (found.length === 1) return found[0];
    return null;
  };

  // Every line above, in every form the pages can say it.
  P.all = function () {
    var out = [P.listening, P.notReady];
    Object.keys(P.feedback).forEach(function (k) { out.push(P.feedback[k]); });
    var says = [P.say.sizeMax, P.say.sizeMin, P.say.highAlready, P.say.toHigh, P.say.darkAlready, P.say.toDark, P.say.moreToDark, P.say.lessFromHigh, P.say.lessFromDark, P.say.lessAlready];
    P.SIZES.forEach(function (s) { says.push(P.say.sizeTo(s)); });
    says.forEach(function (x) { out.push(x); });
    Object.keys(P.ASKS).forEach(function (k) {
      var ask = P.ASKS[k];
      out.push(P.fine(ask));
      says.forEach(function (x) { out.push(x + P.better(ask)); });
      P.SIZES.forEach(function (s) { P.THEMES.forEach(function (t) { out.push(P.welcome(ask, s, t)); }); });
    });
    return out;
  };

  root.V360_PHRASES = P;
})(typeof window !== "undefined" ? window : globalThis);
