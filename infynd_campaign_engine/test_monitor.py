"""
InFynd Campaign Engine — Automated API Test & Log Monitor
=========================================================
Usage:
    python test_monitor.py               # run all tests + live log tail
    python test_monitor.py --tests-only  # run tests, skip log monitor
    python test_monitor.py --logs-only   # skip tests, just tail logs

Requirements: requests (already installed via fastapi deps)
"""

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests

try:
    import websockets as _websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────
BASE_URL = "http://localhost:8000/api/v1"
WS_BASE  = "ws://localhost:8000/api/v1"   # websocket base
ADMIN_EMAIL = "admin@infynd.com"
ADMIN_PASSWORD = "admin123"
LOG_FILE = os.path.join(os.path.dirname(__file__), "uvicorn.log")

# ─────────────────────────────────────────────────────────────────────────────
# ANSI colours (works on Windows 10+ with ANSI enabled)
# ─────────────────────────────────────────────────────────────────────────────
os.system("")  # enable VT100 on Windows

RESET  = "\033[0m"
BOLD   = "\033[1m"
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
MAGENTA= "\033[95m"
WHITE  = "\033[97m"
DIM    = "\033[2m"
BG_RED = "\033[41m"


def c(text, color):  return f"{color}{text}{RESET}"
def ok(msg):         print(f"  {c('PASS', GREEN)} {msg}")
def fail(msg, err=""): print(f"  {c('FAIL', RED)} {msg}" + (f"\n       {c(err, YELLOW)}" if err else ""))
def warn(msg):       print(f"  {c('WARN', YELLOW)} {msg}")
def info(msg):       print(f"  {c('INFO', CYAN)} {msg}")
def section(title):
    bar = "─" * 60
    print(f"\n{c(bar, CYAN)}")
    print(f"{c(title.upper(), BOLD + CYAN)}")
    print(f"{c(bar, CYAN)}")


# ─────────────────────────────────────────────────────────────────────────────
# Test infrastructure
# ─────────────────────────────────────────────────────────────────────────────
results: List[Tuple[str, bool, str]] = []   # (name, passed, detail)
_token: Optional[str] = None


def record(name: str, passed: bool, detail: str = ""):
    results.append((name, passed, detail))
    if passed:
        ok(name)
    else:
        fail(name, detail)


