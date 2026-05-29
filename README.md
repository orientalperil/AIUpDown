# AI Chat Arrow Key Navigation

A Chrome extension (Manifest V3) that lets you jump between *your own prompts*
on Claude, Grok, and ChatGPT using **Option+Up / Option+Down**, plus a floating
prompt menu with up/down buttons and a clickable list of every prompt in the
conversation.

Converted from a Tampermonkey/Greasemonkey userscript (v1.6).

## Features

- **Option+Up / Option+Down** — jump to the previous / next prompt in the thread.
- **Floating controls** (bottom-right) — up, down, and a menu toggle.
- **Prompt menu** — a scrollable list of all your prompts; click any to jump.
- **Light / dark theme** toggle, persisted via `localStorage`.
- Works on `claude.ai`, `chatgpt.com`, `chat.openai.com`, and `grok.com`.

## Supported sites

| Site | Match pattern |
|------|---------------|
| Claude | `https://claude.ai/*` |
| ChatGPT | `https://chatgpt.com/*`, `https://chat.openai.com/*` |
| Grok | `https://grok.com/*` |

## Project structure

```
AIUpDown/
├── manifest.json     # MV3 manifest (declares the content script + matches)
├── content.js        # the entire navigator (UI + logic), injected per page
├── icons/            # 16 / 48 / 128 px toolbar icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
└── CLAUDE.md
```

## Build

There is **no build step**. This is a plain, unbundled MV3 extension —
`content.js` is loaded directly as a content script. You only "build" if you
want a distributable `.zip` for the Chrome Web Store (see Packaging below).

If you regenerate the icons, any 16/48/128 px PNGs with transparency will do.

## Install (load unpacked, for development)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select this folder: `/Users/admin/repos/AIUpDown/`.
5. Open `https://claude.ai`, `https://chatgpt.com`, or `https://grok.com`
   and start a conversation with at least one prompt.

After editing `content.js`, click the **reload** (↻) icon on the extension
card in `chrome://extensions`, then refresh the chat tab.

## Test

1. Load the extension (above) and open a chat with several of your prompts.
2. Press **Option+Down** — the page should smooth-scroll to the next prompt and a
   small HUD (e.g. `↓  prompt 2 / 5`) should flash bottom-right.
3. Press **Option+Up** — it should step back.
4. Click the **menu (☰)** button bottom-right — the prompt list should open;
   clicking an entry jumps to that prompt.
5. Click the **sun/moon** button in the menu header to toggle theme; reload the
   page and confirm the choice persists.

If nothing appears: open DevTools → Console on the chat tab and check for
errors, and confirm the site's DOM still matches the selectors in
`content.js` (the chat sites change markup occasionally — see CLAUDE.md).

## Packaging for the Chrome Web Store (optional)

Create a zip of the folder contents (not the parent folder):

```bash
cd /Users/admin/repos/AIUpDown
zip -r ../AIUpDown.zip . -x '*.git*' 'CLAUDE.md'
```

Then upload `AIUpDown.zip` in the Chrome Web Store Developer Dashboard.

## Notes on the conversion from the userscript

- The `// ==UserScript==` metadata block was removed; the script body was
  already a self-contained IIFE and runs unchanged as a content script.
- `@match` patterns map directly to `content_scripts[].matches`.
- `@grant none` means there were **no** `GM_*` APIs to replace — the script
  uses standard `localStorage`, which works fine in a content script.
- No background service worker is needed (no cross-origin `GM_xmlhttpRequest`,
  no notifications, no storage API beyond `localStorage`).
- `@run-at` was not specified in the source, so the manifest uses
  `document_idle` (Chrome's default), which is appropriate here.
