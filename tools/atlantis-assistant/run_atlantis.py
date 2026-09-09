"""
Atlantis Personal AI Command Center

A local-only desktop assistant: chat via a local Ollama model, web search,
stock quotes, text-to-speech, and scheduled daily briefs. Everything runs
on your machine — no cloud AI account, no data leaves except the explicit
search/quote calls to DuckDuckGo and Yahoo Finance's public endpoints.

Changes from the original ChatGPT-built version:
  - Distributed as plain files (no base64-embedded zip in a batch script) --
    a tool you own should be readable and diffable, not self-obfuscating.
  - Added short-term conversation memory to /api/chat (previously every
    message was sent with zero history, so it "forgot" mid-conversation).
  - Added an Origin check on all state-changing (POST) endpoints. The app
    is bound to 127.0.0.1 (good), but Flask had no CSRF protection, so any
    webpage open in your browser could silently POST to this server's API
    (e.g. trigger /api/stop or add a scheduled task) in the background.
  - Clearer failure messages when the DuckDuckGo/Yahoo scrapers break vs.
    genuinely finding nothing -- both used to look identical.
"""

import os
import json
import time
import array
import queue
import threading
import webbrowser
from pathlib import Path
from datetime import datetime

import requests
from bs4 import BeautifulSoup
from flask import Flask, request, jsonify, render_template_string, abort
from apscheduler.schedulers.background import BackgroundScheduler
import pyttsx3

try:
    import webview
except Exception:
    webview = None

try:
    import sounddevice as sd
    from vosk import Model as VoskModel, KaldiRecognizer
except Exception:
    sd = None
    VoskModel = None
    KaldiRecognizer = None

VERSION = "2.0.0"
HOST = "127.0.0.1"
PORT = 8765
SERVER_ORIGIN = f"http://{HOST}:{PORT}"

APP_DIR = Path.home() / ".atlantis"
APP_DIR.mkdir(exist_ok=True)
DATA_FILE = APP_DIR / "data.json"

DEFAULT_DATA = {
    "settings": {
        "ollama_url": "http://127.0.0.1:11434",
        "model": "qwen2.5-coder:3b",
        "speak": True,
        "city": "",
        "job_radius": "40",
        "trading_symbols": ["SPY", "QQQ", "AAPL", "NVDA", "TSLA"],
        "business_terms": ["electrical contractor", "HVAC", "remodeling contractor"]
    },
    "tasks": [],
    "history": []
}


def load_data():
    if not DATA_FILE.exists():
        DATA_FILE.write_text(json.dumps(DEFAULT_DATA, indent=2))
    try:
        data = json.loads(DATA_FILE.read_text())
    except Exception:
        data = json.loads(json.dumps(DEFAULT_DATA))
    for key, val in DEFAULT_DATA.items():
        data.setdefault(key, val)
    return data


DATA = load_data()
LOCK = threading.Lock()

# Short-term chat memory. Deliberately in-memory only (resets when Atlantis
# restarts) rather than persisted -- this is "what we're mid-conversation
# about right now," not a permanent record; the History tab already keeps
# a permanent log of every chat/mission.
CONVERSATION = []
MAX_CONVERSATION_TURNS = 8  # user+assistant pairs kept as context


def save_data():
    with LOCK:
        DATA_FILE.write_text(json.dumps(DATA, indent=2))


def add_history(kind, title, detail):
    DATA["history"].insert(0, {
        "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "kind": kind,
        "title": title,
        "detail": detail[:6000]
    })
    DATA["history"] = DATA["history"][:250]
    save_data()


def speak(text, block=False):
    """
    block=True runs speech synchronously in the calling thread (used by
    /api/speak so the voice loop knows exactly when speaking finished,
    rather than guessing with a timer). block=False fires it in the
    background, used for one-off notifications like the daily brief.
    """
    if not DATA["settings"].get("speak", True):
        return

    def worker():
        try:
            engine = pyttsx3.init()
            engine.setProperty("rate", 185)
            engine.say(text[:1200])
            engine.runAndWait()
        except Exception:
            pass

    if block:
        worker()
    else:
        threading.Thread(target=worker, daemon=True).start()


