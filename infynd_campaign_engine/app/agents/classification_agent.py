"""
Agent 1 — Classification Agent
Calls Ollama to derive structured targeting filters from campaign context.
Stores result in pipeline_runs.classification_summary.
Updates pipeline state to CLASSIFIED.
"""
import json
import logging
from datetime import datetime
from typing import Dict, Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from app.core.config import settings
from app.models.campaign import Campaign, PipelineState
from app.models.pipeline import PipelineRun, CampaignLog

logger = logging.getLogger(__name__)

CLASSIFICATION_PROMPT_TEMPLATE = """
You are a B2B targeting expert. Given the campaign information below, extract structured targeting filters.

Campaign Information:
- Company: {company}
- Campaign Purpose: {campaign_purpose}
- Target Audience: {target_audience}

Return a valid JSON object ONLY with no extra text, in exactly this format:
{{
  "filters": {{
    "role": "<target role or empty string>",
    "location": "<target location or empty string>",
    "category": "<industry category or empty string>",
    "company": "<target company type or empty string>"
  }}
}}
"""


async def _call_ollama(prompt: str) -> str:
    async with httpx.AsyncClient(timeout=settings.OLLAMA_TIMEOUT) as client:
        response = await client.post(
            settings.OLLAMA_URL,
            json={
                "model": settings.OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
            },
        )
        response.raise_for_status()
        return response.json()["response"]


async def run_classification_agent(
    db: AsyncSession,
    campaign: Campaign,
    pipeline_run: PipelineRun,
) -> Dict[str, Any]:
    started_at = datetime.utcnow()
    log = CampaignLog(
        campaign_id=campaign.id,
        agent_name="ClassificationAgent",
        started_at=started_at,
        status="RUNNING",
    )
    db.add(log)
    await db.flush()

    try:
        prompt = CLASSIFICATION_PROMPT_TEMPLATE.format(
            company=campaign.company or "",
            campaign_purpose=campaign.campaign_purpose or "",
            target_audience=campaign.target_audience or "",
        )

        raw_response = await _call_ollama(prompt)

        # Robustly extract JSON from the response
        json_start = raw_response.find("{")
        json_end = raw_response.rfind("}") + 1
        if json_start == -1:
            raise ValueError("Ollama returned no JSON for classification")
        classification = json.loads(raw_response[json_start:json_end])

        # Persist to pipeline_run
        await db.execute(
            update(PipelineRun)
            .where(PipelineRun.id == pipeline_run.id)
            .values(
                classification_summary=classification,
                state=PipelineState.CLASSIFIED,
            )
        )

        # Update campaign state
        await db.execute(
            update(Campaign)
            .where(Campaign.id == campaign.id)
            .values(pipeline_state=PipelineState.CLASSIFIED)
        )

        completed_at = datetime.utcnow()
        duration_ms = int((completed_at - started_at).total_seconds() * 1000)

        await db.execute(
            update(CampaignLog)
            .where(CampaignLog.id == log.id)
            .values(completed_at=completed_at, duration_ms=duration_ms, status="SUCCESS")
        )
        await db.commit()

        logger.info(f"[ClassificationAgent] Campaign {campaign.id} classified: {classification}")
        return classification

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
        logger.error(f"[ClassificationAgent] Failed for campaign {campaign.id}: {exc}")
        raise
