"""
Voice Router
============
Endpoints for AI-powered outbound voice calling via Twilio.

User-facing:
    POST /campaigns/{campaign_id}/call-contacts  — dial all contacts

Twilio webhooks (must be reachable via ngrok public URL):
    POST /voice/answer   — TwiML when call connects
    POST /voice/gather   — speech input → LLM reply → TwiML
    POST /voice/status   — call status callbacks (completed / failed / …)
"""

import logging
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, Form, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db, AsyncSessionLocal
from app.core.dependencies import get_current_user, TokenData
from app.models.voice import VoiceCall
from app.models.tracking import EngagementHistory
from app.services.voice_agent import (
    MAX_TURNS,
    add_turn,
    build_opening_pitch,
    call_campaign_contacts,
    generate_voice_reply,
    get_conversation,
    get_language,
    update_call_status,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Voice"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class CallResultItem(BaseModel):
    name: Optional[str] = None
    contact_email: Optional[str] = None
    call_sid: Optional[str] = None
    to: Optional[str] = None
    status: str
    reason: Optional[str] = None
    error: Optional[str] = None


class CallCampaignResponse(BaseModel):
    success: bool
    campaign_id: str
    total: int
    called: int
    skipped: int
    results: List[CallResultItem]
    timestamp: str


# ---------------------------------------------------------------------------
# POST /campaigns/{campaign_id}/call-contacts
# ---------------------------------------------------------------------------

@router.post(
    "/campaigns/{campaign_id}/call-contacts",
    response_model=CallCampaignResponse,
    summary="Call all contacts in a campaign via Twilio voice agent",
)
async def call_contacts(
    campaign_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    """
    Sequentially dials every contact that has a phone number.
    Requires TWILIO_* and NGROK_BASE_URL set in .env.
    """
    logger.info(f"[Voice] call-contacts campaign={campaign_id} user={current_user.email}")

    try:
        result = await call_campaign_contacts(campaign_id=campaign_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    except Exception as exc:
        logger.error(f"[Voice] Unexpected error: {exc}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected error: {exc}",
        )

    return CallCampaignResponse(
        success=True,
        campaign_id=campaign_id,
        total=result["total"],
        called=result["called"],
        skipped=result["skipped"],
        results=[CallResultItem(**r) for r in result["results"]],
        timestamp=datetime.utcnow().isoformat(),
    )


# ---------------------------------------------------------------------------
# Twilio webhook: /voice/answer
# ---------------------------------------------------------------------------

@router.post("/voice/answer", include_in_schema=False)
async def voice_answer(
    CallSid: str = Form(""),
    From: str = Form(""),
    To: str = Form(""),
):
    """Return TwiML opening pitch + gather speech (language-aware)."""
    logger.info(f"[Voice] /answer CallSid={CallSid}")

    lang = get_language(CallSid)
    conv = get_conversation(CallSid)
    if conv:
        opening = build_opening_pitch(conv["contact"], conv["campaign_context"], lang)
    else:
        opening = (
            "Hello, this is the campaign outreach team. "
            "We have an exciting opportunity for your organisation. "
            "Do you have a moment to chat?"
        )
        logger.warning(f"[Voice] /answer: no conv for {CallSid}, using generic opening")

    add_turn(CallSid, "agent", opening)
    logger.info(f"[Voice] /answer lang={lang.name} ({lang.code}) voice={lang.twilio_voice}")
    return Response(
        content=_gather_twiml(opening, voice=lang.twilio_voice, language=lang.gather_lang),
        media_type="application/xml",
    )


# ---------------------------------------------------------------------------
# Twilio webhook: /voice/gather
# ---------------------------------------------------------------------------

@router.post("/voice/gather", include_in_schema=False)
async def voice_gather(
    CallSid: str = Form(""),
    SpeechResult: str = Form(""),
    Confidence: str = Form("0"),
):
    """Receive transcribed speech, call LLM, return TwiML reply (language-aware)."""
    logger.info(f"[Voice] /gather CallSid={CallSid} speech={SpeechResult!r}")

    lang = get_language(CallSid)
    user_text = SpeechResult.strip()
    if not user_text:
        no_hear = {
            "hi-IN": "मुझे सुनाई नहीं दिया। क्या आप दोहरा सकते हैं?",
            "ta-IN": "எனக்கு கேட்கவில்லை. தயவு செய்து மீண்டும் சொல்ல முடியுமா?",
            "te-IN": "నాకు వినపడలేదు. దయచేసి మళ్ళీ చెప్పగలరా?",
            "de-DE": "Das habe ich nicht verstanden. Könnten Sie das bitte wiederholen?",
            "fr-FR": "Je n'ai pas compris. Pourriez-vous répéter ?",
            "es-ES": "No le entendí. ¿Podría repetirlo?",
        }
        msg = no_hear.get(lang.code, "I didn't catch that. Could you please repeat?")
        return Response(
            content=_gather_twiml(msg, voice=lang.twilio_voice, language=lang.gather_lang),
            media_type="application/xml",
        )

    reply = await generate_voice_reply(CallSid, user_text)

    conv = get_conversation(CallSid)
    turns_done = (conv["turn_count"] >= MAX_TURNS) if conv else True

    if turns_done:
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="{lang.twilio_voice}" language="{lang.gather_lang}">{_esc(reply)}</Say>
    <Hangup/>
</Response>"""
    else:
        twiml = _gather_twiml(reply, voice=lang.twilio_voice, language=lang.gather_lang)

    return Response(content=twiml, media_type="application/xml")


# ---------------------------------------------------------------------------
# Twilio webhook: /voice/status
# ---------------------------------------------------------------------------

@router.post("/voice/status", include_in_schema=False)
async def voice_status(
    CallSid: str = Form(""),
    CallStatus: str = Form(""),
    CallDuration: str = Form("0"),
):
    """Record final call status, auto-create engagement tracking events."""
    logger.info(f"[Voice] /status CallSid={CallSid} status={CallStatus} duration={CallDuration}s")

    # Map Twilio call statuses to tracking event types
    STATUS_MAP = {
        "completed":  "ANSWERED",
        "busy":       "BUSY",
        "no-answer":  "NO_ANSWER",
        "failed":     "FAILED",
        "canceled":   "CANCELED",
        "in-progress": "IN_PROGRESS",
        "ringing":    "RINGING",
    }
    event_type = STATUS_MAP.get(CallStatus.lower(), CallStatus.upper())

    # Look up VoiceCall to get campaign_id and contact info
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(VoiceCall).where(VoiceCall.call_sid == CallSid)
            )
            voice_call = result.scalar_one_or_none()

            if voice_call:
                # Record engagement event for analytics
                engagement = EngagementHistory(
                    campaign_id=voice_call.campaign_id,
                    contact_email=voice_call.contact_email or "",
                    channel="Call",
                    event_type=event_type,
                    payload={
                        "call_sid": CallSid,
                        "status": CallStatus,
                        "duration_seconds": int(CallDuration or 0),
                        "contact_name": voice_call.contact_name,
                        "contact_phone": voice_call.contact_phone,
                    },
                )
                db.add(engagement)
                await db.commit()
                logger.info(
                    f"[Voice] Engagement recorded: {event_type} for "
                    f"{voice_call.contact_email} campaign={voice_call.campaign_id}"
                )
            else:
                logger.warning(f"[Voice] No VoiceCall found for CallSid={CallSid}")
    except Exception as exc:
        logger.error(f"[Voice] Failed to record engagement for {CallSid}: {exc}")

    # Update the voice_calls table status + conversation log
    await update_call_status(CallSid, CallStatus)
    return Response(content="<Response/>", media_type="application/xml")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _gather_twiml(say_text: str, voice: str = "Polly.Matthew", language: str = "en-US") -> str:
    """TwiML: say something then gather the next speech input (language-aware)."""
    gather_url = (
        f"{settings.NGROK_BASE_URL}/api/v1/voice/gather"
        if settings.NGROK_BASE_URL
        else "/api/v1/voice/gather"
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="speech" action="{gather_url}" method="POST"
            speechTimeout="auto" language="{language}" enhanced="true">
        <Say voice="{voice}" language="{language}">{_esc(say_text)}</Say>
    </Gather>
    <Say voice="{voice}" language="{language}">I didn't hear a response. Thank you for your time. Goodbye!</Say>
    <Hangup/>
</Response>"""


def _esc(text: str) -> str:
    """Escape XML special characters for TwiML <Say>."""
    return (
        text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&apos;")
    )
