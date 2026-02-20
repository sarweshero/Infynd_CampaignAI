import logging
import uuid
from typing import List
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update, func

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_roles, TokenData
from app.models.campaign import Campaign, PipelineState
from app.models.pipeline import CampaignLog
from app.models.tracking import OutboundMessage
from app.schemas.campaign import (
    CampaignCreate, CampaignResponse, ContentEditRequest,
    ErrorResponse, LogEntry, MessageEntry,
)
from app.services.pipeline_runner import execute_pipeline
from app.services.dispatch_service import dispatch_campaign
from app.services.tts_service import list_voices, synthesize_wav
from app.core.database import AsyncSessionLocal
from app.models.contact import Contact
from app.models.tracking import OutboundMessage, EngagementHistory
from datetime import datetime
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/campaigns", tags=["Campaigns"])


def _campaign_response(campaign: Campaign) -> dict:
    """Serialize Campaign ORM object to response dict, computing auto_approve_content."""
    # pipeline_state is a PipelineState enum — extract the string value
    ps = campaign.pipeline_state
    pipeline_state_str = ps.value if hasattr(ps, "value") else str(ps)

    return {
        "id":                  campaign.id,
        "name":                campaign.name,
        "company":             campaign.company,
        "campaign_purpose":    campaign.campaign_purpose,
        "target_audience":     campaign.target_audience,
        "product_link":        campaign.product_link,
        "prompt":              campaign.prompt,
        "platform":            campaign.platform,
        "pipeline_state":      pipeline_state_str,
        "approval_status":     campaign.approval_status,
        "approval_required":   campaign.approval_required,
        "auto_approve_content": not campaign.approval_required,
        "approved_by":         campaign.approved_by,
        "approved_at":         campaign.approved_at,
        "created_by":          campaign.created_by,
        "created_at":          campaign.created_at,
        "generated_content":   campaign.generated_content,
    }


async def _dispatch_background(campaign_id: str):
    """Launch dispatch in its own DB session so it survives after request close."""
    async with AsyncSessionLocal() as db:
        await dispatch_campaign(db, campaign_id)


@router.post("/", response_model=CampaignResponse, status_code=status.HTTP_201_CREATED)
async def create_campaign(
    payload: CampaignCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER"])),
):
    """Create a campaign from a single prompt and launch the async pipeline."""
    # Initial name: first 60 chars of prompt — Agent 0 will replace with a proper title
    initial_name = payload.prompt[:60].strip() + "…" if len(payload.prompt) > 60 else payload.prompt.strip()

    campaign = Campaign(
        name=initial_name,
        product_link=payload.product_link,
        prompt=payload.prompt,
        # auto_approve_content=True → approval_required=False (no WS gate)
        approval_required=not payload.auto_approve_content,
        pipeline_state=PipelineState.CREATED,
        created_by=current_user.email,
    )
    db.add(campaign)
    await db.commit()
    await db.refresh(campaign)

    background_tasks.add_task(execute_pipeline, str(campaign.id))
    logger.info(f"[API] Campaign created: {campaign.id} by {current_user.email}")
    return _campaign_response(campaign)


