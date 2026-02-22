"""
Tracking Router
===============
Ingests real-time webhook events from SendGrid (email), Twilio (call),
and mock LinkedIn events.  Stores them in the DB and feeds the analytics
/ live-tracking pages.

Endpoints:
  POST /tracking/sendgrid   – SendGrid Event Webhook (ECDSA-signed)
  POST /tracking/call        – Call outcome events
  POST /tracking/linkedin    – LinkedIn engagement (mock)
  GET  /tracking/events/{campaign_id}  – Live event feed for a campaign
  GET  /tracking/events      – Recent events across all campaigns
"""

import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, Request, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, text, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal, get_db
from app.core.dependencies import get_current_user, TokenData
from app.models.tracking import (
    EmailTrackingEvent,
    EngagementHistory,
    ConversionEvent,
    OutboundMessage,
)
from app.services.sendgrid_service import verify_sendgrid_signature

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/tracking", tags=["Tracking"])


# ── Helper: resolve campaign_id from sg_message_id or email ───────────────
async def _resolve_campaign_id(
    db: AsyncSession,
    campaign_id_str: Optional[str],
    message_id: str,
    contact_email: str,
) -> Optional[uuid.UUID]:
    """Try to resolve campaign UUID from custom_args, then fall back to
    looking up outbound_messages by provider_message_id or contact email."""

    # 1. Direct from custom_args
    if campaign_id_str:
        try:
            return uuid.UUID(campaign_id_str)
        except (ValueError, AttributeError):
            pass

    # 2. From outbound_messages by provider_message_id
    if message_id:
        # SendGrid message IDs come as "abc.filter0123p1..." — match prefix
        prefix = message_id.split(".")[0] if "." in message_id else message_id
        result = await db.execute(
            select(OutboundMessage.campaign_id).where(
                OutboundMessage.provider_message_id.ilike(f"{prefix}%")
            ).limit(1)
        )
        row = result.scalar_one_or_none()
        if row:
            return row

    # 3. From outbound_messages by email (most recent)
    if contact_email:
        result = await db.execute(
            select(OutboundMessage.campaign_id)
            .where(
                OutboundMessage.contact_email == contact_email,
                OutboundMessage.channel == "Email",
            )
            .order_by(desc(OutboundMessage.created_at))
            .limit(1)
        )
        row = result.scalar_one_or_none()
        if row:
            return row

    return None