# ───────────────────── Offline voice input (Vosk) ─────────────────────
# Deliberately local: speech recognition runs entirely on your machine via
# Vosk, not a cloud speech API. Setup downloads the model once from Vosk's
# official site (see setup.bat) -- nothing about this calls out to anyone
# while you're actually talking to Atlantis.
VOSK_MODEL_DIR = APP_DIR / "vosk-model"
VOICE_SAMPLE_RATE = 16000
VOICE_SILENCE_RMS = 500          # tune per microphone -- see README
VOICE_MAX_SECONDS = 15
VOICE_SILENCE_HANGOVER = 1.2

_vosk_model = None


def get_vosk_model():
    global _vosk_model
    if VoskModel is None or sd is None:
        raise RuntimeError("Voice packages not installed. Run setup.bat again to install vosk/sounddevice.")
    if _vosk_model is None:
        if not VOSK_MODEL_DIR.exists():
            raise RuntimeError(
                f"Voice model not found at {VOSK_MODEL_DIR}. Run setup.bat again, "
                "or manually download a model from https://alphacephei.com/vosk/models "
                "and unzip it there."
            )
        _vosk_model = VoskModel(str(VOSK_MODEL_DIR))
    return _vosk_model


def listen_and_transcribe():
    """
    Records from the default microphone until roughly VOICE_SILENCE_HANGOVER
    seconds of silence follow detected speech, or VOICE_MAX_SECONDS is hit.
    Fully offline. Returns the transcribed text ('' if nothing intelligible
    was captured).
    """
    model = get_vosk_model()
    rec = KaldiRecognizer(model, VOICE_SAMPLE_RATE)
    audio_q = queue.Queue()

    def callback(indata, frames, time_info, status):
        audio_q.put(bytes(indata))

    heard_speech = False
    silence_since = None
    start = time.time()

    with sd.RawInputStream(samplerate=VOICE_SAMPLE_RATE, blocksize=4000, dtype="int16",
                            channels=1, callback=callback):
        while True:
            try:
                chunk = audio_q.get(timeout=1.0)
            except queue.Empty:
                break

            samples = array.array("h", chunk)
            rms = (sum(s * s for s in samples) / max(len(samples), 1)) ** 0.5

            if rms > VOICE_SILENCE_RMS:
                heard_speech = True
                silence_since = None
            elif heard_speech and silence_since is None:
                silence_since = time.time()

            rec.AcceptWaveform(chunk)

            if heard_speech and silence_since and (time.time() - silence_since) > VOICE_SILENCE_HANGOVER:
                break
            if (time.time() - start) > VOICE_MAX_SECONDS:
                break

    final = json.loads(rec.FinalResult())
    return final.get("text", "").strip()


SYSTEM_PROMPT = """You are Atlantis, a private personal AI command center.
Be concise, practical, and action-oriented. You help with coding, planning, business ideas,
market research, electrical/HVAC/remodeling lead research, online opportunity research,
browser workflows, and everyday questions. Never claim guaranteed market results.
Never execute purchases, trades, destructive file actions, or irreversible actions without
explicit confirmation. Prefer free/local approaches. When asked to code, produce complete,
runnable code where possible."""


def ollama_chat(prompt, system=None, use_conversation=False):
    url = DATA["settings"].get("ollama_url", "http://127.0.0.1:11434").rstrip("/")
    model = DATA["settings"].get("model", "qwen2.5-coder:3b")

    messages = [{"role": "system", "content": system or SYSTEM_PROMPT}]
    if use_conversation:
        messages.extend(CONVERSATION)
    messages.append({"role": "user", "content": prompt})

    payload = {"model": model, "stream": False, "messages": messages}
    try:
        r = requests.post(url + "/api/chat", json=payload, timeout=180)
        r.raise_for_status()
        answer = r.json()["message"]["content"]
        if use_conversation:
            CONVERSATION.append({"role": "user", "content": prompt})
            CONVERSATION.append({"role": "assistant", "content": answer})
            del CONVERSATION[: max(0, len(CONVERSATION) - MAX_CONVERSATION_TURNS * 2)]
        return answer
    except Exception as e:
        return (
            "I could not reach the local AI model. Atlantis is still usable for browser and automation tasks. "
            f"Start Ollama and make sure the model '{model}' is installed. Technical detail: {e}"
        )


