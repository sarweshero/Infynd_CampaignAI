import uuid
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from app.core.database import get_db
from app.core.dependencies import require_roles, TokenData
from app.schemas.analytics import CampaignAnalytics, ChannelBreakdown
from app.models.campaign import Campaign
from sqlalchemy import select

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/campaigns", tags=["Analytics"])


@router.get("/{campaign_id}/analytics", response_model=CampaignAnalytics)
async def get_campaign_analytics(
    campaign_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER", "ANALYST"])),
):
    """Return comprehensive analytics for a campaign aggregated from DB queries."""

    # Verify campaign exists
    campaign_result = await db.execute(
        select(Campaign).where(Campaign.id == campaign_id)
    )
    campaign = campaign_result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"detail": "Campaign not found", "code": "NOT_FOUND"},
        )

    # Total contacts and send counts per channel
    channel_stats_query = text("""
        SELECT
            om.channel,
            COUNT(DISTINCT om.contact_email)                       AS sent,
            COUNT(DISTINCT CASE WHEN ete.event_type = 'open'  THEN ete.contact_email END) AS opened,
            COUNT(DISTINCT CASE WHEN ete.event_type = 'click' THEN ete.contact_email END) AS clicked,
            COUNT(DISTINCT CASE WHEN eh.event_type  = 'ANSWERED' THEN eh.contact_email END) AS answered,
            COUNT(DISTINCT CASE WHEN ce.event_type IS NOT NULL THEN ce.contact_email END) AS conversions
        FROM outbound_messages om
        LEFT JOIN email_tracking_events ete
            ON ete.campaign_id = om.campaign_id
            AND ete.contact_email = om.contact_email
        LEFT JOIN engagement_history eh
            ON eh.campaign_id = om.campaign_id
            AND eh.contact_email = om.contact_email
        LEFT JOIN conversion_events ce
            ON ce.campaign_id = om.campaign_id
            AND ce.contact_email = om.contact_email
        WHERE om.campaign_id = :campaign_id
          AND om.send_status NOT IN ('PENDING', 'FAILED')
        GROUP BY om.channel
    """)

    result = await db.execute(channel_stats_query, {"campaign_id": str(campaign_id)})
    rows = result.mappings().all()

    total_sent = 0
    total_opened = 0
    total_clicked = 0
    total_answered = 0
    total_conversions = 0
    breakdown = []

    for row in rows:
        sent = int(row["sent"] or 0)
        opened = int(row["opened"] or 0)
        clicked = int(row["clicked"] or 0)
        answered = int(row["answered"] or 0)
        conversions = int(row["conversions"] or 0)

        total_sent += sent
        total_opened += opened
        total_clicked += clicked
        total_answered += answered
        total_conversions += conversions

        breakdown.append(
            ChannelBreakdown(
                channel=row["channel"],
                sent=sent,
                opened=opened,
                clicked=clicked,
                answered=answered,
                conversion_count=conversions,
            )
        )

    # Total distinct contacts in campaign
    total_contacts_result = await db.execute(
        text("""
            SELECT COUNT(DISTINCT contact_email)
            FROM outbound_messages
            WHERE campaign_id = :campaign_id
        """),
        {"campaign_id": str(campaign_id)},
    )
    total_contacts = int(total_contacts_result.scalar() or 0)

    open_rate = round((total_opened / total_sent * 100), 2) if total_sent > 0 else 0.0
    click_rate = round((total_clicked / total_sent * 100), 2) if total_sent > 0 else 0.0
    conversion_rate = round((total_conversions / total_sent * 100), 2) if total_sent > 0 else 0.0

    return CampaignAnalytics(
        campaign_id=campaign_id,
        total_contacts=total_contacts,
        sent=total_sent,
        opened=total_opened,
        clicked=total_clicked,
        answered=total_answered,
        conversion_rate=conversion_rate,
        open_rate=open_rate,
        click_rate=click_rate,
        breakdown_by_channel=breakdown,
    )