# ═══════════════════════════════════════════════════════════════════════════
#  POST /tracking/sendgrid  — SendGrid Event Webhook
# ═══════════════════════════════════════════════════════════════════════════
@router.post("/sendgrid", status_code=status.HTTP_200_OK)
async def sendgrid_webhook(request: Request):
    """
    Ingest SendGrid event webhook.
    Validates ECDSA signature, inserts tracking events, updates outbound_messages.

    SendGrid event types we care about:
      processed, delivered, open, click, bounce, dropped,
      deferred, unsubscribe, spam_report
    """
    raw_body = await request.body()
    signature = request.headers.get("X-Twilio-Email-Event-Webhook-Signature", "")
    timestamp = request.headers.get("X-Twilio-Email-Event-Webhook-Timestamp", "")

    if signature and not verify_sendgrid_signature(raw_body, signature, timestamp):
        logger.warning("[Tracking/SendGrid] Invalid signature — rejecting")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"detail": "Invalid SendGrid webhook signature", "code": "INVALID_SIGNATURE"},
        )

    events: List[Dict[str, Any]] = await request.json()
    processed = 0

    async with AsyncSessionLocal() as db:
        for event in events:
            event_type = event.get("event", "").lower()
            contact_email = event.get("email", "")
            message_id = event.get("sg_message_id", "")
            timestamp_val = event.get("timestamp")

            # Extract campaign_id from custom_args or categories
            campaign_id_str = (
                event.get("campaign_id")
                or (event.get("custom_args") or {}).get("campaign_id")
            )
            # Also check SendGrid categories (we set campaign_id as a category)
            if not campaign_id_str:
                categories = event.get("category") or []
                if isinstance(categories, list):
                    for cat in categories:
                        try:
                            uuid.UUID(str(cat))
                            campaign_id_str = str(cat)
                            break
                        except (ValueError, AttributeError):
                            pass

            campaign_uuid = await _resolve_campaign_id(
                db, campaign_id_str, message_id, contact_email
            )

            # Store raw tracking event
            tracking_event = EmailTrackingEvent(
                campaign_id=campaign_uuid,
                contact_email=contact_email,
                event_type=event_type,
                message_id=message_id,
                event_at=timestamp_val,
                raw_payload=event,
            )
            db.add(tracking_event)

            # Update outbound_messages send_status
            if message_id:
                prefix = message_id.split(".")[0] if "." in message_id else message_id
                await db.execute(
                    text("""
                        UPDATE outbound_messages
                        SET send_status = :status
                        WHERE provider_message_id ILIKE :prefix
                    """),
                    {"status": event_type.upper(), "prefix": f"{prefix}%"},
                )

            # Log to engagement_history
            if campaign_uuid:
                # Map SendGrid events to our engagement event types
                ENGAGEMENT_MAP = {
                    "delivered": "DELIVERED",
                    "open": "OPENED",
                    "click": "CLICKED",
                    "bounce": "BOUNCED",
                    "dropped": "DROPPED",
                    "deferred": "DEFERRED",
                    "unsubscribe": "UNSUBSCRIBED",
                    "spam_report": "SPAM_REPORT",
                    "processed": "PROCESSED",
                }
                eng_type = ENGAGEMENT_MAP.get(event_type, event_type.upper())

                engagement = EngagementHistory(
                    campaign_id=campaign_uuid,
                    contact_email=contact_email,
                    channel="Email",
                    event_type=eng_type,
                    payload=event,
                )
                db.add(engagement)

                # Conversion events for opens and clicks
                if event_type in ("click", "open"):
                    conversion = ConversionEvent(
                        campaign_id=campaign_uuid,
                        contact_email=contact_email,
                        event_type=f"EMAIL_{event_type.upper()}",
                        metadata_=event,
                    )
                    db.add(conversion)

            processed += 1

        await db.commit()

    logger.info(f"[Tracking/SendGrid] Processed {processed} events")
    return {"status": "received", "count": processed}


# ═══════════════════════════════════════════════════════════════════════════
#  POST /tracking/call  — Call outcome events
# ═══════════════════════════════════════════════════════════════════════════
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


# ═══════════════════════════════════════════════════════════════════════════
#  POST /tracking/linkedin  — LinkedIn engagement (mock)
# ═══════════════════════════════════════════════════════════════════════════
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


# ═══════════════════════════════════════════════════════════════════════════
#  GET /tracking/events/{campaign_id}  — Live event feed for campaign
# ═══════════════════════════════════════════════════════════════════════════
class TrackingEvent(BaseModel):
    id: str
    campaign_id: str
    contact_email: str
    channel: str
    event_type: str
    occurred_at: str
    payload: Optional[dict] = None


class TrackingFeed(BaseModel):
    campaign_id: str
    events: List[TrackingEvent]
    total: int


