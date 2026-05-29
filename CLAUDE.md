# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## What this is

A **Manifest V3 Chrome extension** that adds keyboard + on-screen navigation
between a user's own prompts in AI chat UIs (Claude, Grok, ChatGPT). It was
converted from a Tampermonkey userscript; all behavior lives in a single
content script.

## Architecture

- **`manifest.json`** — MV3. Declares one `content_scripts` entry that injects
  `content.js` into the four supported origins at `document_idle`. There is no
  background service worker, no popup, and no `permissions` block (none are
  needed — the script only touches the page DOM and `localStorage`).
- **`content.js`** — the whole thing: prompt detection, scroll/anchor math, the
  keyboard handler, and the injected floating UI (controls, menu, HUD, theme).
  It is a single IIFE that runs in the page's content-script world.
- **`icons/`** — 16/48/128 px PNGs (indigo rounded square with up/down
  chevrons, matching the `#6366f1` accent used in the UI).

There is **no build system, no bundler, no dependencies, and no transpile
step.** Edit `content.js` directly; reload the extension to test.

## How to work on it

1. Edit `content.js` (or `manifest.json`).
2. In `chrome://extensions` (Developer mode on), click reload (↻) on the card.
3. Refresh the open chat tab to re-inject the updated script.
4. Debug via DevTools → Console on the chat tab (the content script logs there).

## Key design points (don't regress these)

- **Host-aware prompt detection.** `getPrompts()` dispatches to per-site
  functions. Each has a primary selector plus fallbacks because these sites
  change their DOM frequently:
  - Claude: `[data-testid^="user-message"]`
  - ChatGPT: `[data-message-author-role="user"]`
  - Grok: `[data-testid="user-message"]`, with right-alignment inference as a
    last resort.
  If navigation breaks on one site, the selector is almost always the cause —
  fix it in that site's `getPrompts*` function, keep the fallbacks.
- **Scroll container detection.** `getScroller()` walks up from the first
  prompt to find the actual scrollable element (these apps don't always scroll
  `window`). Don't hard-code `window`.
- **Smooth-scroll + drift correction.** `scrollToPrompt()` issues a smooth
  scroll, waits for it to settle, then makes a *single* correction only if
  lazy-loaded content shifted the layout by >24px. Don't fight the animation
  with repeated re-scrolls.
- **Highlight locking.** `lockHighlight()` holds the manually chosen index for
  ~1.2s so the MutationObserver doesn't re-highlight based on a mid-scroll
  position. Preserve this when touching navigation.
- **Panel-busy guarding.** `panelBusy` prevents the list from rebuilding while
  the user is hovering/scrolling the menu. Keep rebuilds gated on it.

## Conventions

- All injected DOM IDs/classes are namespaced with `cnav-` to avoid colliding
  with host-page styles. Keep that prefix for anything new.
- Theme is light by default, toggled via the header sun/moon button, persisted
  under the `localStorage` key `cnav-theme` (`"dark"` / `"light"`).
- The `z-index` for injected UI is `99999`; keep injected elements above page
  chrome.

## Common tasks

- **Add a new supported site:** add the `https://…/*` pattern to
  `manifest.json` → `content_scripts[0].matches`, add a host check
  (`IS_*`) and a `getPrompts*()` function, and wire it into `getPrompts()`.
- **Change the shortcut:** the keydown handler at the "Keyboard" section keys
  off `e.altKey` + `ArrowUp/ArrowDown`. (If you ever want a user-configurable
  shortcut via Chrome's UI, that would require a `commands` block in the
  manifest and a different handling approach — not currently used.)
- **Regenerate icons:** any transparent 16/48/128 px PNGs work; match the
  indigo `#6366f1` + white chevron look.

## Gotchas

- These chat sites are SPAs — the DOM mutates constantly. The MutationObserver
  is intentionally debounced (400ms) and gated; don't make it eager.
- `localStorage` is per-origin, so the theme choice is independent on each
  site. That's expected behavior, not a bug.
- No `permissions` are required; if you add a feature that needs one (e.g.
  `storage` for cross-site sync, or a background worker), update both the
  manifest and this file.
