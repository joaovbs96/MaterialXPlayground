/* mtlx-run.js — Tutorials-only: adds a "Run" footer to the JavaScript tab of
   each multi-language code-tab set. Runs the shown JS snippet, captures
   console output, and shows it in a collapsible log field. Logs only — no
   rendering.

   Loaded via extra_javascript at end-of-body (DOM already parsed). Standalone:
   tutorials pages do NOT load the SPA's mtlx-engine.js or Babel. */
(function () {
  "use strict";

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  // The snippet imports the MaterialX WASM as `../js/...`, which reads as
  // "one dir up from this tutorials page". But a function built via the
  // Function/AsyncFunction constructor resolves its dynamic import() against
  // THIS script's URL (…/tutorials/assets/mtlx-run.js), not the page — so a
  // bare `../js/` would wrongly resolve to /tutorials/js/. Resolve it against
  // the page (document.baseURI) to an absolute URL and substitute it into the
  // executed source so import()/locateFile hit the SPA root's /js/.
  const JS_HREF = new URL("../js/", document.baseURI).href;

  // Patch console once (lazily on first run); route to the active run's sink
  // while forwarding to the real console. Single active capture at a time.
  let activeCapture = null;
  let patched = false;
  function ensureConsolePatched() {
    if (patched) return;
    patched = true;
    ["log", "info", "warn", "error", "debug"].forEach(function (m) {
      const real = (console[m] || function () {}).bind(console);
      console[m] = function () {
        const args = Array.prototype.slice.call(arguments);
        if (activeCapture) activeCapture.sink(m, args);
        real.apply(null, args);
      };
    });
  }

  function fmt(v) {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }

  const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3l9 5-9 5z"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>';
  const ICON_CHEV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4z"/></svg>';

  function jsBlockOf(set) {
    const labels = Array.prototype.slice.call(set.querySelectorAll(".tabbed-labels > label"));
    let idx = -1;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === "JavaScript") { idx = i; break; }
    }
    if (idx < 0) return null;
    const blocks = set.querySelectorAll(".tabbed-content > .tabbed-block");
    return blocks[idx] || null;
  }

  function attach(block) {
    const code = block.querySelector("pre > code");
    if (!code) return;
    if (block.querySelector(".mtlx-run")) return; // idempotent

    const footer = document.createElement("div");
    footer.className = "mtlx-run";

    const bar = document.createElement("div");
    bar.className = "mtlx-run__bar";

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "mtlx-run__btn";

    const logToggle = document.createElement("button");
    logToggle.type = "button";
    logToggle.className = "mtlx-run__toggle";
    logToggle.setAttribute("aria-expanded", "false");
    logToggle.innerHTML = ICON_CHEV + "<span>Logs</span>";

    bar.appendChild(runBtn);
    bar.appendChild(logToggle);

    const logWrap = document.createElement("div");
    logWrap.className = "mtlx-run__log";
    logWrap.hidden = true;
    const pre = document.createElement("pre");
    pre.setAttribute("aria-live", "polite");
    logWrap.appendChild(pre);

    footer.appendChild(bar);
    footer.appendChild(logWrap);

    let token = 0;
    let running = false;

    function setRunning(on) {
      running = on;
      runBtn.classList.toggle("is-running", on);
      runBtn.innerHTML = on ? ICON_STOP : ICON_PLAY;
      runBtn.setAttribute("aria-label", on ? "Stop" : "Run");
      runBtn.title = on ? "Stop" : "Run";
    }
    setRunning(false);

    function showLog() {
      logWrap.hidden = false;
      logToggle.setAttribute("aria-expanded", "true");
    }

    function render(lines) {
      pre.textContent = lines.join("\n");
    }

    runBtn.addEventListener("click", async function () {
      if (running) {          // Stop = supersede in-flight run
        token++;
        setRunning(false);
        return;
      }
      const my = ++token;
      ensureConsolePatched();
      setRunning(true);
      showLog();
      const lines = [];
      render(lines);
      activeCapture = {
        token: my,
        sink: function (lvl, args) {
          const prefix = (lvl === "error" || lvl === "warn") ? "[" + lvl + "] " : "";
          lines.push(prefix + args.map(fmt).join(" "));
          if (token === my) render(lines);
        },
      };
      try {
        const runnable = code.textContent.split("../js/").join(JS_HREF);
        await new AsyncFunction(runnable)();
      } catch (e) {
        lines.push("[error] " + (e && e.stack ? e.stack : String(e)));
        if (token === my) render(lines);
      } finally {
        if (activeCapture && activeCapture.token === my) activeCapture = null;
        if (token === my) setRunning(false);
      }
    });

    logToggle.addEventListener("click", function () {
      const open = logWrap.hidden;   // currently hidden -> we are opening
      logWrap.hidden = !open;
      logToggle.setAttribute("aria-expanded", String(open));
    });

    block.appendChild(footer);
  }

  const sets = document.querySelectorAll(".tabbed-set");
  for (let i = 0; i < sets.length; i++) {
    const b = jsBlockOf(sets[i]);
    if (b) attach(b);
  }
})();