def ddg_search(query, max_results=8):
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        r = requests.post("https://html.duckduckgo.com/html/", data={"q": query}, headers=headers, timeout=20)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        anchors = soup.select(".result__a")
        if not anchors:
            return [{
                "title": "No results parsed",
                "url": "",
                "snippet": (
                    "DuckDuckGo returned a page but the expected result markup wasn't found -- "
                    "their HTML likely changed. This is a scraper break, not necessarily zero results. "
                    "Try the query manually at duckduckgo.com to check."
                ),
            }]
        out = []
        for a in anchors[:max_results]:
            href = a.get("href", "")
            title = a.get_text(" ", strip=True)
            parent = a.find_parent(class_="result")
            snippet = ""
            if parent:
                s = parent.select_one(".result__snippet")
                if s:
                    snippet = s.get_text(" ", strip=True)
            out.append({"title": title, "url": href, "snippet": snippet})
        return out
    except Exception as e:
        return [{"title": "Search request failed", "url": "", "snippet": f"Network/parse error: {e}"}]


def tradingview_url(symbol):
    return "https://www.tradingview.com/chart/?symbol=" + requests.utils.quote(symbol.upper(), safe="")


def market_quote(symbol):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol.upper()}?range=5d&interval=1d"
    try:
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
        r.raise_for_status()
        result = r.json()["chart"]["result"][0]
        meta = result["meta"]
        q = result["indicators"]["quote"][0]
        closes = [x for x in q.get("close", []) if x is not None]
        if not closes:
            raise ValueError("No quote data in response (Yahoo's unofficial endpoint may have changed shape)")
        last = closes[-1]
        prev = closes[-2] if len(closes) > 1 else last
        pct = ((last - prev) / prev * 100) if prev else 0
        return {"symbol": symbol.upper(), "price": round(last, 2), "change_pct": round(pct, 2), "currency": meta.get("currency", "")}
    except Exception as e:
        return {"symbol": symbol.upper(), "error": str(e)}


def market_brief():
    quotes = [market_quote(s) for s in DATA["settings"].get("trading_symbols", [])[:12]]
    lines = []
    for q in quotes:
        if "error" in q:
            lines.append(f"{q['symbol']}: unavailable ({q['error']})")
        else:
            lines.append(f"{q['symbol']}: {q['price']} {q['currency']} ({q['change_pct']:+.2f}% vs prior close)")
    raw = "\n".join(lines)
    analysis = ollama_chat(
        "Review this market snapshot and give me a risk-aware watchlist briefing. "
        "Do not promise returns or call any trade certain. Highlight movers, possible areas to research, "
        "and questions I should check on the chart.\n\n" + raw
    )
    result = raw + "\n\nAtlantis analysis:\n" + analysis
    add_history("market", "Market brief", result)
    return result


def lead_hunt():
    city = DATA["settings"].get("city", "").strip()
    radius = DATA["settings"].get("job_radius", "40")
    terms = DATA["settings"].get("business_terms", [])
    location = f" near {city}" if city else ""
    all_results = []
    for term in terms:
        all_results.extend(ddg_search(f"{term} jobs bids subcontractor opportunities{location}", 5))
    compact = "\n".join(f"- {x['title']} | {x['snippet']} | {x['url']}" for x in all_results)
    analysis = ollama_chat(
        f"Rank these search results for a contractor looking for electrical, HVAC, and house-remodeling work "
        f"within roughly {radius} miles. Separate likely leads from directories and weak matches. "
        f"Point out what to verify before contacting anyone.\n\n{compact}"
    )
    result = analysis + "\n\nSources:\n" + compact
    add_history("leads", "Business lead hunt", result)
    return result


def opportunity_hunt():
    results = []
    for q in [
        "legitimate online contract work remote small business opportunities",
        "freelance construction estimating remote opportunities",
        "online side business opportunities contractor"
    ]:
        results.extend(ddg_search(q, 5))
    compact = "\n".join(f"- {x['title']} | {x['snippet']} | {x['url']}" for x in results)
    analysis = ollama_chat(
        "Evaluate these online money-making opportunity results. Prioritize realistic, legal, "
        "low-upfront-cost options. Flag scam signals, upfront-fee traps, and anything needing independent "
        "verification. Give me the best five avenues to investigate.\n\n" + compact
    )
    result = analysis + "\n\nSources:\n" + compact
    add_history("income", "Online opportunity hunt", result)
    return result


