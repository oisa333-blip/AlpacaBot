"""
Atlantis capability layer: allow-listed file access, allow-listed app
launching, browser automation, and read-only calendar/email.

Safety design (the whole point of this module): reading, listing,
navigating, and opening things you've already explicitly allowed runs
immediately, with no prompt. Anything that WRITES, DELETES, CLICKS, or
FILLS A FORM is queued as a pending action and only actually happens once
you approve it in the Atlantis window. There is no path through this
module that bypasses that queue for those categories -- not from the chat
model, not from a scheduled mission, regardless of what's asked. File
access is additionally hard-capped to folders on your allow-list even
once approved; there's no way to approve your way to a path outside it.

Browser automation uses its OWN dedicated Chromium profile
(~/.atlantis/browser-profile), not your everyday Chrome profile. Sign into
TradingView (or anything else) once inside the Atlantis browser window --
that keeps the blast radius to exactly what you choose to log into there,
instead of exposing every account already logged into your main browser
(email, banking, everything else) to page navigation a model controls.
"""

import time
import uuid
import hashlib
import threading
import subprocess
from pathlib import Path
from datetime import datetime

APP_DIR = Path.home() / ".atlantis"
APP_DIR.mkdir(exist_ok=True)
BROWSER_PROFILE_DIR = APP_DIR / "browser-profile"
SCREENSHOT_DIR = APP_DIR / "screenshots"
SCREENSHOT_DIR.mkdir(exist_ok=True)
GOOGLE_TOKEN_FILE = APP_DIR / "google-token.json"
GOOGLE_CREDENTIALS_FILE = APP_DIR / "google-credentials.json"


# ───────────────────── Pending action queue (the safety gate) ─────────────────────
_LOCK = threading.Lock()
PENDING_ACTIONS = {}     # id -> action dict, status == "pending"
COMPLETED_ACTIONS = []   # most recent resolved actions, capped, newest first


def queue_action(kind, description, payload):
    aid = uuid.uuid4().hex[:12]
    with _LOCK:
        PENDING_ACTIONS[aid] = {
            "id": aid,
            "kind": kind,
            "description": description,
            "payload": payload,
            "created_at": time.time(),
            "status": "pending",
        }
    return aid


def list_pending():
    with _LOCK:
        return sorted(
            (dict(a) for a in PENDING_ACTIONS.values() if a["status"] == "pending"),
            key=lambda a: a["created_at"],
        )


def resolve_action(aid, approve):
    with _LOCK:
        a = PENDING_ACTIONS.get(aid)
        if not a or a["status"] != "pending":
            return None
        a["status"] = "approved" if approve else "rejected"

    if approve:
        a["result"] = _execute_action(a)
    else:
        a["result"] = {"ok": False, "rejected_by_user": True}

    with _LOCK:
        COMPLETED_ACTIONS.insert(0, dict(a))
        del COMPLETED_ACTIONS[200:]
        PENDING_ACTIONS.pop(aid, None)
    return a


