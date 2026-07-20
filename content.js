(function () {
  'use strict';

  const OFFSET = 80;     // px of breathing room above the prompt
  const ANCHOR = 90;     // viewport line (px from top) used to decide "current" prompt
  const EPS = 4;         // tolerance so a prompt sitting right at the anchor counts as "here"

  // ── Prompt detection ────────────────────────────────────────────────────────
  function getPrompts() {
    let nodes = Array.from(document.querySelectorAll('[data-testid^="user-message"]'));
    if (!nodes.length) {
      nodes = Array.from(document.querySelectorAll('.human-turn, [class*="human"]'));
    }
    const prompts = nodes.filter(el => el.offsetParent !== null);
    syncMasterOrder(prompts);
    return prompts;
  }

  // ── Persistent prompt history ──────────────────────────────────────────────
  // Claude virtualizes its message list: turns far from the viewport get
  // unmounted, so a raw DOM query only ever reflects whatever's mounted
  // *right now* — scrolling can make that set shrink, grow, or shift under
  // us, which is why counts like "3/8" would jump to "2/7". We keep a
  // running, ordered record of every prompt we've ever seen, keyed by
  // something stable across remounts (not element identity — virtualization
  // recreates the DOM node when an item scrolls back into view), so the
  // panel list and prompt counts only ever grow and never reorder.
  function promptText(el) {
    const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    return t || '(empty)';
  }

  function promptKeyOf(el) {
    return (el.getAttribute('data-testid') || '') + '|' + promptText(el).slice(0, 200);
  }

  let masterOrder = [];          // stable keys, in conversation order
  let masterPos = new Map();     // key -> index in masterOrder
  const masterText = new Map();  // key -> display text

  function syncMasterOrder(mountedEls) {
    if (!mountedEls.length) return;
    const curKeys = mountedEls.map(promptKeyOf);
    mountedEls.forEach((el, i) => {
      if (!masterText.has(curKeys[i])) masterText.set(curKeys[i], promptText(el));
    });

    if (!masterOrder.length) {
      masterOrder = curKeys.slice();
    } else {
      // Fast scrolling can produce a transiently inconsistent mounted
      // snapshot (e.g. a batch still mid-render), where keys we already
      // know about appear out of their recorded order. Merging that would
      // corrupt masterOrder permanently, so bail on this snapshot — a later,
      // more settled one will pick up the slack instead.
      let lastAnchor = -1;
      for (const k of curKeys) {
        const pos = masterPos.get(k);
        if (pos === undefined) continue;
        if (pos < lastAnchor) return;
        lastAnchor = pos;
      }

      // Merge the currently-mounted run into the master order: keys we've
      // already placed act as anchors, and any new keys found between (or
      // before/after) anchors get spliced in relative to them, using the
      // mounted DOM order — which is locally correct even though it's not
      // the full picture — as the guide.
      const insertions = [];
      let pending = [];
      let anchor = -1;
      for (const k of curKeys) {
        if (masterPos.has(k)) {
          if (pending.length) { insertions.push({ after: anchor, keys: pending }); pending = []; }
          anchor = masterPos.get(k);
        } else {
          pending.push(k);
        }
      }
      if (pending.length) insertions.push({ after: anchor, keys: pending });

      insertions.sort((a, b) => b.after - a.after);
      for (const { after, keys } of insertions) {
        masterOrder.splice(after + 1, 0, ...keys);
      }
    }
    masterPos = new Map(masterOrder.map((k, i) => [k, i]));
  }

  function getScroller() {
    const prompts = getPrompts();
    if (!prompts.length) return window;
    let el = prompts[0].parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return window;
  }

  function anchorLine() {
    const s = getScroller();
    return s === window ? ANCHOR : s.getBoundingClientRect().top + ANCHOR;
  }

  function getCurrentIndex(prompts) {
    const anchorY = anchorLine();
    let current = 0;
    for (let i = 0; i < prompts.length; i++) {
      const top = prompts[i].getBoundingClientRect().top;
      if (top <= anchorY + EPS) current = i;
      else break;
    }
    return current;
  }

  function scrollTargetTop(el) {
    const scroller = getScroller();
    const isWindow = scroller === window;
    const scrollTop = isWindow ? window.scrollY : scroller.scrollTop;
    const containerTop = isWindow ? 0 : scroller.getBoundingClientRect().top;
    return scrollTop + el.getBoundingClientRect().top - containerTop - OFFSET;
  }

  // Each call supersedes the previous one, so rapid presses don't leave two
  // correction loops fighting over the scroll position.
  let scrollToken = 0;

  function scrollToPrompt(el) {
    const scroller = getScroller();
    const getPos = () => scroller === window ? window.scrollY : scroller.scrollTop;
    const maxTop = () => {
      const sh = scroller === window
        ? document.documentElement.scrollHeight : scroller.scrollHeight;
      const ch = scroller === window ? window.innerHeight : scroller.clientHeight;
      return Math.max(0, sh - ch);
    };

    const token = ++scrollToken;
    scroller.scrollTo({ top: Math.min(scrollTargetTop(el), maxTop()), behavior: 'smooth' });

    // Lazy-loaded content (images, streaming turns) shifts the layout in
    // *stages*, not all at once, so a single post-scroll correction isn't
    // enough. Instead we converge: keep re-pinning the target to its intended
    // offset until it has stayed put for a sustained window, with a hard cap.
    //
    // - We let the initial smooth animation run briefly, then read where the
    //   target actually landed and re-pin if it drifted (clamped to the
    //   scrollable range, so a target near the bottom doesn't read as "off").
    // - Corrections use instant ('auto') jumps once the first animation is
    //   done, so we don't keep restarting a slow animation that goes stale.
    // - "Settled" means the residual error stayed within tolerance for
    //   ~12 consecutive frames; otherwise we keep correcting up to ~4s.
    const TOL = 6;            // px we consider "on target"
    const SETTLE_FRAMES = 12; // consecutive good frames before we stop
    const MAX_MS = 4000;      // hard ceiling so we never loop forever
    const start = performance.now();
    let good = 0;
    let animating = true;
    // Let the smooth scroll get going before we start instant re-pins.
    setTimeout(() => { animating = false; }, 320);

    const tick = () => {
      if (token !== scrollToken) return;            // a newer jump took over
      if (!el.isConnected) return;                  // target was removed

      const want = Math.min(scrollTargetTop(el), maxTop());
      const err = want - getPos();

      if (Math.abs(err) <= TOL) {
        good++;
        if (good >= SETTLE_FRAMES || performance.now() - start > MAX_MS) return;
      } else {
        good = 0;
        if (animating) {
          // Don't fight the in-flight smooth animation for small drifts; only
          // re-aim it if the layout shoved the target a long way.
          if (Math.abs(err) > 80) {
            scroller.scrollTo({ top: want, behavior: 'smooth' });
          }
        } else {
          // Instant correction — converges immediately, then we re-check.
          scroller.scrollTo({ top: want, behavior: 'auto' });
        }
      }

      if (performance.now() - start > MAX_MS) return;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const prev = el.style.transition;
    el.style.transition = 'outline 0.1s';
    el.style.outline = '2px solid rgba(239,68,68,0.5)';
    el.style.borderRadius = '6px';
    setTimeout(() => {
      el.style.outline = '';
      el.style.borderRadius = '';
      el.style.transition = prev;
    }, 900);
  }

  // ── Shared navigation (used by keyboard AND buttons) ──────────────────────
  // Stepping is done in *master order* (the full, persistent conversation
  // order), not raw mounted-array position: Claude's virtualization can
  // leave gaps in what's mounted (e.g. a very long response can push the
  // next prompt far enough away that it isn't mounted even though it's
  // immediately "next"), so stepping by mounted-array index can jump clean
  // over several prompts. revealKey() (below) brings the real target into
  // the DOM if it isn't there yet.
  async function navigate(direction) {
    const prompts = getPrompts();
    if (!prompts.length) return;

    // A jump/step may still be "in flight" (within lockHighlight's window);
    // if so, continue relative to its master position rather than re-reading
    // the (possibly mid-scroll) current position.
    const lockedMasterIdx = lockedKey ? masterPos.get(lockedKey) : undefined;

    let targetMasterIdx;
    if (lockedMasterIdx !== undefined) {
      targetMasterIdx = direction === 'down'
        ? Math.min(masterOrder.length - 1, lockedMasterIdx + 1)
        : Math.max(0, lockedMasterIdx - 1);
    } else {
      const current = getCurrentIndex(prompts);
      const currentEl = prompts[current];
      const currentMasterIdx = masterPos.get(promptKeyOf(currentEl));
      if (direction === 'down') {
        targetMasterIdx = Math.min(masterOrder.length - 1, currentMasterIdx + 1);
      } else {
        const currentTop = currentEl.getBoundingClientRect().top;
        const anchorY = anchorLine();
        const parked = Math.abs(currentTop - anchorY) <= OFFSET + EPS;
        targetMasterIdx = parked ? Math.max(0, currentMasterIdx - 1) : currentMasterIdx;
      }
    }

    const targetKey = masterOrder[targetMasterIdx];
    if (targetKey === undefined) return;

    const el = await revealKey(targetKey);
    if (!el) return;

    lockHighlight(targetKey);
    scrollToPrompt(el);
    showHud(direction === 'up' ? '\u2191' : '\u2193', targetMasterIdx + 1, masterOrder.length);
    updateActive(getPrompts());
    scrollActiveIntoView();
    return targetMasterIdx;
  }

  let lockedKey = null;
  let lockTimer = null;
  function lockHighlight(key) {
    lockedKey = key;
    clearTimeout(lockTimer);
    // Hold the manual selection until the smooth scroll has settled, so the
    // observer doesn't re-highlight based on the page's mid-scroll position.
    // Matches the convergence window in scrollToPrompt (~4s cap).
    lockTimer = setTimeout(() => { lockedKey = null; }, 4200);
  }

  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Bring a prompt we've recorded but that isn't currently mounted back into
  // the DOM by nudging the scroller toward it, one viewport-ish step at a
  // time, until Claude mounts it or we give up.
  //
  // Jumping straight to the extreme (top:0 / max scroll) badly overshoots
  // when there's a lot of content between here and the target — e.g. one
  // very long response can put thousands of pixels between two prompts —
  // and virtualization only mounts what's near the *current* viewport. An
  // overshoot lands us far past the target with no way back except another
  // overshoot the other way, so it never converges. Stepping by roughly a
  // viewport at a time mimics scrolling by hand, which does work.
  async function revealKey(key) {
    let el = getPrompts().find((e) => promptKeyOf(e) === key);
    if (el) return el;
    const targetIdx = masterPos.get(key);
    if (targetIdx === undefined) return null;

    const scroller = getScroller();
    const getPos = () => scroller === window ? window.scrollY : scroller.scrollTop;
    const getMax = () => {
      const sh = scroller === window ? document.documentElement.scrollHeight : scroller.scrollHeight;
      const ch = scroller === window ? window.innerHeight : scroller.clientHeight;
      return Math.max(0, sh - ch);
    };
    const step = (scroller === window ? window.innerHeight : scroller.clientHeight) * 0.85;

    for (let i = 0; i < 60 && !el; i++) {
      const mounted = getPrompts();
      if (mounted.length) {
        // Compare against whichever mounted prompt is currently at the
        // anchor line, not the mounted array's first/last extremes. A long
        // response can leave a *gap* in what's mounted (e.g. prompt 1 and
        // prompt 17 mounted, nothing in between) — checking the extremes
        // would wrongly conclude an unmounted prompt in that gap is
        // "already within range" and do nothing.
        const curIdx = getCurrentIndex(mounted);
        const curMasterIdx = masterPos.get(promptKeyOf(mounted[curIdx]));
        if (targetIdx < curMasterIdx) {
          scroller.scrollTo({ top: Math.max(0, getPos() - step), behavior: 'auto' });
        } else if (targetIdx > curMasterIdx) {
          scroller.scrollTo({ top: Math.min(getMax(), getPos() + step), behavior: 'auto' });
        }
      }
      await delay(180);
      el = getPrompts().find((e) => promptKeyOf(e) === key);
    }
    return el || null;
  }

  async function jumpToKey(key) {
    const el = await revealKey(key);
    if (!el) return;
    const prompts = getPrompts();
    const idx = prompts.indexOf(el);
    if (idx < 0) return;
    lockHighlight(key);
    scrollToPrompt(el);
    const masterIdx = masterPos.get(key);
    showHud('\u2192', masterIdx !== undefined ? masterIdx + 1 : idx + 1, masterOrder.length || prompts.length);
    updateActive(prompts);
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || document.activeElement?.isContentEditable) return;
    e.preventDefault();
    navigate(e.key === 'ArrowUp' ? 'up' : 'down');
  });

  // ── Styles ──────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #cnav-root {
      position: fixed; bottom: 20px; right: 20px;
      z-index: 99999;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    /* Light theme (default) */
    #cnav-root {
      --cnav-bg: rgba(255,255,255,0.97);
      --cnav-border: rgba(0,0,0,0.10);
      --cnav-shadow: 0 12px 40px rgba(0,0,0,0.18);
      --cnav-accent: #ef4444;
      --cnav-accent-soft: rgba(239,68,68,0.14);
      --cnav-accent-mid: rgba(239,68,68,0.22);
      --cnav-text: #374151;
      --cnav-text-strong: #111827;
      --cnav-muted: #9ca3af;
      --cnav-divider: rgba(0,0,0,0.07);
      --cnav-scroll: rgba(0,0,0,0.18);
      --cnav-btn-text: #dc2626;
    }
    /* Dark theme */
    #cnav-root.cnav-dark {
      --cnav-bg: rgba(28,28,34,0.96);
      --cnav-border: rgba(255,255,255,0.1);
      --cnav-shadow: 0 12px 40px rgba(0,0,0,0.45);
      --cnav-accent: #f87171;
      --cnav-accent-soft: rgba(248,113,113,0.16);
      --cnav-accent-mid: rgba(248,113,113,0.24);
      --cnav-text: #d1d5db;
      --cnav-text-strong: #ffffff;
      --cnav-muted: #6b7280;
      --cnav-divider: rgba(255,255,255,0.07);
      --cnav-scroll: rgba(255,255,255,0.14);
      --cnav-btn-text: #fecaca;
    }
    #cnav-panel {
      width: 280px; max-height: 50vh;
      background: var(--cnav-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--cnav-border);
      border-radius: 12px;
      box-shadow: var(--cnav-shadow);
      overflow: hidden;
      display: none; flex-direction: column;
      transform-origin: bottom right;
      animation: cnav-pop 0.14s ease-out;
    }
    #cnav-panel.open { display: flex; }
    @keyframes cnav-pop {
      from { opacity: 0; transform: scale(0.94) translateY(6px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }
    #cnav-head {
      padding: 10px 14px;
      font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--cnav-accent);
      border-bottom: 1px solid var(--cnav-divider);
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
    }
    #cnav-head-left { display: flex; align-items: center; gap: 8px; }
    #cnav-count { color: var(--cnav-muted); font-weight: 600; }
    #cnav-theme {
      background: none; border: none; cursor: pointer; padding: 2px;
      color: var(--cnav-muted); display: flex; align-items: center;
      border-radius: 6px; transition: color 0.12s, background 0.12s;
    }
    #cnav-theme:hover { color: var(--cnav-accent); background: var(--cnav-accent-soft); }
    #cnav-theme svg { width: 16px; height: 16px; }
    #cnav-list { overflow-y: auto; padding: 6px; }
    #cnav-list::-webkit-scrollbar { width: 8px; }
    #cnav-list::-webkit-scrollbar-thumb { background: var(--cnav-scroll); border-radius: 4px; }
    .cnav-item {
      padding: 8px 10px; margin: 2px 0;
      border-radius: 8px; cursor: pointer;
      color: var(--cnav-text); font-size: 13px; line-height: 1.35;
      display: flex; gap: 9px; align-items: baseline;
      transition: background 0.12s, color 0.12s;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cnav-item:hover { background: var(--cnav-accent-soft); color: var(--cnav-text-strong); }
    .cnav-item.active { background: var(--cnav-accent-mid); color: var(--cnav-text-strong); }
    /* Marks rows whose prompt is currently mounted in the host page's DOM,
       since Claude's virtualization means that's a shifting subset of the
       full list. */
    .cnav-item.cnav-mounted { outline: 1.5px solid var(--cnav-accent); outline-offset: -2px; }
    .cnav-num {
      color: var(--cnav-muted); font-size: 11px; font-variant-numeric: tabular-nums;
      flex-shrink: 0; min-width: 18px;
    }
    .cnav-item.active .cnav-num { color: var(--cnav-accent); }
    .cnav-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #cnav-controls { display: flex; gap: 8px; align-items: center; }
    .cnav-btn { position: relative; }
    .cnav-btn[data-tip]::after {
      content: attr(data-tip);
      position: absolute; right: 50%; bottom: calc(100% + 9px);
      transform: translateX(50%) translateY(4px);
      background: var(--cnav-bg); color: var(--cnav-text-strong);
      backdrop-filter: blur(12px);
      border: 1px solid var(--cnav-border);
      box-shadow: var(--cnav-shadow);
      font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.02em;
      padding: 6px 9px; border-radius: 7px; white-space: nowrap;
      opacity: 0; pointer-events: none;
      transition: opacity 0.12s, transform 0.12s;
    }
    .cnav-btn[data-tip]:hover::after {
      opacity: 1; transform: translateX(50%) translateY(0);
    }
    .cnav-btn {
      width: 44px; height: 44px; border-radius: 50%;
      background: var(--cnav-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--cnav-border);
      box-shadow: var(--cnav-shadow);
      color: var(--cnav-btn-text); cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.1s, background 0.12s, color 0.12s;
      padding: 0;
    }
    .cnav-btn:hover { background: var(--cnav-accent-mid); color: var(--cnav-text-strong); }
    .cnav-btn:active { transform: scale(0.9); }
    .cnav-btn svg { width: 20px; height: 20px; }
    #cnav-hud {
      position: fixed; bottom: 80px; right: 84px;
      background: var(--cnav-bg); color: var(--cnav-accent);
      border: 1px solid var(--cnav-border);
      font: 600 11px/1 ui-monospace, monospace;
      padding: 5px 9px; border-radius: 6px;
      pointer-events: none; opacity: 0; transition: opacity 0.3s;
      z-index: 99999; letter-spacing: 0.04em;
    }
  `;
  document.head.appendChild(style);

  // ── UI ────────────────────────────────────────────────────────────────────
  const ICONS = {
    up:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    sun:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  };

  const root = document.createElement('div');
  root.id = 'cnav-root';
  root.innerHTML = `
    <div id="cnav-panel" class="open">
      <div id="cnav-head">
        <span id="cnav-head-left"><span>Prompts</span><span id="cnav-count">0</span></span>
        <button id="cnav-theme" title="Toggle light/dark"></button>
      </div>
      <div id="cnav-list"></div>
    </div>
    <div id="cnav-controls">
      <button class="cnav-btn" id="cnav-up" data-tip="Previous  \u2325\u2191">${ICONS.up}</button>
      <button class="cnav-btn" id="cnav-down" data-tip="Next  \u2325\u2193">${ICONS.down}</button>
    </div>
    <div id="cnav-hud"></div>
  `;
  document.body.appendChild(root);

  const panel  = root.querySelector('#cnav-panel');
  const list   = root.querySelector('#cnav-list');
  const count  = root.querySelector('#cnav-count');
  const hud    = root.querySelector('#cnav-hud');
  const themeBtn = root.querySelector('#cnav-theme');

  // ── Theme (default light, persisted) ──────────────────────────────────────
  function applyTheme(dark) {
    root.classList.toggle('cnav-dark', dark);
    themeBtn.innerHTML = dark ? ICONS.sun : ICONS.moon;
    themeBtn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }
  let isDark = false; // default light
  try { isDark = localStorage.getItem('cnav-theme') === 'dark'; } catch (e) {}
  applyTheme(isDark);

  themeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isDark = !isDark;
    applyTheme(isDark);
    try { localStorage.setItem('cnav-theme', isDark ? 'dark' : 'light'); } catch (e) {}
  });

  root.querySelector('#cnav-up').addEventListener('click', () => navigate('up'));
  root.querySelector('#cnav-down').addEventListener('click', () => navigate('down'));

  // The list renders from the persistent masterOrder (not the raw, currently-
  // mounted prompts) so items already discovered never disappear or reorder
  // as Claude's virtualization mounts/unmounts turns underneath us.
  let lastMasterCount = -1;
  function buildList(force) {
    const mounted = getPrompts(); // also refreshes masterOrder as a side effect
    // Skip a full rebuild if nothing structural changed — avoids clobbering the
    // list (and its scroll position) while the user is browsing it.
    if (!force && masterOrder.length === lastMasterCount && list.children.length === masterOrder.length) {
      updateActive(mounted);
      return;
    }
    lastMasterCount = masterOrder.length;
    count.textContent = masterOrder.length;
    const currentKey = mounted.length ? promptKeyOf(mounted[getCurrentIndex(mounted)]) : null;
    const mountedKeys = new Set(mounted.map(promptKeyOf));
    list.innerHTML = '';
    masterOrder.forEach((key, i) => {
      const text = masterText.get(key) || '(unknown)';
      const item = document.createElement('div');
      item.className = 'cnav-item'
        + (key === currentKey ? ' active' : '')
        + (mountedKeys.has(key) ? ' cnav-mounted' : '');
      item.innerHTML = `<span class="cnav-num">${i + 1}</span><span class="cnav-txt"></span>`;
      item.querySelector('.cnav-txt').textContent = text;
      item.title = text;
      item.addEventListener('click', () => {
        list.querySelectorAll('.cnav-item').forEach(x => x.classList.remove('active'));
        item.classList.add('active');
        jumpToKey(key);
      });
      list.appendChild(item);
    });
    scrollActiveIntoView();
  }

  // Bring the highlighted prompt into view within the menu's own scroll area.
  function scrollActiveIntoView() {
    const active = list.querySelector('.cnav-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // Update only the highlight + mounted markers, leaving DOM (and scroll
  // position) untouched.
  function updateActive(mountedPrompts) {
    const currentKey = lockedKey
      ? lockedKey
      : (mountedPrompts.length ? promptKeyOf(mountedPrompts[getCurrentIndex(mountedPrompts)]) : null);
    const mountedKeys = new Set(mountedPrompts.map(promptKeyOf));
    let changed = false;
    list.querySelectorAll('.cnav-item').forEach((el, i) => {
      const key = masterOrder[i];
      const on = key === currentKey;
      if (on && !el.classList.contains('active')) changed = true;
      el.classList.toggle('active', on);
      el.classList.toggle('cnav-mounted', mountedKeys.has(key));
    });
    // Follow the highlight, but don't yank the menu while the user browses it.
    if (changed && !panelBusy) scrollActiveIntoView();
  }

  // Track whether the user is interacting with the panel so we never rebuild
  // out from under them.
  let panelBusy = false;
  list.addEventListener('mouseenter', () => { panelBusy = true; });
  list.addEventListener('mouseleave', () => { panelBusy = false; buildList(); });
  list.addEventListener('scroll', () => {
    panelBusy = true;
    clearTimeout(list._idle);
    list._idle = setTimeout(() => { panelBusy = false; buildList(); }, 600);
  });

  // Keep the list fresh, but only on real structural changes and never mid-interaction.
  let refreshTimer = null;
  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (!panelBusy) buildList(); }, delay);
  }

  const mo = new MutationObserver(() => {
    if (panelBusy) return;
    scheduleRefresh(400);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // Claude's chat pane mounts older history as you scroll it toward the top,
  // which is itself a DOM mutation the observer above should catch — but
  // scroll events on that internal container don't bubble, so listening in
  // the capture phase here is what actually catches "the user just scrolled"
  // as a second, more immediate trigger to refresh the list.
  document.addEventListener('scroll', () => scheduleRefresh(300), true);

  // Safety net: if a refresh got dropped (e.g. mutations kept panelBusy true
  // the whole time), this guarantees the list eventually catches up.
  setInterval(() => { if (!panelBusy) buildList(); }, 1500);

  buildList(true);

  // ── HUD ─────────────────────────────────────────────────────────────────
  let hudTimer;
  function showHud(dir, n, total) {
    hud.textContent = `${dir}  prompt ${n} / ${total}`;
    hud.style.opacity = '1';
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => { hud.style.opacity = '0'; }, 1200);
  }

})();
