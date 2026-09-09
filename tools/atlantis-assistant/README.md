# Atlantis Personal AI Command Center (v2)

A local-only desktop assistant: chat via a local Ollama model (with real
tool use), web search, stock quotes, text-to-speech, hands-free voice
mode, browser automation, allow-listed file/app access, read-only
calendar/email, and scheduled daily briefs. No cloud AI account required.

This is a rebuild of a version originally created with ChatGPT.

## The safety design (read this before using tools/browser/files)

Atlantis can now actually **do** things, not just talk. That capability is
built around one hard rule:

> Reading, listing, navigating, and opening things you've explicitly
> allowed runs immediately. Anything that **writes, deletes, clicks, or
> fills a form** is queued in **Approvals** and only happens once you
> click Approve — there is no way to make it skip that, from chat, from a
> scheduled mission, or from any tool call, regardless of phrasing.

Concretely:
- **Files**: nothing is accessible until you add a folder to the allow-list
  in Settings. Even an *approved* write/delete is still hard-rejected if
  the path resolves outside every allow-listed folder — approval doesn't
  widen the boundary, it only confirms an action already inside it.
- **Apps**: Atlantis can only launch applications you've explicitly named
  in Settings → Apps (name → full path). No arbitrary command execution.
- **Browser**: clicking and typing into forms always requires approval.
  Navigating and reading a page does not (that's equivalent to you opening
  a tab yourself).
- **Calendar/Email**: read-only. There is no send-email or edit-calendar
  tool in this build at all — not gated, just absent — so there's nothing
  for a prompt injection or a model mistake to invoke.
- **No trading or purchasing tool exists.** If you ask Atlantis to place a
  trade or buy something, it will tell you it can't — that's not a filter
  catching it, it genuinely has no such capability.