def daily_brief():
    result = "\n\n====================\n\n".join([
        "ATLANTIS DAILY BRIEF",
        market_brief(),
        lead_hunt(),
        opportunity_hunt()
    ])
    add_history("brief", "Daily brief", result)
    speak("Your Atlantis daily brief is ready.", block=False)
    return result


def run_named_task(kind):
    if kind == "market":
        return market_brief()
    if kind == "leads":
        return lead_hunt()
    if kind == "income":
        return opportunity_hunt()
    if kind == "daily":
        return daily_brief()
    return "Unknown task"


scheduler = BackgroundScheduler(daemon=True)
scheduler.start()


def schedule_saved_tasks():
    for job in scheduler.get_jobs():
        job.remove()
    for t in DATA.get("tasks", []):
        if not t.get("enabled", True):
            continue
        try:
            hour, minute = map(int, t.get("time", "07:00").split(":"))
            scheduler.add_job(run_named_task, "cron", hour=hour, minute=minute,
                               args=[t["kind"]], id=t["id"], replace_existing=True)
        except Exception:
            pass


schedule_saved_tasks()

app = Flask(__name__)


@app.before_request
def block_cross_origin_posts():
    """
    Reject state-changing requests whose Origin header doesn't match this
    server's own origin. The app only binds to 127.0.0.1, but Flask has no
    CSRF protection by default -- without this, any webpage open in your
    browser could silently POST to these endpoints in the background.
    Requests with no Origin header (curl, the pywebview shell itself in
    some configurations) are allowed through, since the real threat here is
    a THIRD-PARTY page's browser-issued fetch, which always carries Origin.
    """
    if request.method != "GET":
        origin = request.headers.get("Origin")
        if origin and not origin.startswith(SERVER_ORIGIN):
            abort(403)