@router.get("/events/{campaign_id}", response_model=TrackingFeed)
async def get_campaign_events(
    campaign_id: uuid.UUID,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    channel: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    """Return recent engagement events for a campaign (real-time feed)."""
    params: Dict[str, Any] = {"campaign_id": str(campaign_id), "limit": limit, "offset": offset}
    channel_filter = "AND eh.channel = :channel" if channel else ""
    if channel:
        params["channel"] = channel

    # UNION engagement_history with email_tracking_events that have no
    # corresponding engagement_history entry (catches OPENED/CLICKED events
    # whose campaign_uuid resolved to NULL during webhook processing).
    query = text(f"""
        SELECT id, campaign_id, contact_email, channel, event_type, occurred_at, payload
        FROM (
            SELECT CAST(eh.id AS text)         AS id,
                   CAST(eh.campaign_id AS text) AS campaign_id,
                   eh.contact_email, eh.channel,
                   eh.event_type, eh.occurred_at, eh.payload
            FROM engagement_history eh
            WHERE eh.campaign_id = CAST(:campaign_id AS uuid)
            {channel_filter}

            UNION ALL

            -- Include raw email_tracking_events only when campaign resolution
            -- failed at webhook time (campaign_id IS NULL) and the contact
            -- belongs to this campaign via outbound_messages.
            -- This avoids any double-counting with engagement_history.
            SELECT CAST(ete.id AS text)               AS id,
                   CAST(:campaign_id AS text)           AS campaign_id,
                   ete.contact_email,
                   'Email'                        AS channel,
                   UPPER(ete.event_type)          AS event_type,
                   to_timestamp(ete.event_at)     AS occurred_at,
                   ete.raw_payload                AS payload
            FROM email_tracking_events ete
            WHERE ete.campaign_id IS NULL
              AND ete.contact_email IN (
                  SELECT om.contact_email
                  FROM outbound_messages om
                  WHERE om.campaign_id = CAST(:campaign_id AS uuid)
                    AND om.channel = 'Email'
              )
        ) combined
        ORDER BY occurred_at DESC
        LIMIT :limit OFFSET :offset
    """)
    result = await db.execute(query, params)
    rows = result.mappings().all()

    count_params = {k: v for k, v in params.items() if k not in ("limit", "offset")}
    count_query = text(f"""
        SELECT COUNT(*) FROM (
            SELECT eh.id FROM engagement_history eh
            WHERE eh.campaign_id = CAST(:campaign_id AS uuid) {channel_filter}
            UNION ALL
            SELECT ete.id FROM email_tracking_events ete
            WHERE ete.campaign_id IS NULL
              AND ete.contact_email IN (
                  SELECT om.contact_email FROM outbound_messages om
                  WHERE om.campaign_id = CAST(:campaign_id AS uuid)
                    AND om.channel = 'Email'
              )
        ) combined
    """)
    total = int((await db.execute(count_query, count_params)).scalar() or 0)

    events = [
        TrackingEvent(
            id=str(row["id"]),
            campaign_id=str(row["campaign_id"]),
            contact_email=row["contact_email"],
            channel=row["channel"],
            event_type=row["event_type"],
            occurred_at=row["occurred_at"].isoformat() if row["occurred_at"] else "",
            payload=row["payload"],
        )
        for row in rows
    ]

    return TrackingFeed(
        campaign_id=str(campaign_id),
        events=events,
        total=total,
    )


# ═══════════════════════════════════════════════════════════════════════════
#  GET /tracking/events  — Recent events across all campaigns
# ═══════════════════════════════════════════════════════════════════════════
@router.get("/events", response_model=List[TrackingEvent])
async def get_all_events(
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(get_current_user),
):
    """Return the most recent engagement events across all campaigns."""
    result = await db.execute(
        text("""
            SELECT eh.id, eh.campaign_id, eh.contact_email, eh.channel,
                   eh.event_type, eh.occurred_at, eh.payload
            FROM engagement_history eh
            ORDER BY eh.occurred_at DESC
            LIMIT :limit
        """),
        {"limit": limit},
    )
    rows = result.mappings().all()
    return [
        TrackingEvent(
            id=str(row["id"]),
            campaign_id=str(row["campaign_id"]),
            contact_email=row["contact_email"],
            channel=row["channel"],
            event_type=row["event_type"],
            occurred_at=row["occurred_at"].isoformat() if row["occurred_at"] else "",
            payload=row["payload"],
        )
        for row in rows
    ]
