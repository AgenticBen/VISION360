/* =========================================================================
   "What's new" button and guided tour, shared by the directory, the voice
   and chat demo, and the staff queue.

   Usage: <script src="/whats-new.js" data-page="directory|demo|staff" defer>

   Plain JS, no dependencies. Accessible by design: a real <button>, a native
   <dialog> (Escape closes it, focus returns to the button), a live "Step 2
   of 5" status, and "Show me", which scrolls to and outlines the part of the
   page a step describes. Nothing here changes records, answers or routing.
   ========================================================================= */
(function () {
  "use strict";

  var VERSION = "2026-11-04";          /* bump when the "What's new" list changes */
  var SEEN_KEY = "v360-whats-new-seen";

  var NEW_ITEMS = [
    "The directory, the chat and the voice demo now rank services with the same shared rules, so they can't drift apart.",
    "The assistant no longer mistakes a correction such as “I do have an eye doctor” for “yes, that's right”. It fixes the answer and reads the summary back again.",
    "Conversations are saved more safely: if two saves of the same conversation collide, one is asked to try again instead of losing answers.",
    "Every suggestion now records which version of the code and data produced it, so staff can trace a recommendation later."
  ];

  var TOURS = {
    directory: {
      title: "Using the directory",
      links: [["/demo", "Try the voice and chat demo"], ["/staff", "Open the staff queue"]],
      steps: [
        { target: "#site-search", title: "Search everything", body: "Type an organization, a service, a county or a need. Search looks at names, services, eligibility, contacts and referral steps, and filters the Directory list." },
        { target: "#views", title: "Three views", body: "Directory lists every organization. Pathways shows common routes through services. Find services asks a few questions and suggests where to start." },
        { target: "#filters", title: "Filter and sort", body: "Narrow the list by category, area or confidence. Use Clear all to see every organization again. Nothing is ever hidden for being far away; geography only changes the order." },
        { target: "#sort", title: "Order the list", body: "“Mecklenburg first” groups organizations by how close they are. You can also sort by name, by how well a listing is confirmed, or by open questions." },
        { target: "#org-list", title: "Open a listing", body: "Expand any organization to see services, who qualifies, costs, documents, every referral step and contacts. Each listing has a link you can copy and share." },
        { target: "#tab-quiz", title: "Find services", body: "Answer as many questions as you like, or skip any. Results explain why each service is suggested, and the rest stay one click away." },
        { target: "#feedback-open", title: "Tell us what to improve", body: "This opens your email app with your feedback. Feedback is reviewed before any listing changes." }
      ]
    },
    demo: {
      title: "Using the voice and chat demo",
      links: [["/", "Back to the directory"]],
      steps: [
        { target: "#start", title: "Talk or type", body: "Choose Talk to use your microphone, or Type to chat. You can switch at any time without losing anything. This is a demo: please use made-up details." },
        { target: "#open-settings", title: "Make it comfortable", body: "Settings change text size, colours and contrast, whether replies are read aloud, and the voice speed. They are saved on this device only." },
        { target: "#log", title: "One question at a time", body: "The assistant asks one question at a time. You can say or type: repeat, skip, I don't know, change an answer, or talk to a person." },
        { target: "#log", title: "Check the summary", body: "Before suggesting anything, the assistant reads back a summary. Nothing is suggested until you say it's right. Use the Change buttons, or say what to fix." },
        { target: "#log", title: "Your suggestions", body: "You get up to eight services that fit, with why each one is suggested, how to start, and contacts. You can ask for an emailed plan or for Lions Services staff to follow up." },
        { target: "#end-session", title: "Stop any time", body: "Stop speaking, Repeat last response and End session are always available. Ending the session turns the microphone off." }
      ]
    },
    staff: {
      title: "Using the staff queue",
      links: [["/", "Open the directory"], ["/demo", "Open the demo"]],
      steps: [
        { target: "#login", title: "Sign in", body: "Staff sign in with their own account. Everything here is fictional demo data." },
        { target: "#list", title: "The conversation list", body: "Newest first. Each row shows the stage, the staff status, anything that needs attention, and whether an email was sent." },
        { target: "#detail", title: "Open a conversation", body: "See confirmed and unconfirmed answers, every suggestion with its reasons and the data version behind it, emails and their status, and any request for follow-up." },
        { target: "#detail", title: "Follow up", body: "Mark a conversation reviewed or needing follow-up, and retry an email that failed. Changing a status never changes the person's answers." }
      ]
    }
  };

  var script = document.currentScript;
  var page = (script && script.getAttribute("data-page")) || "directory";
  var tour = TOURS[page] || TOURS.directory;

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
    return !!(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
  }

  /* ---------------- button ---------------- */
  /* On narrow screens the visible text shortens to "New"; the accessible
     name always starts with the same words ("What's new"). */
  var button = el("button", { type: "button", id: "whats-new-open", "class": "wn-button", "aria-haspopup": "dialog", "aria-label": seen() ? "What's new" : "What's new (unread)" }, [
    el("span", { "class": "wn-long", text: "What's new" }),
    el("span", { "class": "wn-short", text: "New", "aria-hidden": "true" }),
    seen() ? null : el("span", { "class": "wn-dot", "aria-hidden": "true" })
  ]);

  /* ---------------- dialog ---------------- */
  var stepIndex = 0;
  var stepBox = el("div", { "class": "wn-step" });
  var stepStatus = el("p", { "class": "wn-progress", role: "status", "aria-live": "polite" });
  var back = el("button", { type: "button", "class": "wn-btn", text: "Back", onclick: function () { show(stepIndex - 1); } });
  var next = el("button", { type: "button", "class": "wn-btn wn-btn-primary", text: "Next", onclick: function () { if (stepIndex < tour.steps.length - 1) show(stepIndex + 1); else dialog.close(); } });
  var showMe = el("button", { type: "button", "class": "wn-btn", text: "Show me", onclick: function () { highlight(tour.steps[stepIndex].target); } });

  var dialog = el("dialog", { id: "whats-new-dialog", "class": "wn-dialog", "aria-labelledby": "wn-title" }, [
    el("div", { "class": "wn-header" }, [
      el("h2", { id: "wn-title", text: "What's new" }),
      el("button", { type: "button", "class": "wn-btn", text: "Close", onclick: function () { dialog.close(); } })
    ]),
    el("section", { "aria-labelledby": "wn-new-h" }, [
      el("h3", { id: "wn-new-h", text: "Recent changes" }),
      el("ul", { "class": "wn-list" }, NEW_ITEMS.map(function (t) { return el("li", { text: t }); }))
    ]),
    el("section", { "aria-labelledby": "wn-tour-h" }, [
      el("h3", { id: "wn-tour-h", text: tour.title }),
      stepStatus,
      stepBox,
      el("div", { "class": "wn-actions" }, [back, showMe, next])
    ]),
    el("p", { "class": "wn-links" }, tour.links.map(function (l, i) {
      var a = el("a", { href: l[0], text: l[1] });
      return i ? el("span", null, [document.createTextNode(" · "), a]) : a;
    }))
  ]);

  function show(i) {
    stepIndex = Math.max(0, Math.min(tour.steps.length - 1, i));
    var s = tour.steps[stepIndex];
    stepBox.innerHTML = "";
    stepBox.appendChild(el("h4", { text: s.title }));
    stepBox.appendChild(el("p", { text: s.body }));
    var target = document.querySelector(s.target);
    showMe.hidden = !visible(target);
    if (!visible(target)) stepBox.appendChild(el("p", { "class": "wn-note", text: "This part appears once you get there." }));
    stepStatus.textContent = "Step " + (stepIndex + 1) + " of " + tour.steps.length;
    back.disabled = stepIndex === 0;
    next.textContent = stepIndex === tour.steps.length - 1 ? "Finish" : "Next";
  }

  /* Close the tour, bring the described part into view and outline it.
     The outline is removed after a few seconds or on the next click. */
  function highlight(selector) {
    var target = document.querySelector(selector);
    if (!visible(target)) return;
    dialog.close();
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    target.classList.add("wn-highlight");
    if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) target.setAttribute("tabindex", "-1");
    try { target.focus({ preventScroll: true }); } catch (e) {}
    var clear = function () { target.classList.remove("wn-highlight"); document.removeEventListener("click", clear, true); };
    setTimeout(clear, 4000);
    setTimeout(function () { document.addEventListener("click", clear, true); }, 0);
  }

  button.addEventListener("click", function () {
    show(stepIndex);
    dialog.showModal();
    markSeen();
    var dot = button.querySelector(".wn-dot");
    if (dot) dot.remove();
    button.setAttribute("aria-label", "What's new");
  });
  dialog.addEventListener("close", function () { if (!document.querySelector(".wn-highlight")) button.focus(); });

  function mount() {
    document.body.appendChild(dialog);
    /* The directory already has a bottom bar for feedback: share its left side. */
    var dock = document.querySelector(".feedback-dock");
    if (dock) {
      dock.classList.add("wn-docked");
      dock.insertBefore(button, dock.firstChild);
    } else {
      button.classList.add("wn-floating");
      document.body.appendChild(button);
      document.body.classList.add("wn-has-floating");
    }
  }

  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
