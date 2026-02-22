"""
Insights Router
===============
Cross-campaign and per-campaign summary statistics used by the
Dashboard, History and Tracking views.  All endpoints are designed
to be polled frequently (SWR refreshInterval ≈ 8-10 s) so they must
be fast — every query touches indexed columns only.
"""

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from app.core.database import get_db
from app.core.dependencies import require_roles, TokenData

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/insights", tags=["Insights"])


# ─────────────────────────────────────────────────────────────────────────────
#  GET /insights/global
#  Dashboard overview — campaign pipeline counts + global engagement metrics
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/global")
async def get_global_insights(
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER", "ANALYST"])),
):
    # ── Campaign state counts ──────────────────────────────────────────
    state_rows = await db.execute(
        text("""
            SELECT pipeline_state, COUNT(*) AS cnt
            FROM campaigns
            GROUP BY pipeline_state
        """)
    )
    state_map: dict[str, int] = {}
    for r in state_rows.mappings().all():
        state_map[r["pipeline_state"]] = int(r["cnt"])

    total_campaigns    = sum(state_map.values())
    completed          = state_map.get("COMPLETED", 0)
    failed_campaigns   = state_map.get("FAILED", 0)
    awaiting_approval  = state_map.get("AWAITING_APPROVAL", 0)
    dispatched         = state_map.get("DISPATCHED", 0)
    active_campaigns   = sum(
        v for k, v in state_map.items()
        if k not in {"COMPLETED", "FAILED", "CREATED", "AWAITING_APPROVAL"}
    )

    # ── Aggregate engagement across ALL campaigns ──────────────────────
    eng_row = await db.execute(
        text("""
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'SENT')      AS total_sent,
                COUNT(*) FILTER (WHERE event_type = 'DELIVERED') AS total_delivered,
                COUNT(*) FILTER (WHERE event_type = 'OPENED')    AS total_opened,
                COUNT(*) FILTER (WHERE event_type = 'CLICKED')   AS total_clicked,
                COUNT(*) FILTER (WHERE event_type = 'ANSWERED')  AS total_answered
            FROM engagement_history
        """)
    )
    eng = eng_row.mappings().first() or {}
    total_sent      = int(eng.get("total_sent",      0) or 0)
    total_delivered = int(eng.get("total_delivered", 0) or 0)
    total_opened    = int(eng.get("total_opened",    0) or 0)
    total_clicked   = int(eng.get("total_clicked",   0) or 0)
    total_answered  = int(eng.get("total_answered",  0) or 0)

    def pct(num: int, denom: int) -> float:
        return round(num / denom * 100, 2) if denom > 0 else 0.0

    delivery_rate = pct(total_delivered, total_sent)
    open_rate     = pct(total_opened,    total_sent)
    click_rate    = pct(total_clicked,   total_sent)

    # ── Outbound message channel breakdown ────────────────────────────
    ch_rows = await db.execute(
        text("""
            SELECT channel, COUNT(*) AS cnt
            FROM outbound_messages
            GROUP BY channel
        """)
    )
    channel_counts: dict[str, int] = {}
    for r in ch_rows.mappings().all():
        channel_counts[r["channel"]] = int(r["cnt"])

    # ── Recent activity (last 24 h events) ────────────────────────────
    recent_row = await db.execute(
        text("""
            SELECT COUNT(*) AS cnt FROM engagement_history
            WHERE occurred_at >= NOW() - INTERVAL '24 hours'
              AND event_type != 'SENT'
        """)
    )
    recent_events = int((recent_row.scalar() or 0))

    return {
        # Campaign pipeline
        "total_campaigns":   total_campaigns,
        "completed":         completed,
        "failed":            failed_campaigns,
        "active":            active_campaigns,
        "awaiting_approval": awaiting_approval,
        "dispatched":        dispatched,
        # Engagement
        "total_sent":      total_sent,
        "total_delivered": total_delivered,
        "total_opened":    total_opened,
        "total_clicked":   total_clicked,
        "total_answered":  total_answered,
        # Rates
        "delivery_rate": delivery_rate,
        "open_rate":     open_rate,
        "click_rate":    click_rate,
        # Channel split
        "channel_counts":  channel_counts,
        # Recency
        "events_last_24h": recent_events,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  GET /insights/history?campaign_id=<optional>
#  History page — execution log + outbound message counts
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/history")
async def get_history_insights(
    campaign_id: Optional[uuid.UUID] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER", "ANALYST"])),
):
    cid_filter = "AND campaign_id = :cid" if campaign_id else ""
    bind = {"cid": str(campaign_id)} if campaign_id else {}

    # ── Pipeline logs ──────────────────────────────────────────────────
    log_rows = await db.execute(
        text(f"""
            SELECT status, COUNT(*) AS cnt
            FROM campaign_logs
            WHERE 1=1 {cid_filter}
            GROUP BY status
        """),
        bind,
    )
    log_map: dict[str, int] = {}
    for r in log_rows.mappings().all():
        log_map[r["status"]] = int(r["cnt"])

    total_logs   = sum(log_map.values())
    success_logs = log_map.get("SUCCESS", 0)
    failed_logs  = log_map.get("FAILED", 0) + log_map.get("FAILED_SEND", 0)
    running_logs = log_map.get("RUNNING", 0)

    # ── Outbound messages ─────────────────────────────────────────────
    msg_rows = await db.execute(
        text(f"""
            SELECT channel, COUNT(*) AS cnt
            FROM outbound_messages
            WHERE 1=1 {cid_filter}
            GROUP BY channel
        """),
        bind,
    )
    msg_map: dict[str, int] = {}
    for r in msg_rows.mappings().all():
        msg_map[r["channel"]] = int(r["cnt"])

    total_messages   = sum(msg_map.values())
    email_messages   = msg_map.get("Email",    0)
    call_messages    = msg_map.get("Call",     0)
    linkedin_messages = msg_map.get("LinkedIn", 0)

    return {
        # Logs
        "total_logs":   total_logs,
        "success_logs": success_logs,
        "failed_logs":  failed_logs,
        "running_logs": running_logs,
        # Messages
        "total_messages":   total_messages,
        "email_messages":   email_messages,
        "call_messages":    call_messages,
        "linkedin_messages": linkedin_messages,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  GET /insights/tracking?campaign_id=<optional>
#  Tracking page — live event feed summary
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/tracking")
async def get_tracking_insights(
    campaign_id: Optional[uuid.UUID] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: TokenData = Depends(require_roles(["ADMIN", "MANAGER", "ANALYST"])),
):
    cid_filter = "AND campaign_id = :cid" if campaign_id else ""
    bind = {"cid": str(campaign_id)} if campaign_id else {}

    # Event type breakdown
    evt_rows = await db.execute(
        text(f"""
            SELECT event_type, COUNT(*) AS cnt
            FROM engagement_history
            WHERE 1=1 {cid_filter}
            GROUP BY event_type
        """),
        bind,
    )
    evt_map: dict[str, int] = {}
    for r in evt_rows.mappings().all():
        evt_map[r["event_type"]] = int(r["cnt"])

    # Channel breakdown for events
    ch_rows = await db.execute(
        text(f"""
            SELECT channel, COUNT(*) AS cnt
            FROM engagement_history
            WHERE 1=1 {cid_filter}
            GROUP BY channel
        """),
        bind,
    )
    ch_map: dict[str, int] = {}
    for r in ch_rows.mappings().all():
        ch_map[r["channel"]] = int(r["cnt"])

    total_events = sum(evt_map.values())
    sent         = evt_map.get("SENT",      0)
    delivered    = evt_map.get("DELIVERED", 0)
    opened       = evt_map.get("OPENED",    0)
    clicked      = evt_map.get("CLICKED",   0)
    answered     = evt_map.get("ANSWERED",  0)
    bounced      = evt_map.get("BOUNCED",   0) + evt_map.get("BOUNCE", 0)

    def pct(num: int, denom: int) -> float:
        return round(num / denom * 100, 2) if denom > 0 else 0.0

    return {
        "total_events":    total_events,
        "sent":            sent,
        "delivered":       delivered,
        "opened":          opened,
        "clicked":         clicked,
        "answered":        answered,
        "bounced":         bounced,
        "delivery_rate":   pct(delivered, sent),
        "open_rate":       pct(opened,    sent),
        "click_rate":      pct(clicked,   sent),
        "channel_counts":  ch_map,
        "event_breakdown": evt_map,
    }