@router.get("/", response_model=List[CampaignResponse])
async def list_campaigns(
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    result = await db.execute(select(Campaign).order_by(Campaign.created_at.desc()))
    return [_campaign_response(c) for c in result.scalars().all()]


@router.get("/count")
async def count_campaigns(
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    """Lightweight campaign count – avoids full list fetch when table is empty."""
    result = await db.execute(select(func.count(Campaign.id)))
    return {"count": result.scalar_one()}


@router.get("/{campaign_id}", response_model=CampaignResponse)
async def get_campaign(
    campaign_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Campaign not found", "code": "NOT_FOUND"},
        )
    return _campaign_response(campaign)


@router.get("/{campaign_id}/logs", response_model=List[LogEntry])
async def get_campaign_logs(
    campaign_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    """Return per-agent execution logs for a campaign."""
    result = await db.execute(
        select(CampaignLog)
        .where(CampaignLog.campaign_id == campaign_id)
        .order_by(CampaignLog.started_at.asc())
    )
    return result.scalars().all()


@router.get("/{campaign_id}/messages", response_model=List[MessageEntry])
async def get_campaign_messages(
    campaign_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    """Return outbound messages and their send/tracking status."""
    result = await db.execute(
        select(OutboundMessage)
        .where(OutboundMessage.campaign_id == campaign_id)
        .order_by(OutboundMessage.sent_at.asc().nullslast())
    )
    return result.scalars().all()


@router.patch("/{campaign_id}/content/{contact_email}")
async def edit_contact_content(
    campaign_id: uuid.UUID,
    contact_email: str,
    payload: ContentEditRequest,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER"])),
):
    """Edit generated content for a specific contact before approval."""
    result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Campaign not found", "code": "NOT_FOUND"},
        )
    if campaign.pipeline_state not in (PipelineState.CONTENT_GENERATED, PipelineState.AWAITING_APPROVAL):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"detail": "Content can only be edited before approval", "code": "INVALID_STATE"},
        )
    content = campaign.generated_content or {}
    personalized = content.get("personalized", {})
    if contact_email not in personalized:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Contact not found in generated content", "code": "CONTACT_NOT_FOUND"},
        )
    import copy
    new_content = copy.deepcopy(content)
    new_content["personalized"][contact_email]["content"] = payload.content
    await db.execute(update(Campaign).where(Campaign.id == campaign_id).values(generated_content=new_content))
    await db.commit()
    return {"message": "Content updated", "contact_email": contact_email}


@router.patch("/{campaign_id}/common-content/{channel}")
async def edit_common_content(
    campaign_id: uuid.UUID,
    channel: str,
    payload: ContentEditRequest,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER"])),
):
    """Edit the common (template) content for a specific channel before approval."""
    import copy
    result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Campaign not found", "code": "NOT_FOUND"},
        )
    if campaign.pipeline_state not in (PipelineState.CONTENT_GENERATED, PipelineState.AWAITING_APPROVAL):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"detail": "Common content can only be edited before approval", "code": "INVALID_STATE"},
        )
    content = campaign.generated_content or {}
    if "common" not in content or channel not in content["common"]:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": f"Channel '{channel}' not found in common content", "code": "CHANNEL_NOT_FOUND"},
        )
    new_content = copy.deepcopy(content)
    new_content["common"][channel] = payload.content
    await db.execute(update(Campaign).where(Campaign.id == campaign_id).values(generated_content=new_content))
    await db.commit()
    return {"message": "Common content updated", "channel": channel}


@router.get("/{campaign_id}/common-content/{channel}/audio")
async def get_common_content_audio(
    campaign_id: uuid.UUID,
    channel: str,
    rate: int = Query(default=168, ge=120, le=220),
    voice_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    """Generate and stream audio for the common call-channel template."""
    if channel.lower() != "call":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "Audio is only supported for Call channel", "code": "INVALID_CHANNEL"},
        )

    result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Campaign not found", "code": "NOT_FOUND"},
        )

    generated = campaign.generated_content or {}
    common = generated.get("common", {}) if isinstance(generated, dict) else {}
    call_template = common.get("Call") if isinstance(common, dict) else None
    if not isinstance(call_template, dict) or not call_template:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Call template not found in common content", "code": "NOT_FOUND"},
        )

    field_order = ["greeting", "value_prop", "objection_handler", "closing", "cta"]
    chunks = []
    for key in field_order:
        value = call_template.get(key)
        if isinstance(value, str) and value.strip():
            chunks.append(value.strip())
    for key, value in call_template.items():
        if key in field_order:
            continue
        if isinstance(value, str) and value.strip():
            chunks.append(value.strip())

    text = "\n".join(chunks).strip()
    if not text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"detail": "Call template has no text content to convert", "code": "EMPTY_CONTENT"},
        )

    try:
        audio_bytes = await synthesize_wav(text, rate=rate, voice_id=voice_id)
    except Exception as exc:
        logger.exception("[API] Failed to generate call template audio", exc_info=exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"detail": "Failed to generate audio for call template", "code": "AUDIO_GENERATION_FAILED"},
        )

    filename = f"campaign_{campaign_id}_call_template.wav"
    return StreamingResponse(
        BytesIO(audio_bytes),
        media_type="audio/wav",
        headers={"Content-Disposition": f"inline; filename={filename}"},
    )


