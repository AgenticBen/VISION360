/* =========================================================================
   "What's new" button and guided tour, shared by the directory, the voice
   and chat demo, and the staff queue.

   Usage: <script src="/whats-new.js" data-page="directory|demo|staff" defer>

   Plain JS, no dependencies. Placement: on the demo and staff pages the
   button sits in the header's top-right corner, next to Settings / Sign out
   (early in the tab order, covering nothing). On the directory it shares the
   bottom feedback bar, the page reserves room so the bar never hides a
   focused control, and a skip link reaches it from the top.

   Accessibility: a real <button>; a native <dialog> (Escape closes it, focus
   returns); each step's title and text are announced; "Show me" moves focus
   to the part a step describes, outlines it, and puts a "Back to the tour"
   button right after it so keyboard users can continue with one Tab.
   Nothing here changes records, answers or routing.
   ========================================================================= */
(function () {
  "use strict";

  var VERSION = "2026-11-04b";          /* bump when the "Recent changes" list changes */
  var SEEN_KEY = "v360-whats-new-seen";

  var NEW_ITEMS = [
    "The directory, the Find services questions and the voice and chat assistant now put services in the same order, using one shared set of rules.",
    "The assistant double-checks before suggesting anything. If you add or change something while saying yes (“yes, but I’m 70”), it updates your answer and reads the summary back again.",
    "Saying “not sure” or “no idea” is recorded as not sure, never as a yes or a no. Unclear ages and exam dates get a follow-up question instead of a guess.",
    "Answers are saved more safely, and each suggestion records which version of the directory produced it, so staff can trace it later."
  ];

  var TOURS = {
    directory: {
      title: "Using the directory",
      links: [["/demo", "Try the voice and chat demo"]],
      steps: [
        { target: "#q", title: "Search everything", body: "Type an organization, a service, a county or a need. Search looks at names, services, eligibility, contacts and referral steps, and filters the Directory list." },
        { target: "#views", title: "Three views", body: "Directory lists every organization. Pathways shows common routes through services. Find services asks a few questions and suggests where to start." },
        { target: "#filters", hint: "Open the Directory view to see the filters.", title: "Filter and sort", body: "Narrow the list by category, area or confidence. Use Clear all to see every organization again. Nothing is ever hidden for being far away; geography only changes the order." },
        { target: "#sort", hint: "Open the Directory view to see the sort options.", title: "Order the list", body: "“Mecklenburg first” groups organizations by how close they are. You can also sort by name, by how well a listing is confirmed, or by open questions." },
        { target: "#org-list [id^='org-']", hint: "Open the Directory view to see the listings.", title: "Open a listing", body: "Expand any organization to see services, who qualifies, costs, documents, every referral step and contacts. Each listing has a link you can copy and share." },
        { target: "#tab-quiz", title: "Find services", body: "Answer as many questions as you like, or skip any. Results explain why each service is suggested, and the rest stay one click away." },
        { target: "#feedback-open", title: "Tell us what to improve", body: "This opens your email app with your feedback. Feedback is reviewed before any listing changes." }
      ]
    },
    demo: {
      title: "Using the voice and chat demo",
      links: [["/", "Back to the directory"]],
      steps: [
        { target: "#start", hint: "You've already started; this choice is at the top when you begin.", title: "Talk or type", body: "Choose Talk to use your microphone, or Type to chat. You can switch at any time without losing anything. This is a demo: please use made-up details." },
        { target: "#open-settings", title: "Make it comfortable", body: "Settings change text size, colors and contrast, whether replies are read aloud, and the voice speed. They are saved on this device only." },
        { target: "#log", hint: "This appears once you start a conversation.", title: "One question at a time", body: "The assistant asks one question at a time. You can say or type: repeat, skip, I don't know, change an answer, or talk to a person." },
        { target: "#panel", hint: "The summary appears after the questions.", title: "Check the summary", body: "Before suggesting anything, the assistant reads back a summary. Nothing is suggested until you say it's right. Use the Change buttons, or say what to fix." },
        { target: "#panel", hint: "Your suggestions appear after you confirm the summary.", title: "Your suggestions", body: "You get up to eight services that fit, with why each one is suggested, how to start, and contacts. You can ask for an emailed plan or for Lions Services staff to follow up." },
        { target: "#end-session", hint: "This appears once you start a conversation.", title: "Stop any time", body: "End session is always there and turns the microphone off. In voice mode, Stop speaking and Repeat last response are there too." }
      ]
    },
    staff: {
      title: "Using the staff queue",
      links: [["/", "Open the directory"], ["/demo", "Open the demo"]],
      steps: [
        { target: "#login", hint: "You're signed in.", title: "Sign in", body: "Staff sign in with their own account. Everything here is fictional demo data." },
        { target: "#list", hint: "The list appears after signing in.", title: "The conversation list", body: "Newest first. Each row shows the stage, the staff status, anything that needs attention, and whether an email was sent." },
        { target: "#detail", hint: "Open a conversation from the list to see this.", title: "Open a conversation", body: "See confirmed and unconfirmed answers, every suggestion with its reasons and the data version behind it, emails and their status, and any request for follow-up." },
        { target: "#detail", hint: "Open a conversation from the list to see this.", title: "Follow up", body: "Mark a conversation reviewed or needing follow-up, and retry an email that failed. Changing a status never changes the person's answers." }
      ]
    }
  };

  var script = document.currentScript;
  var page = (script && script.getAttribute("data-page")) || "directory";
  var tour = TOURS[page] || TOURS.directory;
  var narrowQuery = window.matchMedia ? window.matchMedia("(max-width: 34rem)") : null;

  function seen() { try { return localStorage.getItem(SEEN_KEY) === VERSION; } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(SEEN_KEY, VERSION); } catch (e) {} }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "onclick") n.addEventListener("click", attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function visible(node) {
    return !!(node && (node.offsetWidth || node.offsetHeight) && node.getClientRects().length);
  }

  /* ---------------- button ---------------- */
  var unread = !seen();
  var button = el("button", { type: "button", id: "whats-new-open", "class": "wn-button", "aria-haspopup": "dialog" }, [
    el("span", { "class": "wn-long", text: "What's new" }),
    el("span", { "class": "wn-short", text: "New", "aria-hidden": "true" }),
    unread ? el("span", { "class": "wn-dot", "aria-hidden": "true" }) : null
  ]);

  /* The accessible name starts with the visible words (WCAG 2.5.3). */
  function setLabel() {
    var shortShown = narrowQuery && narrowQuery.matches && !button.classList.contains("wn-in-header");
    var base = shortShown ? "New: what's new and a tour" : "What's new";
    button.setAttribute("aria-label", unread ? base + " (unread)" : base);
  }

  /* ---------------- dialog ---------------- */
  var stepIndex = 0;
  var stepBox = el("div", { "class": "wn-step" });
  var stepStatus = el("p", { "class": "wn-progress", role: "status", "aria-live": "polite" });
  var back = el("button", { type: "button", "class": "wn-btn", text: "Back", onclick: function () { show(stepIndex - 1); } });
  var next = el("button", { type: "button", "class": "wn-btn wn-btn-primary", text: "Next", onclick: function () { if (stepIndex < tour.steps.length - 1) show(stepIndex + 1); else dialog.close(); } });
  var showMe = el("button", { type: "button", "class": "wn-btn", text: "Show me", onclick: function () { highlight(tour.steps[stepIndex].target); } });

  var changes = el("details", { "class": "wn-changes" }, [
    el("summary", { text: "Recent changes (" + NEW_ITEMS.length + ")" }),
    el("ul", { "class": "wn-list" }, NEW_ITEMS.map(function (t) { return el("li", { text: t }); }))
  ]);
  if (unread) changes.open = true;

  var dialog = el("dialog", { id: "whats-new-dialog", "class": "wn-dialog", "aria-labelledby": "wn-title" }, [
    el("div", { "class": "wn-header" }, [
      el("h2", { id: "wn-title", text: "What's new" }),
      el("button", { type: "button", "class": "wn-btn", text: "Close", onclick: function () { dialog.close(); } })
    ]),
    el("section", { "aria-labelledby": "wn-tour-h" }, [
      el("h3", { id: "wn-tour-h", text: tour.title }),
      stepStatus,
      stepBox,
      el("div", { "class": "wn-actions" }, [back, showMe, next])
    ]),
    changes,
    el("p", { "class": "wn-links" }, tour.links.map(function (l, i) {
      var a = el("a", { href: l[0], text: l[1] });
      return i ? el("span", null, [document.createTextNode(" · "), a]) : a;
    }))
  ]);

  function show(i) {
    var hadFocus = document.activeElement;
    stepIndex = Math.max(0, Math.min(tour.steps.length - 1, i));
    var s = tour.steps[stepIndex];
    stepBox.innerHTML = "";
    stepBox.appendChild(el("h4", { text: s.title }));
    stepBox.appendChild(el("p", { text: s.body }));
    var shown = visible(document.querySelector(s.target));
    showMe.hidden = !shown;
    if (!shown) stepBox.appendChild(el("p", { "class": "wn-note", text: s.hint || "This part isn't on the screen right now." }));
    /* Announce the whole step, not just its number; sighted users see the count. */
    stepStatus.textContent = "";
    stepStatus.appendChild(el("span", { text: "Step " + (stepIndex + 1) + " of " + tour.steps.length }));
    stepStatus.appendChild(el("span", { "class": "wn-sr", text: ": " + s.title + ". " + s.body }));
    back.disabled = stepIndex === 0;
    next.textContent = stepIndex === tour.steps.length - 1 ? "Finish" : "Next";
    /* A button that just became disabled can't keep focus: move it on. */
    if (hadFocus && hadFocus.disabled) next.focus();
    if (hadFocus === showMe && showMe.hidden) next.focus();
  }

  /* ---------------- show me ---------------- */
  var current = null;   /* { target, backButton } while a part is highlighted */

  function clearHighlight() {
    if (!current) return;
    current.target.classList.remove("wn-highlight");
    if (current.addedTabindex) current.target.removeAttribute("tabindex");
    if (current.backButton.parentNode) current.backButton.parentNode.removeChild(current.backButton);
    current = null;
  }

  function openTour() {
    clearHighlight();
    show(stepIndex);
    if (!dialog.open) dialog.showModal();
    markSeen();
    unread = false;
    var dot = button.querySelector(".wn-dot");
    if (dot) dot.parentNode.removeChild(dot);
    setLabel();
  }

  /* Close the tour, bring the described part into view, outline it, move
     focus there, and place "Back to the tour" right after it. The outline
     stays until the person goes back to the tour or clicks elsewhere. */
  function highlight(selector) {
    var target = document.querySelector(selector);
    if (!visible(target)) return;
    clearHighlight();
    dialog.close();
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    target.classList.add("wn-highlight");
    var addedTabindex = false;
    if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
      target.setAttribute("tabindex", "-1");
      addedTabindex = true;
    }
    var backButton = el("button", { type: "button", "class": "wn-back", text: "Back to the tour (step " + (stepIndex + 1) + " of " + tour.steps.length + ")", onclick: function (ev) { ev.stopPropagation(); openTour(); } });
    target.insertAdjacentElement("afterend", backButton);
    current = { target: target, backButton: backButton, addedTabindex: addedTabindex };
    try { target.focus({ preventScroll: true }); } catch (e) {}
  }

  document.addEventListener("click", function (ev) {
    if (current && !current.backButton.contains(ev.target) && !current.target.contains(ev.target)) clearHighlight();
  }, true);

  button.addEventListener("click", openTour);
  dialog.addEventListener("close", function () { if (!current) button.focus(); });

  /* ---------------- placement ---------------- */
  /* Keep a fixed bottom bar from covering whatever has focus. */
  function reserveSpace(bar) {
    function apply() {
      var h = Math.ceil(bar.getBoundingClientRect().height) + 16;
      document.documentElement.style.scrollPaddingBottom = h + "px";
      document.body.style.paddingBottom = h + "px";
    }
    apply();
    if (window.ResizeObserver) new ResizeObserver(apply).observe(bar);
    window.addEventListener("resize", apply);
  }

  function mount() {
    document.body.appendChild(dialog);
    var header = document.querySelector(".top-inner");
    var dock = document.querySelector(".feedback-dock");
    if (header) {
      /* Demo and staff: top-right corner, grouped with the existing header button. */
      button.classList.add("wn-in-header");
      var group = el("div", { "class": "wn-header-actions" });
      var existing = header.lastElementChild && header.lastElementChild.tagName === "BUTTON" ? header.lastElementChild : null;
      group.appendChild(button);
      if (existing) group.appendChild(existing);
      header.appendChild(group);
    } else if (dock) {
      /* Directory: left side of the feedback bar, plus a skip link at the top. */
      dock.classList.add("wn-docked");
      dock.insertBefore(button, dock.firstChild);
      reserveSpace(dock);
      var lastSkip = [].slice.call(document.querySelectorAll(".skip-link")).pop();
      if (lastSkip) lastSkip.insertAdjacentElement("afterend", el("a", { "class": "skip-link", href: "#whats-new-open", text: "Skip to What's new and the tour" }));
    } else {
      button.classList.add("wn-floating");
      document.body.appendChild(button);
      reserveSpace(button);
    }
    setLabel();
    if (narrowQuery && narrowQuery.addEventListener) narrowQuery.addEventListener("change", setLabel);
  }

  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
