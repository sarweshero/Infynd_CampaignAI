import logging
import uuid
from typing import List, Dict, Any

from fastapi import APIRouter, Request, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import update

from app.core.database import AsyncSessionLocal
from app.models.tracking import EmailTrackingEvent, EngagementHistory, ConversionEvent
from app.models.tracking import OutboundMessage
from app.services.sendgrid_service import verify_sendgrid_signature

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/tracking", tags=["Tracking"])


@router.post("/sendgrid", status_code=status.HTTP_200_OK)
async def sendgrid_webhook(request: Request):
    """
    Ingest SendGrid event webhook.
    Validates HMAC signature, inserts events, updates outbound_messages.
    """
    raw_body = await request.body()
    signature = request.headers.get("X-Twilio-Email-Event-Webhook-Signature", "")
    timestamp = request.headers.get("X-Twilio-Email-Event-Webhook-Timestamp", "")

    if signature and not verify_sendgrid_signature(raw_body, signature, timestamp):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"detail": "Invalid SendGrid webhook signature", "code": "INVALID_SIGNATURE"},
        )

    events: List[Dict[str, Any]] = await request.json()

    async with AsyncSessionLocal() as db:
        for event in events:
            event_type = event.get("event", "").lower()
            contact_email = event.get("email", "")
            message_id = event.get("sg_message_id", "")
            timestamp_val = event.get("timestamp")
            campaign_id_str = event.get("campaign_id") or (
                event.get("custom_args") or {}
            ).get("campaign_id")

            campaign_uuid = None
            if campaign_id_str:
                try:
                    campaign_uuid = uuid.UUID(campaign_id_str)
                except (ValueError, AttributeError):
                    pass

            tracking_event = EmailTrackingEvent(
                campaign_id=campaign_uuid,
                contact_email=contact_email,
                event_type=event_type,
                message_id=message_id,
                event_at=timestamp_val,
                raw_payload=event,
            )
            db.add(tracking_event)

            # Update outbound_messages.send_status
            if message_id:
                await db.execute(
                    update(OutboundMessage)
                    .where(OutboundMessage.provider_message_id == message_id)
                    .values(send_status=event_type.upper())
                )

            # Log to engagement_history
            if campaign_uuid:
                engagement = EngagementHistory(
                    campaign_id=campaign_uuid,
                    contact_email=contact_email,
                    channel="Email",
                    event_type=event_type.upper(),
                    payload=event,
                )
                db.add(engagement)

                # Conversion event if applicable
                if event_type in ("click", "open") and campaign_uuid:
                    conversion = ConversionEvent(
                        campaign_id=campaign_uuid,
                        contact_email=contact_email,
                        event_type=f"EMAIL_{event_type.upper()}",
                        metadata_=event,
                    )
                    db.add(conversion)

        await db.commit()

    logger.info(f"[Tracking/SendGrid] Processed {len(events)} events")
    return {"status": "received", "count": len(events)}


@router.post("/call", status_code=status.HTTP_200_OK)
async def call_tracking(request: Request):
    """Ingest call outcome tracking events."""
    data = await request.json()
    campaign_id_str = data.get("campaign_id")
    contact_email = data.get("contact_email")
    event_type = data.get("event_type", "CALL_OUTCOME")

    if not campaign_id_str or not contact_email:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"detail": "Missing campaign_id or contact_email", "code": "VALIDATION_ERROR"},
        )

    async with AsyncSessionLocal() as db:
        campaign_uuid = uuid.UUID(campaign_id_str)
        engagement = EngagementHistory(
            campaign_id=campaign_uuid,
            contact_email=contact_email,
            channel="Call",
            event_type=event_type,
            payload=data,
        )
        db.add(engagement)
        await db.commit()

    return {"status": "received"}


@router.post("/linkedin", status_code=status.HTTP_200_OK)
async def linkedin_tracking(request: Request):
    """Ingest LinkedIn engagement tracking events."""
    data = await request.json()
    campaign_id_str = data.get("campaign_id")
    contact_email = data.get("contact_email")
    event_type = data.get("event_type", "LINKEDIN_ENGAGEMENT")

    if not campaign_id_str or not contact_email:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"detail": "Missing campaign_id or contact_email", "code": "VALIDATION_ERROR"},
        )

    async with AsyncSessionLocal() as db:
        campaign_uuid = uuid.UUID(campaign_id_str)
        engagement = EngagementHistory(
            campaign_id=campaign_uuid,
            contact_email=contact_email,
            channel="LinkedIn",
            event_type=event_type,
            payload=data,
        )
        db.add(engagement)
        await db.commit()

    return {"status": "received"}