@router.get("/{campaign_id}/common-content/{channel}/audio/voices")
async def get_common_content_audio_voices(
    campaign_id: uuid.UUID,
    channel: str,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    """List available local TTS voices for call-channel audio generation."""
    if channel.lower() != "call":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"detail": "Voices are only supported for Call channel", "code": "INVALID_CHANNEL"},
        )

    result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Campaign not found", "code": "NOT_FOUND"},
        )

    try:
        voices = await list_voices()
    except Exception as exc:
        logger.exception("[API] Failed to list call template voices", exc_info=exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"detail": "Failed to list audio voices", "code": "AUDIO_VOICES_FAILED"},
        )

    return {"voices": voices}


@router.post("/{campaign_id}/approve")
async def approve_campaign(
    campaign_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER"])),
):
    """Approve entire campaign and trigger dispatch."""
    from datetime import datetime
    result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail={"detail": "Campaign not found", "code": "NOT_FOUND"})
    if campaign.pipeline_state != PipelineState.AWAITING_APPROVAL:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail={"detail": "Campaign is not awaiting approval", "code": "INVALID_STATE"})
    await db.execute(
        update(Campaign).where(Campaign.id == campaign_id).values(
            pipeline_state=PipelineState.APPROVED,
            approval_status="APPROVED",
            approved_by=current_user.email,
            approved_at=datetime.utcnow(),
        )
    )
    await db.commit()
    background_tasks.add_task(_dispatch_background, str(campaign_id))
    return {"message": "Campaign approved and dispatch initiated"}


@router.post("/{campaign_id}/regenerate-content")
async def regenerate_content(
    campaign_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER"])),
):
    """Re-run the ContentGeneratorAgent for a campaign (re-generates all content)."""
    from app.agents.content_generator_agent import run_content_generator_agent
    from app.models.pipeline import PipelineRun

    result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail={"detail": "Campaign not found", "code": "NOT_FOUND"})

    allowed = (
        PipelineState.CONTENT_GENERATED,
        PipelineState.AWAITING_APPROVAL,
        PipelineState.FAILED,
    )
    if campaign.pipeline_state not in allowed:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail={"detail": "Content can only be regenerated after content generation step", "code": "INVALID_STATE"})

    # Find latest pipeline_run for this campaign
    run_result = await db.execute(
        select(PipelineRun)
        .where(PipelineRun.campaign_id == campaign_id)
        .order_by(PipelineRun.started_at.desc())
    )
    pipeline_run = run_result.scalars().first()
    if not pipeline_run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail={"detail": "No pipeline run found for this campaign", "code": "NOT_FOUND"})

    async def _run_regen():
        async with AsyncSessionLocal() as bg_db:
            result2 = await bg_db.execute(select(Campaign).where(Campaign.id == campaign_id))
            camp = result2.scalar_one_or_none()
            run_result2 = await bg_db.execute(
                select(PipelineRun)
                .where(PipelineRun.campaign_id == campaign_id)
                .order_by(PipelineRun.started_at.desc())
            )
            pr = run_result2.scalars().first()
            if camp and pr:
                await run_content_generator_agent(bg_db, camp, pr)
                # Reset to AWAITING_APPROVAL if approval_required
                next_state = PipelineState.AWAITING_APPROVAL if camp.approval_required else PipelineState.CONTENT_GENERATED
                await bg_db.execute(
                    update(Campaign).where(Campaign.id == campaign_id)
                    .values(pipeline_state=next_state)
                )
                await bg_db.commit()

    background_tasks.add_task(_run_regen)
    return {"message": "Content regeneration started"}


class SendPreviewRequest(BaseModel):
    contact_email: str
    replacements: dict | None = None


class SendOneRequest(BaseModel):
    to_email: str
    subject: str
    body: str
    cta_link: str | None = None
    replacements: dict | None = None