This intentionally stops short of full computer control ("access
everything, click anywhere, use whatever's already logged in"). Small
local models like the default `qwen2.5-coder:3b` make mistakes; pairing
that with unscoped, unconfirmed access to real accounts is how you get an
accidental trade, a deleted file, or a sent message you never asked for.
The approval queue and allow-lists are what make broad capability safe to
actually turn on.

## The dedicated browser profile

Browser automation launches its **own** Chromium profile at
`~/.atlantis/browser-profile`, separate from your everyday Chrome. The
first time you need a logged-in site (TradingView, etc.), open it from the
**Browser** tab and sign in there once — the session persists after that.
This keeps the blast radius to exactly what you choose to log into in that
window, instead of exposing every account already logged into your main
browser (email, banking, everything else) to page navigation a model
controls.

## What's implemented

- Chat with a local Ollama model, with short-term conversation memory and
  **real tool use**: the model can list/read allow-listed files, launch
  allow-listed apps, open/read the Atlantis browser, and check your
  calendar/inbox — proposing (not silently doing) anything that writes,
  deletes, clicks, or fills a form.
- **Pending Approvals** tab: every queued action, with a plain-English
  description of exactly what it will do, and Approve/Reject buttons.
- **Browser** tab: open a URL, read the page's visible text, take a
  screenshot — using the dedicated Atlantis profile above.
- **Calendar / Email** tab: read-only upcoming events and recent messages,
  via your own Google OAuth credentials (see setup below).
- Web search (DuckDuckGo) and stock quotes (Yahoo Finance) for the Market
  Brief / Lead Hunter / Income Finder missions, with clearer failure
  messages when a scraper breaks vs. genuinely finding nothing.
- Scheduled daily briefs via APScheduler.
- **Hands-free voice mode**: fully offline speech-to-text via
  [Vosk](https://alphacephei.com/vosk/) (no cloud speech API) plus local
  text-to-speech — toggle "Voice Mode" in the Command Center to talk to
  Atlantis and have it talk back, in a loop, with no typing.
- A CSRF guard (Origin check) on all state-changing API calls.

## Setup (Windows, one file, one double-click)

Download **`Atlantis_Setup.bat`** — that's the only file you need to get
started, nothing else. Double-click it and it will:

1. Download the actual Atlantis app files from this repo
2. Install Python/Ollama if you don't have them, and pull the local AI model
3. Install Playwright's browser and the offline voice model
4. Create an **Atlantis** icon on your Desktop
5. Ask **"Run Atlantis now? [Y/N]"** — press Y and it opens right there

It's a plain, readable batch file — open it in Notepad first if you want
to read every step before running it; nothing it does is hidden.

**From then on: double-click the Atlantis icon on your Desktop, nothing
else.** That one click starts Ollama in the background if it isn't already
running, launches the app, and opens its window.

Optional, after that first launch: add at least one folder under
Settings → File Access and any apps under Settings → Apps — nothing is
accessible until you explicitly add it there. Calendar/Email also needs a
one-time Google setup (below) if you want those tabs working.

If you already have the whole `tools/atlantis-assistant` folder copied
locally (rather than starting from just the one `.bat` file), `setup.bat`
does the same install steps without the download step, using the files
already sitting next to it.

## Manual setup (macOS/Linux, or if you'd rather do each step yourself)

1. Create a virtual environment and install requirements:
   ```
   python -m venv .venv
   .venv\Scripts\activate      (Windows)  /  source .venv/bin/activate (macOS/Linux)
   pip install -r requirements.txt
   ```
2. Install the Playwright browser (one-time, downloads Chromium):
   ```
   playwright install chromium
   ```
3. Install [Ollama](https://ollama.com) and pull a model. Tool-calling
   quality scales with model size/capability — the default is small and
   fast, but a larger Ollama model will use the tools more reliably if
   your hardware can run one:
   ```
   ollama pull qwen2.5-coder:3b
   ```
4. For voice mode, download a Vosk model (about 40 MB) and unzip it to
   `~/.atlantis/vosk-model` (so `~/.atlantis/vosk-model/am/final.mdl` etc.
   exist directly inside that folder):
   https://alphacephei.com/vosk/models → `vosk-model-small-en-us-0.15.zip`
5. **Optional — Calendar/Email (read-only):** this needs your own Google
   OAuth credentials, since it's your Google account:
   - Go to https://console.cloud.google.com/ → create a project (free).
   - APIs & Services → Library → enable "Google Calendar API" and
     "Gmail API".
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
     → Application type: **Desktop app**.
   - Download the JSON and save it as `~/.atlantis/google-credentials.json`.
   - The first time you open the Calendar or Email tab, your real browser
     will open asking you to sign in and approve read-only access — that's
     expected, and only happens once (a refresh token is cached after).
6. Open **Settings** in the app and add:
   - At least one folder under **File Access** before Atlantis can read or
     touch any file.
   - Any apps you want it able to launch under **Apps**
     (`name=C:\full\path\to.exe`, one per line).
7. Run it:
   ```
   python run_atlantis.py
   ```

If voice mode mishears you or cuts off too early/late, tune
`VOICE_SILENCE_RMS` near the top of `run_atlantis.py` — the right value
depends on your microphone and room noise.

## Files

- `run_atlantis.py` — the Flask app, UI, chat/tool-calling loop, voice.
- `atlantis_tools.py` — the capability layer: allow-listed files, allow-
  listed app launching, browser automation, read-only calendar/email, and
  the pending-approval queue that gates all of it. Read this file first if
  you want to understand exactly what Atlantis can and can't do.
- `Atlantis_Setup.bat` — the single-file starting point: downloads the app
  files from this repo, then runs the same install steps as `setup.bat`.
- `setup.bat` — one-time Windows installer for when you already have this
  whole folder locally; creates the Desktop shortcut.
- `Launch_Atlantis.vbs` — what that shortcut actually runs: starts Ollama
  if needed, then launches Atlantis, both without a console window.