HTML = r'''<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Atlantis</title>
<style>
:root{--bg:#070b14;--panel:#0e1625;--text:#ecf7ff;--muted:#8aa0b8;--accent:#66e3ff;--danger:#ff6b7c;--ok:#66f2b1}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0%,#10243a 0,#070b14 40%);color:var(--text);font-family:Inter,Segoe UI,Arial,sans-serif}
.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
.side{padding:22px 14px;border-right:1px solid #1c2a3d;background:#09111dcc;backdrop-filter:blur(16px)}
.brand{font-size:23px;font-weight:800;letter-spacing:3px;margin:6px 8px 24px}.brand span{color:var(--accent)}
.ver{font-size:11px;color:var(--muted);margin:-18px 8px 20px}
.nav button{width:100%;text-align:left;background:transparent;border:0;color:var(--muted);padding:12px 13px;border-radius:10px;margin:3px 0;cursor:pointer;font-size:14px}
.nav button:hover,.nav button.active{background:#132238;color:white}
#voiceModeBtn.active{background:linear-gradient(90deg,var(--accent),#7b8cff);color:#06101a}
.main{padding:24px;max-width:1400px;width:100%;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.status{font-size:12px;color:var(--ok);padding:7px 11px;border:1px solid #24533f;border-radius:999px}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.card{background:linear-gradient(180deg,#0f1a2b,#0b1320);border:1px solid #1d3048;border-radius:16px;padding:16px;box-shadow:0 10px 40px #0005}
.hero{grid-column:span 8}.sidecard{grid-column:span 4}.full{grid-column:1/-1}.half{grid-column:span 6}
h1,h2,h3{margin:0 0 10px}h1{font-size:30px}.muted{color:var(--muted)}textarea,input,select{width:100%;background:#09111d;border:1px solid #233851;color:white;border-radius:10px;padding:11px;outline:none}
textarea{min-height:150px;resize:vertical}.row{display:flex;gap:9px;align-items:center}.btn{background:linear-gradient(90deg,var(--accent),#7b8cff);color:#06101a;border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}.btn.secondary{background:#17263a;color:white}.btn.danger{background:#43202a;color:#ffdfe3}
.quick{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.quick button{padding:16px;text-align:left}pre{white-space:pre-wrap;word-wrap:break-word;background:#08101b;border:1px solid #1b2d43;padding:14px;border-radius:10px;max-height:430px;overflow:auto;color:#d8ecff}
.item{padding:11px;border-bottom:1px solid #19283a}.small{font-size:12px}.hidden{display:none}
@media(max-width:900px){.shell{grid-template-columns:1fr}.side{display:none}.hero,.sidecard,.half{grid-column:1/-1}.main{padding:14px}}
</style>
</head>
<body>
<div class="shell">
<aside class="side">
<div class="brand">ATLAN<span>TIS</span></div>
<div class="ver">v''' + VERSION + r'''</div>
<div class="nav">
<button class="active" onclick="show('command',this)">Command Center</button>
<button onclick="show('markets',this)">Markets</button>
<button onclick="show('leads',this)">Lead Hunter</button>
<button onclick="show('income',this)">Income Finder</button>
<button onclick="show('automations',this)">Automations</button>
<button onclick="show('history',this)">Activity / Memory</button>
<button onclick="show('settings',this)">Settings</button>
</div>
</aside>
<main class="main">
<div class="top"><div><div class="muted small">PRIVATE PERSONAL AI SYSTEM</div><h2>Atlantis</h2></div><div class="status">● LOCAL CONTROL READY</div></div>

<section id="command">
<div class="grid">
<div class="card hero">
<h1>What do you want Atlantis to do?</h1>
<p class="muted">Ask a question, write code, plan something, research a business idea, or tell Atlantis what you need. This chat now remembers the last few turns.</p>
<textarea id="prompt" placeholder="Example: Build me a simple landing page for my remodeling business..."></textarea>
<div class="row" style="margin-top:10px"><button class="btn" onclick="ask()">Run task</button><button class="btn secondary" onclick="speakLast()">Speak last answer</button><button class="btn secondary" onclick="clearConversation()">New conversation</button></div>
<div class="row" style="margin-top:10px"><button class="btn secondary" id="voiceModeBtn" onclick="toggleVoiceMode()">🎤 Voice Mode: OFF</button><span id="voiceStatus" class="muted small"></span></div>
<pre id="answer">Atlantis is ready.</pre>
</div>
<div class="card sidecard">
<h3>One-click missions</h3>
<div class="quick">
<button class="btn secondary" onclick="mission('market')">Market brief</button>
<button class="btn secondary" onclick="mission('leads')">Find jobs</button>
<button class="btn secondary" onclick="mission('income')">Money ideas</button>
<button class="btn secondary" onclick="mission('daily')">Full daily brief</button>
</div>
<h3 style="margin-top:18px">TradingView</h3>
<input id="tvSymbol" value="SPY"/>
<button class="btn secondary" style="margin-top:9px" onclick="openTV()">Open chart</button>
</div>
</div>
</section>

<section id="markets" class="hidden"><div class="grid"><div class="card full">
<h2>Trading Copilot</h2><p class="muted">Research and chart monitoring only. Atlantis does not place trades from this build.</p>
<button class="btn" onclick="mission('market')">Generate market brief</button><pre id="marketOut">No market brief yet.</pre>
</div></div></section>

<section id="leads" class="hidden"><div class="grid"><div class="card full">
<h2>Business Lead Hunter</h2><p class="muted">Searches for electrical, HVAC, remodeling, subcontracting, and service opportunities.</p>
<button class="btn" onclick="mission('leads')">Search now</button><pre id="leadsOut">No lead search yet.</pre>
</div></div></section>

<section id="income" class="hidden"><div class="grid"><div class="card full">
<h2>Income Opportunity Finder</h2><p class="muted">Looks for legitimate online opportunities and flags common scam signals.</p>
<button class="btn" onclick="mission('income')">Research opportunities</button><pre id="incomeOut">No opportunity search yet.</pre>
</div></div></section>

<section id="automations" class="hidden"><div class="grid">
<div class="card half"><h2>Create automation</h2>
<label>Mission</label><select id="taskKind"><option value="daily">Full daily brief</option><option value="market">Market brief</option><option value="leads">Lead hunt</option><option value="income">Income opportunities</option></select>
<label>Run every day at</label><input id="taskTime" type="time" value="07:00"/>
<button class="btn" style="margin-top:10px" onclick="addTask()">Add automation</button></div>
<div class="card half"><h2>Scheduled</h2><div id="taskList"></div></div>
</div></section>

<section id="history" class="hidden"><div class="grid"><div class="card full">
<h2>Activity / Memory</h2><button class="btn secondary" onclick="loadHistory()">Refresh</button><div id="historyList"></div>
</div></div></section>

<section id="settings" class="hidden"><div class="grid">
<div class="card half"><h2>Local AI</h2><label>Ollama URL</label><input id="ollama_url"/><label>Model</label><input id="model"/><p class="muted small">Recommended: qwen2.5-coder:3b. Change this to any Ollama model installed on your laptop.</p></div>
<div class="card half"><h2>Your area</h2><label>City / region</label><input id="city" placeholder="Example: Houston, TX"/><label>Lead radius (miles)</label><input id="job_radius"/></div>
<div class="card full"><h2>Watchlist</h2><input id="trading_symbols" placeholder="SPY, QQQ, AAPL"/><div class="row" style="margin-top:10px"><button class="btn" onclick="saveSettings()">Save settings</button><button class="btn danger" onclick="stopAtlantis()">Stop Atlantis</button></div></div>
</div></section>
</main></div>

<script>
let lastAnswer='';
function show(id,el){document.querySelectorAll('main section').forEach(x=>x.classList.add('hidden'));document.getElementById(id).classList.remove('hidden');document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));if(el)el.classList.add('active')}
async function post(url,data={}){let r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return await r.json()}
async function ask(){let p=document.getElementById('prompt').value.trim();if(!p)return;let out=document.getElementById('answer');out.textContent='Working…';let j=await post('/api/chat',{prompt:p});lastAnswer=j.answer;out.textContent=j.answer}
async function clearConversation(){await post('/api/chat/clear');document.getElementById('answer').textContent='Conversation cleared. Atlantis is ready.'}
let voiceModeOn=false, voiceBusy=false;
function setVoiceStatus(s){document.getElementById('voiceStatus').textContent=s}
async function toggleVoiceMode(){
  voiceModeOn=!voiceModeOn;
  let btn=document.getElementById('voiceModeBtn');
  btn.textContent=voiceModeOn?'🎤 Voice Mode: ON':'🎤 Voice Mode: OFF';
  btn.classList.toggle('active',voiceModeOn);
  if(voiceModeOn){setVoiceStatus('Starting…');if(!voiceBusy)voiceLoop()}else{setVoiceStatus('')}
}
async function voiceLoop(){
  if(!voiceModeOn)return;
  voiceBusy=true;
  setVoiceStatus('Listening… (speak now)');
  let r=await fetch('/api/listen',{method:'POST'});
  let j=await r.json();
  if(!voiceModeOn){voiceBusy=false;setVoiceStatus('');return}
  if(!j.ok){
    setVoiceStatus('Mic/voice error: '+j.error);
    voiceBusy=false;
    setTimeout(()=>{if(voiceModeOn)voiceLoop()},3000);
    return;
  }
  if(!j.text){
    setVoiceStatus('Heard nothing, listening again…');
    voiceBusy=false;
    if(voiceModeOn)voiceLoop();
    return;
  }
  document.getElementById('prompt').value=j.text;
  setVoiceStatus('Thinking…');
  let out=document.getElementById('answer');
  out.textContent='You said: "'+j.text+'"\n\nWorking…';
  let a=await post('/api/chat',{prompt:j.text});
  lastAnswer=a.answer;
  out.textContent='You said: "'+j.text+'"\n\n'+a.answer;
  if(voiceModeOn){
    setVoiceStatus('Speaking…');
    await post('/api/speak',{text:a.answer});
  }
  voiceBusy=false;
  if(voiceModeOn)voiceLoop();
}
async function mission(kind){let map={market:'marketOut',leads:'leadsOut',income:'incomeOut',daily:'answer'};let out=document.getElementById(map[kind]||'answer');out.textContent='Running '+kind+' mission…';let j=await post('/api/mission',{kind});lastAnswer=j.answer;out.textContent=j.answer}
async function openTV(){await post('/api/tradingview',{symbol:document.getElementById('tvSymbol').value})}
async function speakLast(){await post('/api/speak',{text:lastAnswer||'Atlantis is ready.'})}
async function addTask(){await post('/api/tasks/add',{kind:document.getElementById('taskKind').value,time:document.getElementById('taskTime').value});loadTasks()}
async function loadTasks(){let r=await fetch('/api/tasks'),j=await r.json();document.getElementById('taskList').innerHTML=j.tasks.map(t=>`<div class="item"><b>${t.kind}</b> daily at ${t.time} <button onclick="delTask('${t.id}')">remove</button></div>`).join('')||'<div class="muted">No automations yet.</div>'}
async function delTask(id){await post('/api/tasks/delete',{id});loadTasks()}
async function loadHistory(){let r=await fetch('/api/history'),j=await r.json();document.getElementById('historyList').innerHTML=j.history.map(h=>`<div class="item"><b>${escapeHtml(h.title)}</b><div class="muted small">${h.ts} · ${h.kind}</div><div class="small">${escapeHtml(h.detail.slice(0,500))}</div></div>`).join('')}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
async function loadSettings(){let r=await fetch('/api/settings'),j=await r.json();for(let k of ['ollama_url','model','city','job_radius'])document.getElementById(k).value=j[k]||'';document.getElementById('trading_symbols').value=(j.trading_symbols||[]).join(', ')}
async function saveSettings(){let p={};for(let k of ['ollama_url','model','city','job_radius'])p[k]=document.getElementById(k).value;p.trading_symbols=document.getElementById('trading_symbols').value.split(',').map(x=>x.trim()).filter(Boolean);await post('/api/settings',p);alert('Saved')}
async function stopAtlantis(){if(confirm('Stop Atlantis now?'))await post('/api/stop')}
loadTasks();loadSettings();
</script>
</body></html>'''