@router.post("/admin/send-one")
async def send_one(
    payload: SendOneRequest,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER"])),
):
    """Admin-only: send a one-off email with optional placeholder replacements."""
    # Apply basic substitutions from replacements
    subject = payload.subject
    body = payload.body
    cta = payload.cta_link or payload.replacements.get("PRODUCT_LINK") if payload.replacements else ""

    def _sub(s: str) -> str:
        if not isinstance(s, str):
            return s
        out = s
        for k, v in (payload.replacements or {}).items():
            out = out.replace(f"[{k}]", str(v))
        out = out.replace("[Your Name]", (payload.replacements or {}).get("Your Name", "Alex from Xyndrix"))
        out = out.replace("Morning", "morning")
        return out

    subject = _sub(subject)
    body = _sub(body)
    cta = _sub(cta)
    html_body = f"{body}<br><br><a href='{cta}'>{cta}</a>"

    provider_message_id = await send_email(
        to_email=payload.to_email,
        subject=subject,
        html_body=html_body,
        campaign_id="manual",
    )

    return {"to": payload.to_email, "sent": bool(provider_message_id), "provider_message_id": provider_message_id}


@router.post("/{campaign_id}/send-preview")
async def send_preview(
    campaign_id: uuid.UUID,
    payload: SendPreviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER"])),
):
    """Send a single personalized preview email for a campaign contact (admin-only).
    Performs placeholder substitution from contact and campaign fields.
    """
    result = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"detail": "Campaign not found", "code": "NOT_FOUND"})

    generated = campaign.generated_content or {}
    personalized = generated.get("personalized") or {}

    contact_email = payload.contact_email
    contact_data = personalized.get(contact_email) or {}

    # Fetch contact record for substitution
    contact_record = None
    try:
        cr = await db.execute(select(Contact).where(Contact.email == contact_email))
        contact_record = cr.scalar_one_or_none()
    except Exception:
        contact_record = None

    # Compose content
    if isinstance(contact_data, dict) and contact_data:
        channel = contact_data.get("channel", "Email")
        content = contact_data.get("content", {})
    else:
        common = generated.get("common", {})
        channel = (common.get("channel") or "Email")
        content = common.get("content") or {}

    if channel != "Email":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"detail": "Preview only supported for Email channel", "code": "INVALID_CHANNEL"})

    subject = content.get("subject", f"Message from {campaign.name}")
    body = content.get("body", "")
    cta = content.get("cta_link", campaign.product_link or "")

    # Apply simple substitutions
    def _sub(s: str) -> str:
        if not isinstance(s, str):
            return s
        out = s
        if contact_record:
            out = out.replace("[CONTACT_NAME]", contact_record.name or "")
            out = out.replace("[CONTACT_ROLE]", contact_record.role or "")
            out = out.replace("[CONTACT_COMPANY]", contact_record.company or "")
        out = out.replace("[PRODUCT_LINK]", campaign.product_link or "")
        # apply user-supplied replacements
        for k, v in (payload.replacements or {}).items():
            out = out.replace(f"[{k}]", str(v))
        out = out.replace("[Your Name]", payload.replacements.get("Your Name") if payload.replacements and payload.replacements.get("Your Name") else "Alex from Xyndrix")
        out = out.replace("Morning", "morning")
        return out

    subject = _sub(subject)
    body = _sub(body)
    cta = _sub(cta)
    html_body = f"{body}<br><br><a href='{cta}'>{cta}</a>"

    # Send email
    provider_message_id = await send_email(
        to_email=contact_email,
        subject=subject,
        html_body=html_body,
        campaign_id=str(campaign_id),
    )

    send_status = "SENT" if provider_message_id else "FAILED"


    # Prevent creation for invalid contact_email
    if contact_email not in ("common", "personalized") and "@" in contact_email:
        msg = OutboundMessage(
            campaign_id=campaign_id,
            contact_email=contact_email,
            channel="Email",
            message_payload=str(content),
            send_status=send_status,
            provider_message_id=provider_message_id,
            sent_at=datetime.utcnow() if send_status == "SENT" else None,
        )
        db.add(msg)

    engage = EngagementHistory(
        campaign_id=campaign_id,
        contact_email=contact_email,
        channel="Email",
        event_type="SENT",
        payload=content,
        occurred_at=datetime.utcnow(),
    )
    db.add(engage)
    await db.commit()

    return {"contact_email": contact_email, "send_status": send_status, "provider_message_id": provider_message_id}
