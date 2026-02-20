"""
Voice Agent Service
===================
Manages AI-powered outbound voice calls via Twilio + Ollama LLM.

Flow:
  1. POST /api/v1/campaigns/{id}/call-contacts  → initiates calls one-by-one.
  2. Twilio dials the contact, hits webhook  /api/v1/voice/answer  which delivers
     the opening pitch (TTS) and a <Gather input="speech"> element.
  3. When the contact speaks, Twilio POSTs the transcription to
     /api/v1/voice/gather.  We send the transcript + conversation history to the
     LLM, generate a reply, and return new TwiML.
  4. After MAX_TURNS exchanges, the agent says goodbye.

Conversation state is held in memory keyed by Twilio CallSid.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from twilio.rest import Client as TwilioClient

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.campaign import Campaign
from app.models.contact import Contact
from app.models.voice import VoiceCall

logger = logging.getLogger(__name__)

MAX_TURNS = 3
LLM_TIMEOUT_SECONDS = 10

# Thread pool for blocking Twilio SDK calls
_twilio_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="twilio")

# ── In-memory conversation store (keyed by CallSid) ────────────────────────
_conversations: Dict[str, Dict[str, Any]] = {}
_conv_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Conversation memory helpers
# ---------------------------------------------------------------------------

def create_conversation(call_sid: str, contact: Dict[str, Any], campaign_context: str) -> None:
    with _conv_lock:
        _conversations[call_sid] = {
            "contact": contact,
            "campaign_context": campaign_context,
            "turns": [],
            "turn_count": 0,
            "created_at": time.time(),
        }
    logger.info(f"[VoiceAgent] CREATE conv CallSid={call_sid} contact={contact.get('name')}")


def add_turn(call_sid: str, role: str, text: str) -> None:
    with _conv_lock:
        conv = _conversations.get(call_sid)
        if conv is None:
            logger.warning(f"[VoiceAgent] add_turn: no conv for CallSid={call_sid}")
            return
        conv["turns"].append({"role": role, "text": text})
        if role == "user":
            conv["turn_count"] += 1
    logger.debug(f"[VoiceAgent] TURN [{role}]: {text[:100]}")


def get_conversation(call_sid: str) -> Optional[Dict[str, Any]]:
    with _conv_lock:
        return _conversations.get(call_sid)


def remove_conversation(call_sid: str) -> None:
    with _conv_lock:
        _conversations.pop(call_sid, None)
    logger.info(f"[VoiceAgent] REMOVE conv CallSid={call_sid}")


# ---------------------------------------------------------------------------
# LLM reply via Ollama (async)
# ---------------------------------------------------------------------------

async def _ask_ollama(prompt: str) -> str:
    """Call Ollama generate endpoint with a timeout."""
    payload = {
        "model": settings.OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"num_predict": 80, "temperature": 0.7},
    }
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SECONDS) as client:
            resp = await client.post(settings.OLLAMA_URL, json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data.get("response", "").strip()
    except Exception as exc:
        logger.warning(f"[VoiceAgent] Ollama error: {exc}")
        return ""


async def generate_voice_reply(call_sid: str, user_speech: str) -> str:
    """Generate LLM reply for a voice turn."""
    conv = get_conversation(call_sid)
    if conv is None:
        return "Thank you for your time. Goodbye!"

    add_turn(call_sid, "user", user_speech)
    conv = get_conversation(call_sid)

    if conv["turn_count"] >= MAX_TURNS:
        farewell = _build_farewell(conv)
        add_turn(call_sid, "agent", farewell)
        return farewell

    contact = conv["contact"]
    history = "\n".join(
        f"{'Agent' if t['role'] == 'agent' else 'Contact'}: {t['text']}"
        for t in conv["turns"]
    )

    prompt = f"""### Instruction:
You are a friendly, professional sales agent on a phone call.
You are speaking to {contact.get('name', 'the contact')} who works as
{contact.get('role', 'a professional')} at {contact.get('company', 'their company')}.

Campaign pitch:
{conv['campaign_context'][:500]}

Conversation so far:
{history}

Rules:
- Reply in 1-2 short sentences ONLY. This is a phone call.
- Stay on topic. Be polite and professional.
- Plain speech only — no markdown, no special characters.

