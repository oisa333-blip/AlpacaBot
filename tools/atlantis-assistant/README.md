# Atlantis Personal AI Command Center (v2)

A local-only desktop assistant: chat via a local Ollama model, web search,
stock quotes, text-to-speech, hands-free voice mode, and scheduled daily
briefs. Everything runs on your machine — no cloud AI account required.

This is a rebuild of a version originally created with ChatGPT. See
`run_atlantis.py`'s module docstring for the specific changes made and why.

## Status

This directory currently contains the application (`run_atlantis.py`) and
its Python dependencies (`requirements.txt`). Setup/launcher scripts
(one-click Desktop shortcut, Ollama auto-start, voice-model download) are
still being finalized — a broader "computer control" capability (browser
automation, wider file access, OS automation) was requested and is being
scoped with explicit safety gates (confirmation required before anything
that sends, deletes, purchases, or trades) before being built, rather than
shipped as unrestricted access.

## What's implemented so far

- Chat with a local Ollama model, with short-term conversation memory.
- Web search (DuckDuckGo) and stock quotes (Yahoo Finance) for the
  Market Brief / Lead Hunter / Income Finder missions.
- Scheduled daily briefs via APScheduler.
- Text-to-speech (local, via `pyttsx3`).
- **Hands-free voice mode**: fully offline speech-to-text via
  [Vosk](https://alphacephei.com/vosk/) (no cloud speech API) — toggle
  "Voice Mode" in the Command Center to talk to Atlantis and have it talk
  back, in a loop, with no typing.
- A CSRF guard on all state-changing API calls (Origin header check).

## Manual setup (until the one-click installer lands)

1. Create a virtual environment and install requirements:
   ```
   python -m venv .venv
   .venv\Scripts\activate      (Windows)  /  source .venv/bin/activate (macOS/Linux)
   pip install -r requirements.txt
   ```
2. Install [Ollama](https://ollama.com) and pull a model:
   ```
   ollama pull qwen2.5-coder:3b
   ```
3. For voice mode, download a Vosk model (about 40 MB) and unzip it to
   `~/.atlantis/vosk-model` (so that `~/.atlantis/vosk-model/am/final.mdl`
   etc. exist directly inside that folder):
   https://alphacephei.com/vosk/models → `vosk-model-small-en-us-0.15.zip`
4. Run it:
   ```
   python run_atlantis.py
   ```

If voice mode mishears you or cuts off too early/late, tune
`VOICE_SILENCE_RMS` near the top of `run_atlantis.py` — the right value
depends on your microphone and room noise.
