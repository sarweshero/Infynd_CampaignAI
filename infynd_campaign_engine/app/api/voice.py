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
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.dependencies import get_current_user, TokenData
from app.services.voice_agent import (
    MAX_TURNS,
    add_turn,
    build_opening_pitch,
    call_campaign_contacts,
    generate_voice_reply,
    get_conversation,
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
    """Return TwiML opening pitch + gather speech."""
    logger.info(f"[Voice] /answer CallSid={CallSid}")

    conv = get_conversation(CallSid)
    if conv:
        opening = build_opening_pitch(conv["contact"], conv["campaign_context"])
    else:
        opening = (
            "Hello, this is the campaign outreach team. "
            "We have an exciting opportunity for your organisation. "
            "Do you have a moment to chat?"
        )
        logger.warning(f"[Voice] /answer: no conv for {CallSid}, using generic opening")

    add_turn(CallSid, "agent", opening)
    return Response(content=_gather_twiml(opening), media_type="application/xml")


# ---------------------------------------------------------------------------
# Twilio webhook: /voice/gather
# ---------------------------------------------------------------------------

@router.post("/voice/gather", include_in_schema=False)
async def voice_gather(
    CallSid: str = Form(""),
    SpeechResult: str = Form(""),
    Confidence: str = Form("0"),
):
    """Receive transcribed speech, call LLM, return TwiML reply."""
    logger.info(f"[Voice] /gather CallSid={CallSid} speech={SpeechResult!r}")

    user_text = SpeechResult.strip()
    if not user_text:
        return Response(
            content=_gather_twiml("I didn't catch that. Could you please repeat?"),
            media_type="application/xml",
        )

    reply = await generate_voice_reply(CallSid, user_text)

    conv = get_conversation(CallSid)
    turns_done = (conv["turn_count"] >= MAX_TURNS) if conv else True

    if turns_done:
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Matthew" language="en-US">{_esc(reply)}</Say>
    <Hangup/>
</Response>"""
    else:
        twiml = _gather_twiml(reply)

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
    """Record final call status and clean up in-memory conversation."""
    logger.info(f"[Voice] /status CallSid={CallSid} status={CallStatus} duration={CallDuration}s")
    await update_call_status(CallSid, CallStatus)
    return Response(content="<Response/>", media_type="application/xml")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _gather_twiml(say_text: str) -> str:
    """TwiML: say something then gather the next speech input."""
    gather_url = (
        f"{settings.NGROK_BASE_URL}/api/v1/voice/gather"
        if settings.NGROK_BASE_URL
        else "/api/v1/voice/gather"
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="speech" action="{gather_url}" method="POST"
            speechTimeout="auto" language="en-US" enhanced="true">
        <Say voice="Polly.Matthew" language="en-US">{_esc(say_text)}</Say>
    </Gather>
    <Say voice="Polly.Matthew" language="en-US">I didn't hear a response. Thank you for your time. Goodbye!</Say>
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