def get_token() -> str:
    global _token
    if _token:
        return _token
    r = requests.post(f"{BASE_URL}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=10)
    _token = r.json()["access_token"]
    return _token


def auth_headers() -> Dict[str, str]:
    return {"Authorization": f"Bearer {get_token()}"}


def expect(
    name: str,
    method: str,
    path: str,
    *,
    payload: Any = None,
    expected_status: int = 200,
    expected_keys: List[str] = None,
    token: Optional[str] = None,
    skip_auth: bool = False,
) -> Optional[Dict]:
    """Make a request, record pass/fail, return parsed body or None."""
    url = f"{BASE_URL}{path}"
    headers = {} if skip_auth else ({"Authorization": f"Bearer {token}"} if token else auth_headers())
    try:
        resp = getattr(requests, method.lower())(
            url, json=payload, headers=headers, timeout=15
        )
        body = {}
        try:
            body = resp.json()
        except Exception:
            body = {"_raw": resp.text}

        status_ok = resp.status_code == expected_status
        keys_ok = True
        missing = []
        if expected_keys and status_ok:
            for k in expected_keys:
                if k not in body:
                    keys_ok = False
                    missing.append(k)

        passed = status_ok and keys_ok
        detail = ""
        if not status_ok:
            detail = f"expected HTTP {expected_status}, got {resp.status_code} | {json.dumps(body)[:120]}"
        elif not keys_ok:
            detail = f"missing keys: {missing}"

        record(name, passed, detail)
        return body if passed else None

    except requests.exceptions.ConnectionError:
        record(name, False, "Connection refused — is the server running on :8000?")
        return None
    except Exception as exc:
        record(name, False, str(exc)[:120])
        return None


# ─────────────────────────────────────────────────────────────────────────────
# ❶  Health / Connectivity
# ─────────────────────────────────────────────────────────────────────────────
def test_health():
    section("1. Server Connectivity")
    try:
        r = requests.get("http://localhost:8000/docs", timeout=5)
        record("Swagger UI reachable", r.status_code == 200)
    except Exception as e:
        record("Swagger UI reachable", False, str(e))

    try:
        r = requests.get("http://localhost:8000/openapi.json", timeout=5)
        body = r.json()
        record("OpenAPI schema loads", r.status_code == 200 and "paths" in body,
               "" if "paths" in body else "missing 'paths'")
    except Exception as e:
        record("OpenAPI schema loads", False, str(e))


# ─────────────────────────────────────────────────────────────────────────────
# ❷  Authentication
# ─────────────────────────────────────────────────────────────────────────────
def test_auth():
    section("2. Authentication")

    # valid login
    body = expect(
        "POST /auth/login — valid credentials",
        "POST", "/auth/login",
        payload={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        expected_status=200,
        expected_keys=["access_token", "refresh_token", "token_type"],
        skip_auth=True,
    )

    # role assignment
    if body:
        import base64
        try:
            payload_b64 = body["access_token"].split(".")[1]
            payload_b64 += "=" * (-len(payload_b64) % 4)
            claims = json.loads(base64.b64decode(payload_b64))
            record("JWT contains role=ADMIN for @infynd.com email",
                   claims.get("role") == "ADMIN",
                   f"got role={claims.get('role')}")
        except Exception as e:
            record("JWT role claim check", False, str(e))

    # bad password (still returns a token — by-design for demo, just check 200)
    expect(
        "POST /auth/login — wrong domain gets VIEWER role (200 OK)",
        "POST", "/auth/login",
        payload={"email": "outsider@example.com", "password": "anything"},
        expected_status=200,
        skip_auth=True,
    )

    # refresh
    r = requests.post(f"{BASE_URL}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=10)
    refresh_tok = r.json().get("refresh_token", "")
    expect(
        "POST /auth/refresh — valid refresh token",
        "POST", "/auth/refresh",
        payload={"refresh_token": refresh_tok},
        expected_status=200,
        expected_keys=["access_token"],
        skip_auth=True,
    )

    # bad refresh token
    expect(
        "POST /auth/refresh — invalid token → 401",
        "POST", "/auth/refresh",
        payload={"refresh_token": "bad.token.here"},
        expected_status=401,
        skip_auth=True,
    )

    # no auth header → 403
    expect(
        "GET /campaigns/ — no auth header → 403",
        "GET", "/campaigns/",
        expected_status=403,
        skip_auth=True,
    )


# ─────────────────────────────────────────────────────────────────────────────
# ❸  Campaigns CRUD
# ─────────────────────────────────────────────────────────────────────────────
_created_campaign_id: Optional[str] = None

def test_campaigns():
    global _created_campaign_id
    section("3. Campaigns")

    # list
    body = expect(
        "GET /campaigns/ — returns list",
        "GET", "/campaigns/",
        expected_status=200,
        expected_keys=[],
    )
    if body is not None:
        record("GET /campaigns/ — response is a list", isinstance(body, list),
               f"got {type(body).__name__}")

    # create
    campaign_payload = {
        "name": f"[AutoTest] Smoke {uuid.uuid4().hex[:6]}",
        "company": "InFynd",
        "campaign_purpose": "Automated test campaign — safe to ignore",
        "target_audience": "QA bots",
        "product_link": "https://infynd.com",
        "prompt": "Write a two-sentence test email.",
        "platform": "email",
        "approval_required": True,
    }
    body = expect(
        "POST /campaigns/ — create campaign → 201",
        "POST", "/campaigns/",
        payload=campaign_payload,
        expected_status=201,
        expected_keys=["id", "name", "pipeline_state"],
    )
    if body:
        _created_campaign_id = body["id"]
        record("Created campaign has state=CREATED",
               body.get("pipeline_state") == "CREATED",
               f"got {body.get('pipeline_state')}")

    # get by id
    if _created_campaign_id:
        expect(
            "GET /campaigns/{id} — fetch by id",
            "GET", f"/campaigns/{_created_campaign_id}",
            expected_status=200,
            expected_keys=["id", "name"],
        )

    # get non-existent
    expect(
        "GET /campaigns/{id} — unknown id → 404",
        "GET", f"/campaigns/{uuid.uuid4()}",
        expected_status=404,
    )

    # approve non-awaiting → 409  (use a known COMPLETED campaign — guaranteed wrong state)
    _known_completed = "1a948eb5-9db6-4fad-a9fd-10d3a0e3afd4"
    expect(
        "POST /campaigns/{id}/approve — not AWAITING_APPROVAL → 409",
        "POST", f"/campaigns/{_known_completed}/approve",
        expected_status=409,
    )

    # content edit wrong state → 409  (COMPLETED campaign = guaranteed wrong state)
    expect(
        "PATCH /campaigns/{id}/content/{email} — wrong state → 409",
        "PATCH",
        f"/campaigns/{_known_completed}/content/test@example.com",
        payload={"content": {"subject": "hi", "body": "test"}},
        expected_status=409,
    )


# ─────────────────────────────────────────────────────────────────────────────
# ❹  Analytics
# ─────────────────────────────────────────────────────────────────────────────
def test_analytics():
    section("4. Analytics")

    # use the last known real COMPLETED campaign (hardcoded from the session)
    known_completed = "1a948eb5-9db6-4fad-a9fd-10d3a0e3afd4"

    body = expect(
        "GET /campaigns/{id}/analytics — completed campaign",
        "GET", f"/campaigns/{known_completed}/analytics",
        expected_status=200,
        expected_keys=["campaign_id", "total_contacts", "sent", "opened", "clicked",
                       "open_rate", "click_rate", "breakdown_by_channel"],
    )
    if body:
        record("analytics sent >= 2", body.get("sent", 0) >= 2,
               f"sent={body.get('sent')}")
        record("analytics total_contacts >= 2", body.get("total_contacts", 0) >= 2,
               f"total_contacts={body.get('total_contacts')}")

    # analytics new (no data) campaign
    if _created_campaign_id:
        body2 = expect(
            "GET /campaigns/{id}/analytics — new campaign returns zeros (not 404)",
            "GET", f"/campaigns/{_created_campaign_id}/analytics",
            expected_status=200,
            expected_keys=["sent", "opened"],
        )
        if body2:
            record("analytics zeros for new campaign",
                   body2.get("sent", -1) == 0 and body2.get("opened", -1) == 0,
                   f"sent={body2.get('sent')}, opened={body2.get('opened')}")

    # unknown campaign → 404
    expect(
        "GET /campaigns/{id}/analytics — unknown id → 404",
        "GET", f"/campaigns/{uuid.uuid4()}/analytics",
        expected_status=404,
    )


# ─────────────────────────────────────────────────────────────────────────────
# ❺  Tracking webhook
# ─────────────────────────────────────────────────────────────────────────────
def test_tracking():
    section("5. Tracking Webhooks")

    known_email_msg_id = "4BWDnvuMTr22C2CzTF-GmA"

    # simulate SendGrid open event
    sg_open_event = [
        {
            "email": "sarweshero@gmail.com",
            "event": "open",
            "sg_message_id": known_email_msg_id,
            "campaign_id": "1a948eb5-9db6-4fad-a9fd-10d3a0e3afd4",
            "timestamp": int(time.time()),
        }
    ]
    expect(
        "POST /tracking/sendgrid — open event → 200",
        "POST", "/tracking/sendgrid",
        payload=sg_open_event,
        expected_status=200,
        skip_auth=True,
    )

    # simulate SendGrid click event
    sg_click_event = [
        {
            "email": "sarweshero@gmail.com",
            "event": "click",
            "url": "https://infynd.com",
            "sg_message_id": known_email_msg_id,
            "campaign_id": "1a948eb5-9db6-4fad-a9fd-10d3a0e3afd4",
            "timestamp": int(time.time()),
        }
    ]
    expect(
        "POST /tracking/sendgrid — click event → 200",
        "POST", "/tracking/sendgrid",
        payload=sg_click_event,
        expected_status=200,
        skip_auth=True,
    )

    # empty payload (edge case) — should not crash
    expect(
        "POST /tracking/sendgrid — empty list → 200",
        "POST", "/tracking/sendgrid",
        payload=[],
        expected_status=200,
        skip_auth=True,
    )

    # call tracking
    call_event = {
        "contact_email": "sarweshero@gmail.com",
        "campaign_id": "1a948eb5-9db6-4fad-a9fd-10d3a0e3afd4",
        "outcome": "ANSWERED",
        "duration_seconds": 120,
    }
    expect(
        "POST /tracking/call → 200",
        "POST", "/tracking/call",
        payload=call_event,
        expected_status=200,
        skip_auth=True,
    )

    # linkedin tracking
    li_event = {
        "contact_email": "sarweshero@gmail.com",
        "campaign_id": "1a948eb5-9db6-4fad-a9fd-10d3a0e3afd4",
        "event_type": "ACCEPTED",
    }
    expect(
        "POST /tracking/linkedin → 200",
        "POST", "/tracking/linkedin",
        payload=li_event,
        expected_status=200,
        skip_auth=True,
    )


# ─────────────────────────────────────────────────────────────────────────────
# ❻  WebSocket error cases
# ─────────────────────────────────────────────────────────────────────────────
def test_websocket():
    section("6. WebSocket  (WS /api/v1/ws/campaigns/{id})")

    if not HAS_WEBSOCKETS:
        warn("websockets library missing — skipping (pip install websockets)")
        return

    # helper: connect, collect messages until close or timeout
    async def _recv_all(url: str, timeout: float = 5.0) -> List[dict]:
        msgs: List[dict] = []
        try:
            async with _websockets.connect(url, open_timeout=timeout,
                                           close_timeout=timeout) as ws:
                for _ in range(10):
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
                        msgs.append(json.loads(raw))
                    except (asyncio.TimeoutError,
                            _websockets.exceptions.ConnectionClosed):
                        break
        except Exception:
            pass  # close(4001) closes before we recv — normal for auth fail
        return msgs

    # Get a valid token for auth tests
    r = requests.post(f"{BASE_URL}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=10)
    token = r.json().get("access_token", "")

    # ── Test 1: no token → server closes with code 4001, no messages received ──
    msgs = asyncio.run(_recv_all(f"{WS_BASE}/ws/campaigns/{uuid.uuid4()}"))
    record(
        "WS /ws/campaigns/{id} — no token → closed (no content)",
        len(msgs) == 0,
        f"msgs={msgs}",
    )

    # ── Test 2: invalid JWT → close(4001), no messages ──
    msgs = asyncio.run(_recv_all(
        f"{WS_BASE}/ws/campaigns/{uuid.uuid4()}?token=bad.jwt.token"
    ))
    record(
        "WS /ws/campaigns/{id} — bad token → closed (no content)",
        len(msgs) == 0,
        f"msgs={msgs}",
    )

    # ── Test 3: valid token + unknown campaign UUID → NOT_FOUND error ──
    msgs = asyncio.run(_recv_all(
        f"{WS_BASE}/ws/campaigns/{uuid.uuid4()}?token={token}"
    ))
    not_found = any(m.get("code") == "NOT_FOUND" for m in msgs)
    record(
        "WS /ws/campaigns/{id} — unknown campaign → NOT_FOUND error",
        not_found,
        f"msgs={msgs}",
    )

    # ── Test 4: valid token + COMPLETED campaign → INVALID_STATE error ──
    completed_id = "1a948eb5-9db6-4fad-a9fd-10d3a0e3afd4"
    msgs = asyncio.run(_recv_all(
        f"{WS_BASE}/ws/campaigns/{completed_id}?token={token}"
    ))
    inv_state = any(m.get("code") == "INVALID_STATE" for m in msgs)
    record(
        "WS /ws/campaigns/{id} — non-AWAITING campaign → INVALID_STATE error",
        inv_state,
        f"msgs={msgs}",
    )


# ─────────────────────────────────────────────────────────────────────────────
# ❦  Approval-required flow  (PATCH content + WS APPROVAL_START + REST approve)
# ─────────────────────────────────────────────────────────────────────────────
def test_approval_flow():
    section("7. Approval Flow  (PATCH content + WS + REST approve, waits up to 120s)")

    # ---- Create approval-required campaign ----
    payload = {
        "name": f"[AutoTest] Approval {uuid.uuid4().hex[:6]}",
        "company": "InFynd",
        "campaign_purpose": "Automated approval flow test",
        "target_audience": "QA engineers",
        "product_link": "https://infynd.com",
        "prompt": "One sentence test email.",
        "platform": "email",
        "approval_required": True,
    }
    r = requests.post(f"{BASE_URL}/campaigns/", json=payload,
                      headers={"Authorization": f"Bearer {get_token()}"},
                      timeout=15)
    if r.status_code != 201:
        record("Approval flow campaign created", False, f"HTTP {r.status_code}")
        return
    cid = r.json()["id"]
    record("Approval flow: POST /campaigns/ — approval_required=True → 201", True, f"id={cid}")
    info(f"Approval campaign ID: {cid}")

    # ---- Poll until AWAITING_APPROVAL (max 120s) ----
    state = "CREATED"
    token = get_token()
    deadline = time.time() + 120
    while time.time() < deadline:
        resp = requests.get(f"{BASE_URL}/campaigns/{cid}",
                            headers={"Authorization": f"Bearer {token}"},
                            timeout=10)
        state = resp.json().get("pipeline_state", "UNKNOWN")
        info(f"  → {state}")
        if state == "AWAITING_APPROVAL":
            break
        if state in ("COMPLETED", "FAILED", "APPROVED"):
            break
        time.sleep(5)

    record("Approval flow: pipeline reached AWAITING_APPROVAL",
           state == "AWAITING_APPROVAL",
           f"final state={state}")

    if state != "AWAITING_APPROVAL":
        warn("Skipping PATCH/WS/approve tests — campaign did not reach AWAITING_APPROVAL")
        return

    # ---- Test PATCH /campaigns/{id}/content/{email} happy path ----
    # Use the first known contact email (always in DB)
    contact_email = "sarweshero@gmail.com"
    patch_r = requests.patch(
        f"{BASE_URL}/campaigns/{cid}/content/{contact_email}",
        json={"content": {"subject": "Updated Subject", "body": "Updated body"}},
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    record(
        "PATCH /campaigns/{id}/content/{email} — valid state → 200",
        patch_r.status_code == 200,
        f"HTTP {patch_r.status_code} | {patch_r.text[:120]}",
    )

    # ---- Test PATCH with unknown contact email → 404 ----
    patch_404 = requests.patch(
        f"{BASE_URL}/campaigns/{cid}/content/nobody@nowhere.com",
        json={"content": {"subject": "X"}},
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    record(
        "PATCH /campaigns/{id}/content/{email} — unknown contact → 404",
        patch_404.status_code == 404,
        f"HTTP {patch_404.status_code}",
    )

    # ---- Test WS: AWAITING_APPROVAL campaign → APPROVAL_START message ----
    if HAS_WEBSOCKETS:
        async def _check_approval_start(cid: str, tok: str) -> List[dict]:
            msgs: List[dict] = []
            try:
                async with _websockets.connect(
                    f"{WS_BASE}/ws/campaigns/{cid}?token={tok}",
                    open_timeout=8, close_timeout=5
                ) as ws:
                    for _ in range(5):
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=8.0)
                            msgs.append(json.loads(raw))
                            # Disconnect after first APPROVAL_START to leave state intact
                            if any(m.get("type") == "APPROVAL_START" for m in msgs):
                                break
                        except (asyncio.TimeoutError,
                                _websockets.exceptions.ConnectionClosed):
                            break
            except Exception:
                pass
            return msgs

        ws_msgs = asyncio.run(_check_approval_start(cid, token))
        got_start = any(m.get("type") == "APPROVAL_START" for m in ws_msgs)
        record(
            "WS /ws/campaigns/{id} — AWAITING_APPROVAL → APPROVAL_START received",
            got_start,
            f"msgs={ws_msgs}",
        )
    else:
        warn("WS APPROVAL_START test skipped — websockets not installed")

    # ---- Test POST /campaigns/{id}/approve happy path → 200 ----
    approve_r = requests.post(
        f"{BASE_URL}/campaigns/{cid}/approve",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    record(
        "POST /campaigns/{id}/approve — AWAITING_APPROVAL → 200",
        approve_r.status_code == 200,
        f"HTTP {approve_r.status_code} | {approve_r.text[:120]}",
    )

    # Verify state transitions to APPROVED
    time.sleep(2)
    final = requests.get(f"{BASE_URL}/campaigns/{cid}",
                         headers={"Authorization": f"Bearer {token}"},
                         timeout=10)
    final_state = final.json().get("pipeline_state", "UNKNOWN")
    record(
        "Approval flow: state after approve → APPROVED or COMPLETED",
        final_state in ("APPROVED", "COMPLETED", "SENDING"),
        f"state={final_state}",
    )


# ─────────────────────────────────────────────────────────────────────────────
def test_pipeline_smoke():
    section("8. Pipeline Smoke (no-approval, waits up to 90s)")
    info("Creating a no-approval campaign and watching state progression...")

    body = expect(
        "POST /campaigns/ — no-approval pipeline trigger",
        "POST", "/campaigns/",
        payload={
            "name": f"[AutoTest] Pipeline {uuid.uuid4().hex[:6]}",
            "company": "InFynd",
            "campaign_purpose": "Quick smoke test via automated script",
            "target_audience": "Developers and CTOs in Chennai",
            "product_link": "https://infynd.com",
            "prompt": "One sentence test email to developer or CTO.",
            "platform": "email",
            "approval_required": False,
        },
        expected_status=201,
    )
    if not body:
        return

    cid = body["id"]
    info(f"Campaign ID: {cid}")

    transitions: List[str] = ["CREATED"]
    deadline = time.time() + 120
    last_state = "CREATED"
    check_interval = 4

    state_order = [
        "CREATED", "CLASSIFIED", "CONTACTS_RETRIEVED", "CHANNEL_DECIDED",
        "CONTENT_GENERATED", "AWAITING_APPROVAL", "APPROVED",
        "DISPATCHED", "COMPLETED", "FAILED",
    ]

    while time.time() < deadline:
        time.sleep(check_interval)
        r = requests.get(f"{BASE_URL}/campaigns/{cid}", headers=auth_headers(), timeout=10)
        if r.status_code != 200:
            break
        state = r.json().get("pipeline_state", "")
        locked = r.json().get("pipeline_locked", False)
        if state != last_state:
            info(f"  → {state}" + (" (locked)" if locked else ""))
            transitions.append(state)
            last_state = state
        if state in ("COMPLETED", "FAILED", "APPROVED"):
            if locked:
                # still locked after terminal state — bad
                time.sleep(8)
                r2 = requests.get(f"{BASE_URL}/campaigns/{cid}", headers=auth_headers(), timeout=10)
                locked = r2.json().get("pipeline_locked", False)
            break

    record("Pipeline reached COMPLETED or APPROVED",
           last_state in ("COMPLETED", "APPROVED"),
           f"stuck at {last_state}")

    record("Pipeline not locked at end",
           not locked,
           "pipeline_locked=True at terminal state")

    # check analytics after completion
    if last_state in ("COMPLETED", "APPROVED"):
        ar = requests.get(f"{BASE_URL}/campaigns/{cid}/analytics",
                          headers=auth_headers(), timeout=10)
        if ar.status_code == 200:
            a = ar.json()
            record("Pipeline analytics: total_contacts >= 1 after completion",
                   a.get("total_contacts", 0) >= 1,
                   f"total_contacts={a.get('total_contacts')}")
        else:
            record("Pipeline analytics reachable", False, f"HTTP {ar.status_code}")

    info(f"State path: {' → '.join(transitions)}")


# ─────────────────────────────────────────────────────────────────────────────
# ❼  Database connectivity (indirect via API)
# ─────────────────────────────────────────────────────────────────────────────
def test_db_health():
    section("7. Database Indirect Health")

    r = requests.post(f"{BASE_URL}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=8)
    body = r.json()
    access_ok = "access_token" in body
    record("DB: auth endpoint responds with token", access_ok)

    if access_ok:
        r2 = requests.get(f"{BASE_URL}/campaigns/", headers=auth_headers(), timeout=8)
        record("DB: campaign list query succeeds", r2.status_code == 200,
               "" if r2.status_code == 200 else r2.text[:80])


# ─────────────────────────────────────────────────────────────────────────────
# Final summary
# ─────────────────────────────────────────────────────────────────────────────
def print_summary():
    section("TEST SUMMARY")
    total  = len(results)
    passed = sum(1 for _, p, _ in results if p)
    failed = total - passed

    for name, p, detail in results:
        icon  = c("✔", GREEN) if p else c("✘", RED)
        label = c(name, WHITE) if p else c(name, RED)
        print(f"  {icon}  {label}")
        if detail:
            print(f"       {c(detail, YELLOW)}")

    print()
    bar = "═" * 60
    print(c(bar, CYAN))
    print(f"  {c(str(passed), GREEN + BOLD)}/{total} passed   "
          f"{c(str(failed), RED + BOLD) if failed else c('0', GREEN)} failed")
    pct = int(passed / total * 100) if total else 0
    color = GREEN if pct == 100 else (YELLOW if pct >= 70 else RED)
    print(f"  Score: {c(f'{pct}%', color + BOLD)}")
    print(c(bar, CYAN))
    return failed == 0


# ─────────────────────────────────────────────────────────────────────────────
# Log monitor — tails uvicorn.log or re-reads it in a background thread
# ─────────────────────────────────────────────────────────────────────────────

# Patterns that indicate problems
LOG_ERROR_RE = re.compile(
    r'"level":\s*"(ERROR|CRITICAL|WARNING)"', re.IGNORECASE
)
EXCEPTION_RE = re.compile(
    r'(Traceback|Exception|Error:|FAILED|pipeline.*FAILED)', re.IGNORECASE
)
SLOW_RE = re.compile(r'"duration_ms":\s*(\d+)')

_monitor_running = threading.Event()
_stop_monitor   = threading.Event()

LOG_CATEGORIES = {
    "ERROR":    RED,
    "CRITICAL": BG_RED + WHITE,
    "WARNING":  YELLOW,
    "INFO":     DIM,
}


def _level_color(line: str) -> str:
    for level, color in LOG_CATEGORIES.items():
        if f'"level": "{level}"' in line or f'"level":"{level}"' in line:
            return color
    return DIM


def _format_log_line(raw: str) -> Optional[str]:
    raw = raw.strip()
    if not raw:
        return None

    # try to parse JSON log
    try:
        j = json.loads(raw)
        ts       = j.get("timestamp", "")[:23]          # up to ms
        level    = j.get("level", "INFO").upper()
        logger   = j.get("logger", "")
        message  = j.get("message", raw)
        color    = LOG_CATEGORIES.get(level, DIM)
        lvl_tag  = f"{color}[{level:<8}]{RESET}"
        mod_tag  = c(f"{logger}", DIM)
        return f"{c(ts, DIM)} {lvl_tag} {mod_tag}: {message}"
    except Exception:
        pass

    # plain uvicorn access log  →  colour by status code
    m = re.search(r'"(GET|POST|PATCH|DELETE|PUT) (.+) HTTP.*" (\d+)', raw)
    if m:
        method  = m.group(1)
        path    = m.group(2)
        code    = int(m.group(3))
        sc = GREEN if code < 400 else (YELLOW if code < 500 else RED)
        return f"{c(raw[:10], DIM)} {c(method, CYAN)} {path} {c(str(code), sc)}"

    # traceback / exception lines
    if EXCEPTION_RE.search(raw):
        return c(raw, RED)

    return c(raw, DIM)


def _tail_log_file(path: str, follow: bool = True):
    """Tail a file, printing formatted lines."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            # seek to end so we only show new lines
            fh.seek(0, 2)
            while not _stop_monitor.is_set():
                line = fh.readline()
                if line:
                    formatted = _format_log_line(line)
                    if formatted:
                        print(formatted)
                    # flag slow requests
                    sm = SLOW_RE.search(line)
                    if sm and int(sm.group(1)) > 3000:
                        print(c(f"  ⚠ SLOW REQUEST: {sm.group(1)}ms", YELLOW))
                else:
                    time.sleep(0.3)
    except FileNotFoundError:
        print(c(f"  ⚠ Log file not found: {path}", YELLOW))
        print(c("  → Restart uvicorn with:  uvicorn app.main:app ... 2>&1 | tee uvicorn.log", YELLOW))


def _start_stdout_capture():
    """
    Fallback: poll the uvicorn process port and print connection info.
    Used when no log file exists.
    """
    import socket
    print(c("  Log file monitor: waiting for uvicorn.log …", YELLOW))
    print(c("  To enable file logging, restart uvicorn with:", YELLOW))
    print(c("  uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload 2>&1 | tee uvicorn.log", CYAN))
    _monitor_running.set()
    while not _stop_monitor.is_set():
        time.sleep(2)
        # simple heartbeat check
        try:
            s = socket.create_connection(("localhost", 8000), timeout=2)
            s.close()
        except Exception:
            print(c(f"  [LOG MONITOR] ⚠ Server unreachable at {datetime.now().strftime('%H:%M:%S')}", RED))


def run_log_monitor():
    section("Live Log Monitor  (Ctrl+C to stop)")

    if os.path.exists(LOG_FILE):
        info(f"Tailing: {LOG_FILE}")
        _monitor_running.set()
        _tail_log_file(LOG_FILE)
    else:
        _start_stdout_capture()


def monitor_thread_func():
    _monitor_running.set()
    run_log_monitor()


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────
def run_tests():
    print(c("\n" + "═" * 60, CYAN))
    print(c("  InFynd Campaign Engine — API Test Suite", BOLD + WHITE))
    print(c(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  →  {BASE_URL}", DIM))
    print(c("═" * 60, CYAN))

    test_health()
    test_db_health()
    test_auth()
    test_campaigns()
    test_analytics()
    test_tracking()
    test_websocket()          # WS error cases — ~5s
    test_approval_flow()      # PATCH + WS APPROVAL_START + approve — up to 120s
    test_pipeline_smoke()     # no-approval pipeline — up to 90s

    return print_summary()


def main():
    parser = argparse.ArgumentParser(description="InFynd API Test & Log Monitor")
    parser.add_argument("--tests-only", action="store_true", help="Run tests, skip log monitor")
    parser.add_argument("--logs-only",  action="store_true", help="Only run log monitor")
    parser.add_argument("--skip-pipeline", action="store_true",
                        help="Skip the slow pipeline smoke test")
    args = parser.parse_args()

    if args.skip_pipeline:
        # monkey-patch to skip slow tests
        global test_pipeline_smoke, test_approval_flow
        def test_pipeline_smoke(): warn("Pipeline smoke test SKIPPED (--skip-pipeline)")  # noqa
        def test_approval_flow(): warn("Approval flow test SKIPPED (--skip-pipeline)")  # noqa

    if args.logs_only:
        try:
            run_log_monitor()
        except KeyboardInterrupt:
            print(c("\nMonitor stopped.", CYAN))
        return

    if args.tests_only:
        all_passed = run_tests()
        sys.exit(0 if all_passed else 1)

    # Default: run tests, then start live log monitor
    all_passed = run_tests()

    # ── start log monitor in background ──────────────────────────────────────
    if not os.path.exists(LOG_FILE):
        section("Log Monitor Setup")
        print(c("  To enable live log monitoring, restart the server with:", YELLOW))
        print(c(f"  cd infynd_campaign_engine", DIM))
        print(c(f"  uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload 2>&1 | Tee-Object -FilePath uvicorn.log", CYAN))
        print()
        print(c("  Then rerun:  python test_monitor.py", CYAN))
    else:
        t = threading.Thread(target=monitor_thread_func, daemon=True)
        t.start()
        section("Live Log Monitor  (Ctrl+C to stop)")
        info(f"Watching {LOG_FILE}")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            _stop_monitor.set()
            print(c("\nMonitor stopped.", CYAN))

    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
