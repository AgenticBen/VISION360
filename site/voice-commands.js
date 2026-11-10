/* What someone says during the Vision Assessment, turned into one command.

   One place for every spoken command, so "bigger", "blue background" or
   "show menu" work the same at every step. A command must be most of what
   was said ("bigger", "make it bigger please"), so a phrase being read
   aloud, like "turn left at the light", never changes a setting.

   parse(text) returns { cmd, value } or null:
     left | right | same | cant_tell        answers to a pair (top/bottom on phones)
     bigger | smaller                        text size, one step
     theme: standard | blue | dark | high    "white / blue / black background", "yellow on black"
     too_bright
     bold: on | off
     highlight: on | off                    light up each word as it's spoken
     scroll: down | up | top | bottom
     read: pause | continue | again         the page being read aloud
     pointer: bigger | smaller
     voice: slower | faster | louder | softer
     repeat | back | skip | help | stop_listening | end
     menu: show | hide
     yes | no

   Loaded by the assessment page (window.V360Commands) and by the tests. */
(function (root) {
  "use strict";
  var C = {};

  C.norm = function (s) {
    return String(s || "").toLowerCase()
      .replace(/[‘’']/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ").trim();
  };

  // Polite words around a command: "please", "can you", "I'd like", "thanks".
  var LEAD = /^(ok(ay)? |um+ |uh+ |so |and |please |can you |could you |would you |can we |could we |i want |i want to |i would like |id like |i need |lets |let us |now |just )+/;
  var TAIL = /( please| thanks| thank you| now| then| for me| again please)+$/;
  function strip(t) {
    var prev;
    do { prev = t; t = t.replace(LEAD, "").replace(TAIL, "").trim(); } while (t !== prev);
    return t;
  }

  var ONE = "( one| side| panel| picture| choice)?";
  var RULES = [
    // Ending, menu and help come first: they matter most.
    [/^(end|end (it|now|this|the test|the assessment|the check)|stop the (test|assessment|check)|finish (now|early)|im done|i am done|quit|exit)$/, "end"],
    [/^(what can i say|what do i say|what can i do|help|commands|list (the )?commands|what are (the|my) (commands|choices|options))$/, "help"],
    [/^((show|open)( the| me the)? (menu|settings)|menu|settings)$/, "menu", "show"],
    [/^((hide|close)( the)? (menu|settings)|hide|close)$/, "menu", "hide"],
    [/^(stop listening|stop the (microphone|mic)|(microphone|mic) off|turn off the (microphone|mic))$/, "stop_listening"],
    [/^(repeat|repeat (that|it|the question)|say (that|it) again|again|what|pardon|sorry|come again|once more)$/, "repeat"],
    [/^(go back|back|previous|previous (step|test|one)|last (step|test|one)|undo)$/, "back"],
    [/^(skip|skip (this|it|this one|this test|this step|the test|the pointer|the pointer test)|next test)$/, "skip"],

    // The pointer before text size: "bigger pointer" is not "bigger".
    [/^((make )?(the )?(pointer|cursor|mouse|arrow) (bigger|larger)|(bigger|larger) (pointer|cursor|mouse|arrow))$/, "pointer", "bigger"],
    [/^((make )?(the )?(pointer|cursor|mouse|arrow) smaller|smaller (pointer|cursor|mouse|arrow))$/, "pointer", "smaller"],

    // The voice.
    [/^((talk|speak|go|read) (slower|more slowly)|slower|slow down|too fast|youre too fast)$/, "voice", "slower"],
    [/^((talk|speak|go|read) faster|faster|speed up|too slow|quicker)$/, "voice", "faster"],
    [/^((talk|speak) (louder|up)|louder|speak up|turn (it )?up|volume up|i cant hear( you)?)$/, "voice", "louder"],
    [/^((talk|speak) (softer|more quietly|quieter)|softer|quieter|too loud|turn (it )?down|volume down)$/, "voice", "softer"],

    // Text size.
    [/^((make )?(the )?(text|words|letters|writing|it) (bigger|larger)|bigger( text)?|larger( text)?|(text|words) bigger|zoom in|increase (the )?(text|size|text size))$/, "bigger"],
    [/^((make )?(the )?(text|words|letters|writing|it) smaller|smaller( text)?|(text|words) smaller|zoom out|decrease (the )?(text|size|text size)|too big)$/, "smaller"],

    // Colors.
    [/^((its |thats |it is |that is |the screen is |the screens )?too bright|less bright|(its |thats )?too glary|(the )?glare)$/, "too_bright"],
    [/^((a |the )?(white|light) (background|screen|page)|(black|dark) (text|letters|writing) on (a )?white|normal colou?rs|standard colou?rs)$/, "theme", "standard"],
    [/^((a |the )?blue( background| screen| page)?|white (text |letters |writing )?on (dark )?blue|dark blue)$/, "theme", "blue"],
    [/^((a |the )?(black|dark) (background|screen|page)|white (text |letters |writing )?on black|dark mode|dark colou?rs)$/, "theme", "dark"],
    [/^(yellow (text |letters |writing )?on black|high contrast|yellow)$/, "theme", "high"],

    // Word highlighting.
    [/^((turn )?(word )?highlight(ing|s)?( (the )?words?)? on|(turn on|use) (word )?highlight(ing)?|highlight (the )?words?|light up (the )?words?)$/, "highlight", "on"],
    [/^((turn )?(word )?highlight(ing|s)?( (the )?words?)? off|(turn off|no|stop) (word )?highlight(ing)?)$/, "highlight", "off"],

    // Moving around a long page, and the page being read aloud.
    [/^(scroll down|page down|down|go down|move down|scroll|next page|further down)$/, "scroll", "down"],
    [/^(scroll up|page up|up|go up|move up|back up|previous page|further up)$/, "scroll", "up"],
    [/^((go )?(to )?the top|top of (the )?page|start of (the )?page|scroll to (the )?top)$/, "scroll", "top"],
    [/^((go )?(to )?the bottom|bottom of (the )?page|end of (the )?page|scroll to (the )?bottom)$/, "scroll", "bottom"],
    [/^(pause|stop|stop reading|stop talking|be quiet|quiet|hush|hold on|wait a (second|minute|moment))$/, "read", "pause"],
    [/^(continue|keep reading|carry on|go on|resume|read on|keep going reading|start reading|read it|read (it|them|the results|this)( to me)?)$/, "read", "continue"],
    [/^(read (that|it) again|read again|say (the|that) (line|sentence) again|start (that|the) (line|sentence) again)$/, "read", "again"],

    // Bold.
    [/^((turn )?bold( text)? on|(turn on|use|make it|make the text) bold( text)?|bold( text)?|thicker( text| letters)?|heavier( text)?)$/, "bold", "on"],
    [/^((turn )?bold( text)? off|(turn off|no) bold( text)?|not bold|regular( text)?|thinner( text| letters)?|plain( text)?)$/, "bold", "off"],

    // Answers to a pair. Top/bottom on phones are the same as left/right.
    [new RegExp("^((the |on the )?(left|top|first|upper)" + ONE + "|left side|the top one)$"), "left"],
    [new RegExp("^((the |on the )?(right|bottom|second|lower)" + ONE + "|right side|the bottom one)$"), "right"],
    [/^((about |pretty much |just )?(the )?same|they look (about )?the same|(theyre |they are )?(both )?(the )?same|both|no difference|either( one)?|either is fine|i dont mind|doesnt matter)$/, "same"],
    [/^(i (cant|cannot|can not|dont|do not) (tell|see|see it|see them|read it|know)|cant tell|not sure|im not sure|no idea|dont know|i dont know|i have no idea|nothing)$/, "cant_tell"],

    [/^(yes|yeah|yep|yup|sure|ok|okay|ready|im ready|i am ready|go|lets go|start|begin|yes please|of course|correct|thats right|keep (it|them|these|this))$/, "yes"],
    [/^(no|nope|nah|not yet|no thanks|no thank you|not now|wait)$/, "no"],
  ];

  C.parse = function (text) {
    var t = strip(C.norm(text));
    if (!t) return null;
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(t)) return RULES[i][2] ? { cmd: RULES[i][1], value: RULES[i][2] } : { cmd: RULES[i][1] };
    }
    return null;
  };

  // Commands that work at any step (the rest are answers).
  C.GLOBAL = ["end", "help", "menu", "stop_listening", "repeat", "back", "skip", "pointer", "voice", "bigger", "smaller", "too_bright", "theme", "bold", "highlight", "scroll", "read"];
  C.isGlobal = function (c) { return !!c && C.GLOBAL.indexOf(c.cmd) !== -1; };

  root.V360Commands = C;
})(typeof window !== "undefined" ? window : globalThis);