@app.get("/")
def home():
    return render_template_string(HTML)


@app.post("/api/chat")
def api_chat():
    p = request.json.get("prompt", "").strip()
    answer = ollama_chat(p, use_conversation=True)
    add_history("chat", p[:80] or "Chat", answer)
    return jsonify(answer=answer)


@app.post("/api/chat/clear")
def api_chat_clear():
    CONVERSATION.clear()
    return jsonify(ok=True)


@app.post("/api/mission")
def api_mission():
    return jsonify(answer=run_named_task(request.json.get("kind", "")))


@app.post("/api/tradingview")
def api_tradingview():
    symbol = request.json.get("symbol", "SPY")
    webbrowser.open(tradingview_url(symbol))
    return jsonify(ok=True)


@app.post("/api/speak")
def api_speak():
    # block=True: the response only returns once speech has actually
    # finished, so the voice loop's client-side JS knows exactly when it's
    # safe to start listening again instead of guessing with a timer.
    speak(request.json.get("text", ""), block=True)
    return jsonify(ok=True)


@app.post("/api/listen")
def api_listen():
    try:
        text = listen_and_transcribe()
    except Exception as e:
        return jsonify(ok=False, error=str(e), text="")
    return jsonify(ok=True, text=text)


@app.get("/api/settings")
def api_settings_get():
    return jsonify(DATA["settings"])