def _execute_action(a):
    kind, p = a["kind"], a["payload"]
    try:
        if kind == "write_file":
            return _do_write_file(p["path"], p["content"])
        if kind == "delete_file":
            return _do_delete_file(p["path"])
        if kind == "delete_files":
            return _do_delete_files(p["paths"])
        if kind == "browser_click":
            return _do_browser_click(p["selector"])
        if kind == "browser_fill":
            return _do_browser_fill(p["selector"], p["text"])
        return {"ok": False, "error": f"Unknown action kind: {kind}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ───────────────────── File access (hard-capped to an allow-list) ─────────────────────
def get_allowed_roots(settings):
    roots = settings.get("file_allow_list", [])
    return [Path(r).expanduser().resolve() for r in roots if r.strip()]


def _resolve_within_allowlist(path_str, settings):
    target = Path(path_str).expanduser().resolve()
    for root in get_allowed_roots(settings):
        try:
            target.relative_to(root)
            return target
        except ValueError:
            continue
    raise PermissionError(
        f"'{path_str}' is outside every allow-listed folder. "
        "Add its folder in Settings -> File Access before Atlantis can touch it. "
        "This check applies even to approved actions -- there's no way around it."
    )


def list_dir(path_str, settings):
    target = _resolve_within_allowlist(path_str, settings)
    if not target.exists():
        raise FileNotFoundError(str(target))
    return [
        {"name": c.name, "is_dir": c.is_dir(), "size": c.stat().st_size if c.is_file() else None}
        for c in sorted(target.iterdir())
    ]


def read_file(path_str, settings, max_bytes=200_000):
    target = _resolve_within_allowlist(path_str, settings)
    if not target.is_file():
        raise FileNotFoundError(str(target))
    data = target.read_bytes()[:max_bytes]
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return f"<binary file, {len(data)} bytes read, not shown as text>"


def request_write_file(path_str, content, settings):
    target = _resolve_within_allowlist(path_str, settings)
    return queue_action(
        "write_file",
        f"Write {len(content)} characters to {target}",
        {"path": str(target), "content": content},
    )


def request_delete_file(path_str, settings):
    target = _resolve_within_allowlist(path_str, settings)
    return queue_action("delete_file", f"Delete {target}", {"path": str(target)})


def _do_write_file(path_str, content):
    Path(path_str).write_text(content, encoding="utf-8")
    return {"ok": True}


def _do_delete_file(path_str):
    p = Path(path_str)
    if p.is_dir():
        raise IsADirectoryError("Refusing to delete a directory -- files only.")
    p.unlink()
    return {"ok": True}


def request_delete_files(path_strs, settings):
    """
    Batched version of request_delete_file: one approval covers the whole
    list, rather than needing a click per file. Every path is still
    individually checked against the allow-list -- batching never widens
    what's deletable, it only combines the confirmation step.
    """
    targets = [str(_resolve_within_allowlist(p, settings)) for p in path_strs]
    names_preview = [Path(t).name for t in targets[:15]]
    more = f" and {len(targets) - 15} more" if len(targets) > 15 else ""
    return queue_action(
        "delete_files",
        f"Delete {len(targets)} file(s): {', '.join(names_preview)}{more}",
        {"paths": targets},
    )


def _do_delete_files(paths):
    results = []
    for p in paths:
        try:
            results.append({"path": p, **_do_delete_file(p)})
        except Exception as e:
            results.append({"path": p, "ok": False, "error": str(e)})
    return {"ok": True, "results": results}


# ───────────────────── Duplicate file finder ─────────────────────
# Read-only scan (hashing files to compare content, never touching
# anything) -- the actual deletion of whatever you pick still goes
# through request_delete_files above, i.e. still needs your approval.
_HASH_SIZE_LIMIT = 200 * 1024 * 1024  # skip content-hashing anything bigger than this
_MAX_FILES_SCANNED = 50_000


def _hash_file(path, chunk_size=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def find_duplicate_files(settings):
    """
    Scans every allow-listed folder recursively, groups files that are
    byte-for-byte identical (same size, then same sha256), and returns
    only the groups with more than one file. Files above
    _HASH_SIZE_LIMIT are skipped (noted separately) rather than hashed,
    to avoid a multi-minute scan choking on a handful of huge videos.
    """
    roots = get_allowed_roots(settings)
    if not roots:
        raise PermissionError("No folders in your File Access allow-list yet -- add one in Settings first.")

    by_size = {}
    scanned = 0
    skipped_large = []
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            scanned += 1
            if scanned > _MAX_FILES_SCANNED:
                break
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size == 0:
                continue
            if size > _HASH_SIZE_LIMIT:
                skipped_large.append(str(path))
                continue
            by_size.setdefault(size, []).append(path)

    groups = []
    for size, paths in by_size.items():
        if len(paths) < 2:
            continue
        by_hash = {}
        for path in paths:
            try:
                h = _hash_file(path)
            except OSError:
                continue
            by_hash.setdefault(h, []).append(path)
        for h, dup_paths in by_hash.items():
            if len(dup_paths) > 1:
                groups.append({
                    "hash": h,
                    "size": size,
                    "files": [str(p) for p in dup_paths],
                })

    groups.sort(key=lambda g: g["size"] * (len(g["files"]) - 1), reverse=True)
    reclaimable = sum(g["size"] * (len(g["files"]) - 1) for g in groups)
    return {
        "groups": groups,
        "files_scanned": scanned,
        "skipped_large_files": skipped_large,
        "reclaimable_bytes": reclaimable,
    }


# ───────────────────── OS app launching (allow-listed apps only) ─────────────────────
def launch_app(app_name, settings):
    apps = settings.get("app_allow_list", {})
    path = apps.get(app_name)
    if not path:
        raise PermissionError(
            f"'{app_name}' isn't in your app allow-list. Add it in Settings -> Apps first "
            f"(known apps: {', '.join(apps) or 'none configured yet'})."
        )
    subprocess.Popen([path])
    return {"ok": True, "launched": path}


# ───────────────────── Browser automation (dedicated profile) ─────────────────────
_playwright = None
_browser_context = None
_page = None
_browser_lock = threading.Lock()


def _ensure_browser():
    global _playwright, _browser_context, _page
    with _browser_lock:
        if _browser_context is not None:
            return
        from playwright.sync_api import sync_playwright
        _playwright = sync_playwright().start()
        BROWSER_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        _browser_context = _playwright.chromium.launch_persistent_context(
            str(BROWSER_PROFILE_DIR), headless=False, viewport={"width": 1280, "height": 900}
        )
        _page = _browser_context.pages[0] if _browser_context.pages else _browser_context.new_page()


def browser_open(url):
    _ensure_browser()
    _page.goto(url, wait_until="domcontentloaded", timeout=30000)
    return {"ok": True, "url": _page.url, "title": _page.title()}


def browser_read_page(max_chars=8000):
    _ensure_browser()
    return _page.inner_text("body")[:max_chars]


def browser_screenshot():
    _ensure_browser()
    fname = SCREENSHOT_DIR / f"shot-{int(time.time())}.png"
    _page.screenshot(path=str(fname))
    return str(fname)


def request_browser_click(selector_or_text):
    _ensure_browser()
    return queue_action(
        "browser_click", f'Click "{selector_or_text}" on {_page.url}', {"selector": selector_or_text}
    )


def request_browser_fill(selector, text):
    _ensure_browser()
    return queue_action(
        "browser_fill", f'Type "{text[:60]}" into "{selector}" on {_page.url}',
        {"selector": selector, "text": text},
    )


def _do_browser_click(selector_or_text):
    _ensure_browser()
    try:
        _page.click(f"text={selector_or_text}", timeout=5000)
    except Exception:
        _page.click(selector_or_text, timeout=5000)
    return {"ok": True, "url": _page.url}


def _do_browser_fill(selector, text):
    _ensure_browser()
    _page.fill(selector, text, timeout=5000)
    return {"ok": True}


# ───────────────────── Calendar & Email (read-only, Google OAuth) ─────────────────────
# Needs a one-time setup only you can do (create your own OAuth credentials
# in Google Cloud Console -- see README) since it's your Google account.
# Requests READ-ONLY scopes only: Atlantis cannot send email or modify
# your calendar through this even if a chat asks it to, because the tools
# below simply don't exist -- there's nothing to gate because there's no
# write path to gate.
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
]


def _google_creds():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None
    if GOOGLE_TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(GOOGLE_TOKEN_FILE), GOOGLE_SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not GOOGLE_CREDENTIALS_FILE.exists():
                raise RuntimeError(
                    "No Google credentials found. Follow the Calendar/Email setup steps "
                    "in README.md, save your credentials as "
                    f"{GOOGLE_CREDENTIALS_FILE}, then try again."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(GOOGLE_CREDENTIALS_FILE), GOOGLE_SCOPES)
            creds = flow.run_local_server(port=0)  # opens your real browser for you to sign in, once
        GOOGLE_TOKEN_FILE.write_text(creds.to_json())
    return creds


def list_upcoming_events(max_results=10):
    from googleapiclient.discovery import build
    creds = _google_creds()
    service = build("calendar", "v3", credentials=creds)
    now = datetime.utcnow().isoformat() + "Z"
    events_result = service.events().list(
        calendarId="primary", timeMin=now, maxResults=max_results,
        singleEvents=True, orderBy="startTime",
    ).execute()
    return [
        {"summary": e.get("summary", "(no title)"), "start": e["start"].get("dateTime", e["start"].get("date"))}
        for e in events_result.get("items", [])
    ]


def list_recent_emails(max_results=10):
    from googleapiclient.discovery import build
    creds = _google_creds()
    service = build("gmail", "v1", credentials=creds)
    results = service.users().messages().list(userId="me", maxResults=max_results).execute()
    out = []
    for m in results.get("messages", []):
        msg = service.users().messages().get(
            userId="me", id=m["id"], format="metadata", metadataHeaders=["Subject", "From", "Date"]
        ).execute()
        headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
        out.append({
            "subject": headers.get("Subject", "(no subject)"),
            "from": headers.get("From", ""),
            "date": headers.get("Date", ""),
            "snippet": msg.get("snippet", ""),
        })
    return out


# ───────────────────── Tool schema + dispatcher for the chat model ─────────────────────
TOOLS_SPEC = [
    {"type": "function", "function": {
        "name": "list_dir", "description": "List files in a folder Atlantis is allowed to access.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "read_file", "description": "Read a text file Atlantis is allowed to access.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "Propose writing content to a file. Requires your approval before it happens.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "delete_file",
        "description": "Propose deleting a file. Requires your approval before it happens.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "launch_app", "description": "Open an application from your configured app allow-list.",
        "parameters": {"type": "object", "properties": {"app_name": {"type": "string"}}, "required": ["app_name"]}}},
    {"type": "function", "function": {
        "name": "browser_open", "description": "Navigate the Atlantis browser window to a URL.",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
    {"type": "function", "function": {
        "name": "browser_read_page",
        "description": "Read the visible text of the current page in the Atlantis browser.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "browser_click",
        "description": "Propose clicking an element (visible text or CSS selector) on the current page. Requires your approval.",
        "parameters": {"type": "object", "properties": {"selector": {"type": "string"}}, "required": ["selector"]}}},
    {"type": "function", "function": {
        "name": "browser_fill",
        "description": "Propose typing text into a field (CSS selector) on the current page. Requires your approval.",
        "parameters": {"type": "object", "properties": {
            "selector": {"type": "string"}, "text": {"type": "string"}}, "required": ["selector", "text"]}}},
    {"type": "function", "function": {
        "name": "list_upcoming_events",
        "description": "List your next upcoming Google Calendar events (read-only).",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "list_recent_emails",
        "description": "List your most recent Gmail messages -- subject/from/snippet only (read-only).",
        "parameters": {"type": "object", "properties": {}}}},
]


def dispatch_tool_call(name, args, settings):
    if name == "list_dir":
        return list_dir(args["path"], settings)
    if name == "read_file":
        return read_file(args["path"], settings)
    if name == "write_file":
        aid = request_write_file(args["path"], args["content"], settings)
        return {"queued_for_approval": aid, "note": "Waiting for you to approve this in the Atlantis window."}
    if name == "delete_file":
        aid = request_delete_file(args["path"], settings)
        return {"queued_for_approval": aid, "note": "Waiting for you to approve this in the Atlantis window."}
    if name == "launch_app":
        return launch_app(args["app_name"], settings)
    if name == "browser_open":
        return browser_open(args["url"])
    if name == "browser_read_page":
        return {"text": browser_read_page()}
    if name == "browser_click":
        aid = request_browser_click(args["selector"])
        return {"queued_for_approval": aid, "note": "Waiting for you to approve this in the Atlantis window."}
    if name == "browser_fill":
        aid = request_browser_fill(args["selector"], args["text"])
        return {"queued_for_approval": aid, "note": "Waiting for you to approve this in the Atlantis window."}
    if name == "list_upcoming_events":
        return list_upcoming_events()
    if name == "list_recent_emails":
        return list_recent_emails()
    return {"error": f"Unknown tool {name}"}
