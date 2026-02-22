"""
Analytics Router
================
Returns real-time campaign analytics aggregated from engagement_history,
outbound_messages, and email_tracking_events.
"""

import uuid
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text, select

from app.core.database import get_db
from app.core.dependencies import require_roles, TokenData
from app.schemas.analytics import (
    CampaignAnalytics, ChannelBreakdown, HourlyActivity, TopContact,
)
from app.models.campaign import Campaign

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/campaigns", tags=["Analytics"])


@router.get("/{campaign_id}/analytics", response_model=CampaignAnalytics)
async def get_campaign_analytics(
    campaign_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER", "ANALYST"])),
):
    """Return comprehensive real-time analytics for a campaign."""

    campaign_result = await db.execute(
        select(Campaign).where(Campaign.id == campaign_id)
    )
    campaign = campaign_result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Campaign not found", "code": "NOT_FOUND"},
        )

    # ── Channel-level aggregation ──────────────────────────────────────
    channel_stats_query = text("""
        SELECT
            om.channel,
            COUNT(DISTINCT om.contact_email) AS sent,
            COUNT(DISTINCT CASE
                WHEN eh.event_type IN ('DELIVERED', 'ANSWERED') THEN eh.contact_email
            END) AS delivered,
            COUNT(DISTINCT CASE
                WHEN eh.event_type IN ('OPENED', 'open') THEN eh.contact_email
            END) AS opened,
            COUNT(DISTINCT CASE
                WHEN eh.event_type IN ('CLICKED', 'click') THEN eh.contact_email
            END) AS clicked,
            COUNT(DISTINCT CASE
                WHEN eh.event_type IN ('ANSWERED') THEN eh.contact_email
            END) AS answered,
            COUNT(DISTINCT CASE
                WHEN eh.event_type IN ('BOUNCED', 'DROPPED', 'FAILED',
                                       'BUSY', 'NO_ANSWER', 'CANCELED')
                THEN eh.contact_email
            END) AS bounced,
            COUNT(DISTINCT CASE
                WHEN eh.event_type = 'BUSY' THEN eh.contact_email
            END) AS busy,
            COUNT(DISTINCT CASE
                WHEN eh.event_type = 'NO_ANSWER' THEN eh.contact_email
            END) AS no_answer,
            COUNT(DISTINCT CASE
                WHEN ce.event_type IS NOT NULL THEN ce.contact_email
            END) AS conversions
        FROM outbound_messages om
        LEFT JOIN engagement_history eh
            ON eh.campaign_id = om.campaign_id
            AND eh.contact_email = om.contact_email
            AND eh.channel = om.channel
        LEFT JOIN conversion_events ce
            ON ce.campaign_id = om.campaign_id
            AND ce.contact_email = om.contact_email
        WHERE om.campaign_id = :cid
          AND om.send_status NOT IN ('PENDING', 'FAILED')
        GROUP BY om.channel
    """)

    result = await db.execute(channel_stats_query, {"cid": str(campaign_id)})
    rows = result.mappings().all()

    total_sent = 0
    total_delivered = 0
    total_opened = 0
    total_clicked = 0
    total_answered = 0
    total_bounced = 0
    total_busy = 0
    total_no_answer = 0
    total_conversions = 0
    calls_sent = 0
    breakdown = []

    for row in rows:
        sent        = int(row["sent"]        or 0)
        delivered   = int(row["delivered"]   or 0)
        opened      = int(row["opened"]      or 0)
        clicked     = int(row["clicked"]     or 0)
        answered    = int(row["answered"]    or 0)
        bounced     = int(row["bounced"]     or 0)
        busy        = int(row["busy"]        or 0)
        no_answer   = int(row["no_answer"]   or 0)
        conversions = int(row["conversions"] or 0)

        total_sent        += sent
        total_delivered   += delivered
        total_opened      += opened
        total_clicked     += clicked
        total_answered    += answered
        total_bounced     += bounced
        total_busy        += busy
        total_no_answer   += no_answer
        total_conversions += conversions

        if row["channel"] == "Call":
            calls_sent = sent

        breakdown.append(ChannelBreakdown(
            channel=row["channel"],
            sent=sent,
            delivered=delivered,
            opened=opened,
            clicked=clicked,
            answered=answered,
            bounced=bounced,
            busy=busy,
            no_answer=no_answer,
            conversion_count=conversions,
        ))

    # ── Total distinct contacts ────────────────────────────────────────
    total_contacts_result = await db.execute(
        text("SELECT COUNT(DISTINCT contact_email) FROM outbound_messages WHERE campaign_id = :cid"),
        {"cid": str(campaign_id)},
    )
    total_contacts = int(total_contacts_result.scalar() or 0)

    # ── Avg call duration (ANSWERED calls only) ────────────────────────
    avg_dur_result = await db.execute(
        text("""
            SELECT COALESCE(AVG(CAST(payload->>'duration_seconds' AS FLOAT)), 0)
            FROM engagement_history
            WHERE campaign_id = :cid
              AND channel = 'Call'
              AND event_type = 'ANSWERED'
              AND payload->>'duration_seconds' IS NOT NULL
              AND CAST(payload->>'duration_seconds' AS FLOAT) > 0
        """),
        {"cid": str(campaign_id)},
    )
    avg_call_duration = round(float(avg_dur_result.scalar() or 0), 1)

    # ── Hourly activity (post-SENT events bucketed by UTC hour) ─────────
    hourly_result = await db.execute(
        text("""
            SELECT
                TO_CHAR(DATE_TRUNC('hour', occurred_at), 'YYYY-MM-DD"T"HH24:00:00') AS hour,
                COUNT(*) AS cnt
            FROM engagement_history
            WHERE campaign_id = :cid
              AND event_type != 'SENT'
            GROUP BY DATE_TRUNC('hour', occurred_at)
            ORDER BY DATE_TRUNC('hour', occurred_at) ASC
        """),
        {"cid": str(campaign_id)},
    )
    hourly_activity = [
        HourlyActivity(hour=r["hour"], count=int(r["cnt"]))
        for r in hourly_result.mappings().all()
    ]

    # ── Top 5 engaged contacts (most post-SENT events) ──────────────────
    top_contacts_result = await db.execute(
        text("""
            SELECT contact_email, COUNT(*) AS events
            FROM engagement_history
            WHERE campaign_id = :cid
              AND event_type != 'SENT'
            GROUP BY contact_email
            ORDER BY events DESC
            LIMIT 5
        """),
        {"cid": str(campaign_id)},
    )
    top_contacts: list[TopContact] = []
    for r in top_contacts_result.mappings().all():
        # Get the true latest event for this contact
        latest_result = await db.execute(
            text("""
                SELECT event_type FROM engagement_history
                WHERE campaign_id = :cid AND contact_email = :email AND event_type != 'SENT'
                ORDER BY occurred_at DESC LIMIT 1
            """),
            {"cid": str(campaign_id), "email": r["contact_email"]},
        )
        top_contacts.append(TopContact(
            email=r["contact_email"],
            events=int(r["events"]),
            latest_event_type=latest_result.scalar_one_or_none(),
        ))

    # ── Rates ──────────────────────────────────────────────────────────
    def pct(num: int, denom: int) -> float:
        return round((num / denom * 100), 2) if denom > 0 else 0.0

    open_rate           = pct(total_opened,    total_sent)
    click_rate          = pct(total_clicked,   total_sent)
    conversion_rate     = pct(total_conversions, total_sent)
    delivery_rate       = pct(total_delivered, total_sent)
    answer_rate         = pct(total_answered,  calls_sent)
    reach_rate          = pct(total_delivered, total_contacts)
    click_to_open_rate  = pct(total_clicked,   total_opened)

    return CampaignAnalytics(
        campaign_id=campaign_id,
        total_contacts=total_contacts,
        sent=total_sent,
        delivered=total_delivered,
        opened=total_opened,
        clicked=total_clicked,
        answered=total_answered,
        bounced=total_bounced,
        busy=total_busy,
        no_answer=total_no_answer,
        conversion_rate=conversion_rate,
        open_rate=open_rate,
        click_rate=click_rate,
        delivery_rate=delivery_rate,
        answer_rate=answer_rate,
        reach_rate=reach_rate,
        click_to_open_rate=click_to_open_rate,
        avg_call_duration_seconds=avg_call_duration,
        hourly_activity=hourly_activity,
        top_engaged_contacts=top_contacts,
        breakdown_by_channel=breakdown,
    )