@app.post("/api/settings")
def api_settings_set():
    DATA["settings"].update(request.json or {})
    save_data()
    return jsonify(ok=True)


@app.get("/api/history")
def api_history():
    return jsonify(history=DATA["history"][:100])


@app.get("/api/tasks")
def api_tasks():
    return jsonify(tasks=DATA.get("tasks", []))


@app.post("/api/tasks/add")
def api_tasks_add():
    item = request.json or {}
    task = {"id": str(int(time.time() * 1000)), "kind": item.get("kind", "daily"), "time": item.get("time", "07:00"), "enabled": True}
    DATA.setdefault("tasks", []).append(task)
    save_data()
    schedule_saved_tasks()
    return jsonify(ok=True, task=task)


@app.post("/api/tasks/delete")
def api_tasks_delete():
    tid = request.json.get("id")
    DATA["tasks"] = [t for t in DATA.get("tasks", []) if t.get("id") != tid]
    save_data()
    schedule_saved_tasks()
    return jsonify(ok=True)


@app.post("/api/stop")
def api_stop():
    def bye():
        time.sleep(0.5)
        os._exit(0)

    threading.Thread(target=bye, daemon=True).start()
    return jsonify(ok=True)


def run_server():
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)


if __name__ == "__main__":
    threading.Thread(target=run_server, daemon=True).start()
    time.sleep(1.0)
    url = SERVER_ORIGIN
    if webview is not None:
        try:
            webview.create_window("Atlantis", url, width=1280, height=820, min_size=(900, 650))
            webview.start()
        except Exception:
            webbrowser.open(url)
            while True:
                time.sleep(60)
    else:
        webbrowser.open(url)
        while True:
            time.sleep(60)