### Response:
"""

    raw = await _ask_ollama(prompt)

    # Take first non-empty, non-header line
    reply = ""
    for line in raw.strip().split("\n"):
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("---"):
            reply = line
            break
    if not reply:
        reply = raw[:200] if raw else _get_fallback_reply(conv)

    add_turn(call_sid, "agent", reply)
    logger.info(f"[VoiceAgent] LLM reply for {call_sid}: {reply!r}")
    return reply


def _get_fallback_reply(conv: Dict[str, Any]) -> str:
    name = conv["contact"].get("name", "")
    if conv.get("turn_count", 0) >= MAX_TURNS - 1:
        return _build_farewell(conv)
    return (
        f"That's really interesting{', ' + name if name else ''}. "
        "Could I send you more details via email?"
    )


def _build_farewell(conv: Dict[str, Any]) -> str:
    name = conv["contact"].get("name", "")
    return (
        f"Thank you so much for your time{', ' + name if name else ''}. "
        "We'll send you a follow-up email with all the details. "
        "Have a great day! Goodbye."
    )


# ---------------------------------------------------------------------------
# Opening pitch
# ---------------------------------------------------------------------------

def build_opening_pitch(contact: Dict[str, Any], campaign_context: str) -> str:
    name = contact.get("name", "there")
    company = contact.get("company", "your company")
    return (
        f"Hello {name}, this is the campaign outreach team. "
        f"I'm calling because we have an exciting opportunity for {company}. "
        "Do you have a moment to chat?"
    )


# ---------------------------------------------------------------------------
# Twilio: place one outbound call
# ---------------------------------------------------------------------------

def _get_twilio_client() -> TwilioClient:
    if not settings.TWILIO_ACCOUNT_SID or not settings.TWILIO_AUTH_TOKEN:
        raise RuntimeError("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured in .env")
    return TwilioClient(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)


async def initiate_call(
    to_number: str,
    contact: Dict[str, Any],
    campaign_context: str,
    campaign_id: str,
) -> Dict[str, Any]:
    """Place a single outbound call via Twilio (async wrapper)."""
    if not settings.NGROK_BASE_URL:
        raise RuntimeError("NGROK_BASE_URL not set in .env — start ngrok first.")
    if not settings.TWILIO_FROM_NUMBER:
        raise RuntimeError("TWILIO_FROM_NUMBER not set in .env.")

    answer_url = f"{settings.NGROK_BASE_URL}/api/v1/voice/answer"
    status_url = f"{settings.NGROK_BASE_URL}/api/v1/voice/status"

    def _create_call():
        client = _get_twilio_client()
        return client.calls.create(
            to=to_number,
            from_=settings.TWILIO_FROM_NUMBER,
            url=answer_url,
            status_callback=status_url,
            status_callback_event=["completed", "busy", "no-answer", "failed", "canceled"],
            status_callback_method="POST",
            method="POST",
        )

    loop = asyncio.get_event_loop()
    call = await loop.run_in_executor(_twilio_pool, _create_call)

    logger.info(f"[VoiceAgent] Call created SID={call.sid} to={to_number}")

    # Pre-seed conversation memory
    create_conversation(
        call_sid=call.sid,
        contact=contact,
        campaign_context=campaign_context,
    )

    # Record in DB
    await _record_call_db(campaign_id, contact, call.sid, "initiated")

    return {
        "call_sid": call.sid,
        "to": to_number,
        "name": contact.get("name"),
        "status": "initiated",
    }


# ---------------------------------------------------------------------------
# Batch call campaign contacts
# ---------------------------------------------------------------------------

async def call_campaign_contacts(
    campaign_id: str,
    delay_between: float = 2.0,
) -> Dict[str, Any]:
    """
    Dispatch outbound calls to every contact in the campaign.
    Contacts are sourced from generated_content['contacts'] map
    (these are the email → channel assignments from the pipeline).
    Phone numbers are looked up in the contacts table.
    """
    campaign_uuid = uuid.UUID(campaign_id)

    async with AsyncSessionLocal() as db:
        # Load campaign
        result = await db.execute(select(Campaign).where(Campaign.id == campaign_uuid))
        campaign = result.scalar_one_or_none()
        if not campaign:
            raise ValueError(f"Campaign {campaign_id} not found")

        generated: Dict[str, Any] = campaign.generated_content or {}
        contacts_map: Dict[str, str] = generated.get("contacts") or {}
        common_templates: Dict[str, Any] = generated.get("common") or {}
        call_template = common_templates.get("Call", {})
        call_script: str = " | ".join(
            f"{k}: {v}" for k, v in call_template.items() if isinstance(v, str) and k != "cta_link"
        ) or (
            f"We have an exciting opportunity that could benefit your company. "
            f"Campaign: {campaign.name}."
        )

        # Collect email → channel entries where channel is Call
        contact_emails: List[str] = [
            email for email, channel in contacts_map.items()
            if isinstance(email, str) and "@" in email and channel == "Call"
        ]

        # Fallback: if no Call-channel contacts, call everyone
        if not contact_emails:
            contact_emails = [e for e in contacts_map.keys() if isinstance(e, str) and "@" in e]

        # Fetch contact records
        contacts_result = await db.execute(
            select(Contact).where(Contact.email.in_(contact_emails))
        )
        contact_records: List[Contact] = contacts_result.scalars().all()

    if not contact_records:
        logger.warning(f"[VoiceAgent] No contacts found for campaign {campaign_id}")
        return {"total": 0, "called": 0, "skipped": 0, "results": [], "message": "No contacts found"}

    called = 0
    skipped = 0
    results: List[Dict[str, Any]] = []

    for contact in contact_records:
        # Prefer phone_number column if present, else fallback
        phone = getattr(contact, "phone_number", None) or getattr(contact, "phoneno", None) or getattr(contact, "phone", None) or ""
        phone = str(phone).strip().replace(" ", "")

        logger.info(f"[VoiceAgent] Contact: {contact.name} | email={contact.email} | phone={phone!r}")

        if not phone:
            skipped += 1
            logger.warning(f"[VoiceAgent] SKIP {contact.name} — no phone number")
            results.append({
                "contact_email": contact.email,
                "name": contact.name,
                "status": "skipped",
                "reason": "No phone number",
            })
            continue

        # Ensure E.164 format
        if not phone.startswith("+"):
            phone = "+91" + phone

        contact_dict = {
            "name": contact.name,
            "email": contact.email,
            "company": contact.company,
            "role": contact.role,
        }

        try:
            call_result = await initiate_call(phone, contact_dict, call_script, campaign_id)
            called += 1
            results.append(call_result)
        except Exception as exc:
            logger.error(f"[VoiceAgent] Call FAILED for {contact.name}: {exc}")
            results.append({
                "contact_email": contact.email,
                "name": contact.name,
                "status": "failed",
                "error": str(exc),
            })

        if delay_between > 0:
            await asyncio.sleep(delay_between)

    return {
        "total": len(contact_records),
        "called": called,
        "skipped": skipped,
        "results": results,
    }


# ---------------------------------------------------------------------------
# DB helpers (async)
# ---------------------------------------------------------------------------

async def _record_call_db(campaign_id: str, contact: Dict[str, Any], call_sid: str, status: str) -> None:
    try:
        async with AsyncSessionLocal() as db:
            db.add(VoiceCall(
                campaign_id=uuid.UUID(campaign_id),
                contact_name=contact.get("name"),
                contact_email=contact.get("email"),
                contact_phone=contact.get("phone", ""),
                call_sid=call_sid,
                status=status,
            ))
            await db.commit()
        logger.info(f"[VoiceAgent] DB: recorded call {call_sid}")
    except Exception as exc:
        logger.warning(f"[VoiceAgent] DB: failed to record call {call_sid}: {exc}")


async def update_call_status(call_sid: str, status: str) -> None:
    """Update call status and save conversation log to DB."""
    conv = get_conversation(call_sid)
    try:
        async with AsyncSessionLocal() as db:
            values: Dict[str, Any] = {
                "status": status,
                "updated_at": datetime.utcnow(),
            }
            if conv and conv.get("turns"):
                values["conversation_log"] = conv["turns"]
            await db.execute(
                update(VoiceCall).where(VoiceCall.call_sid == call_sid).values(**values)
            )
            await db.commit()
        logger.info(f"[VoiceAgent] DB: call {call_sid} → {status}")
    except Exception as exc:
        logger.warning(f"[VoiceAgent] DB: failed to update call {call_sid}: {exc}")
    finally:
        remove_conversation(call_sid)
