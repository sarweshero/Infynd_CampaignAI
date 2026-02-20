"""
Agent 3 — Channel Decision Agent
Scores each contact per channel and picks the best channel.
Decision rules:
  - Highest score wins.
  - Tie: Email > LinkedIn > Call.
  - All null: Email.
Saves mapping in pipeline_runs.downstream_results.
Updates state to CHANNEL_DECIDED.
"""
import logging
from datetime import datetime
from typing import Dict, Any, List

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import update

from app.models.campaign import Campaign, PipelineState
from app.models.pipeline import PipelineRun, CampaignLog

logger = logging.getLogger(__name__)

CHANNEL_PRIORITY = ["Email", "LinkedIn", "Call"]


def _decide_channel(contact: Dict[str, Any]) -> str:
    """Return the best channel for a contact based on engagement rates."""

    def safe_float(val):
        try:
            return float(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    scores = {
        "Email": safe_float(contact.get("emailclickrate")),
        "LinkedIn": safe_float(contact.get("linkedinclickrate")),
        "Call": safe_float(contact.get("callanswerrate")),
    }

    # All null → Email
    non_null = {k: v for k, v in scores.items() if v is not None}
    if not non_null:
        return "Email"

    max_score = max(non_null.values())
    tied = [ch for ch, score in non_null.items() if score == max_score]

    # If tie, use priority order
    for ch in CHANNEL_PRIORITY:
        if ch in tied:
            return ch

    return "Email"


async def run_channel_decision_agent(
    db: AsyncSession,
    campaign: Campaign,
    pipeline_run: PipelineRun,
) -> Dict[str, str]:
    started_at = datetime.utcnow()
    log = CampaignLog(
        campaign_id=campaign.id,
        agent_name="ChannelDecisionAgent",
        started_at=started_at,
        status="RUNNING",
    )
    db.add(log)
    await db.flush()

    try:
        downstream = pipeline_run.downstream_results or {}
        contacts: List[Dict[str, Any]] = downstream.get("contacts", [])

        channel_map: Dict[str, str] = {}
        for contact in contacts:
            email = contact.get("email")
            if email:
                channel_map[email] = _decide_channel(contact)

        downstream["channel_map"] = channel_map
        await db.execute(
            update(PipelineRun)
            .where(PipelineRun.id == pipeline_run.id)
            .values(
                downstream_results=downstream,
                state=PipelineState.CHANNEL_DECIDED,
            )
        )
        await db.execute(
            update(Campaign)
            .where(Campaign.id == campaign.id)
            .values(pipeline_state=PipelineState.CHANNEL_DECIDED)
        )

        completed_at = datetime.utcnow()
        duration_ms = int((completed_at - started_at).total_seconds() * 1000)
        await db.execute(
            update(CampaignLog)
            .where(CampaignLog.id == log.id)
            .values(completed_at=completed_at, duration_ms=duration_ms, status="SUCCESS")
        )
        await db.commit()

        logger.info(f"[ChannelDecisionAgent] Campaign {campaign.id}: channel_map={channel_map}")
        return channel_map

    except Exception as exc:
        completed_at = datetime.utcnow()
        duration_ms = int((completed_at - started_at).total_seconds() * 1000)
        await db.execute(
            update(CampaignLog)
            .where(CampaignLog.id == log.id)
            .values(
                completed_at=completed_at,
                duration_ms=duration_ms,
                status="FAILED",
                error_message=str(exc),
            )
        )
        await db.commit()
        logger.error(f"[ChannelDecisionAgent] Failed for campaign {campaign.id}: {exc}")
        raise
