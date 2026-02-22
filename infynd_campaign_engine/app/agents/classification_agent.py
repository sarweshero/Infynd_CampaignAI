"""
Agent 1 — Classification Agent
Calls Ollama to derive structured targeting filters from campaign context.
Before calling Ollama, fetches distinct column values from the contacts table
and injects them as grounding context so the LLM picks values that actually exist.
Stores result in pipeline_runs.classification_summary.
Updates pipeline state to CLASSIFIED.
"""
import json
import logging
import time
from datetime import datetime
from typing import Dict, Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text, update

from app.core.config import settings
from app.models.campaign import Campaign, PipelineState
from app.models.pipeline import PipelineRun, CampaignLog

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
#  Schema-sample cache — avoids hitting the DB on every campaign run
#  Values are refreshed at most once per CACHE_TTL_SECONDS (default 1 hour).
# ─────────────────────────────────────────────────────────────────────────────
_SCHEMA_CACHE: Dict[str, Any] = {}
_CACHE_TTL_SECONDS: int = 3600          # 1 hour
_SAMPLE_LIMIT: int = 80                 # max distinct values fetched per column

# Columns to sample for grounding the LLM prompt
_SAMPLE_COLUMNS = ["role", "location", "category", "company"]


async def _fetch_column_samples(db: AsyncSession) -> Dict[str, list]:
    """
    Return distinct non-empty values for each filter column from the contacts table.
    Results are cached in-process for CACHE_TTL_SECONDS to minimise DB round-trips.
    """
    now = time.monotonic()
    cached_at: float = _SCHEMA_CACHE.get("_ts", 0.0)

    if now - cached_at < _CACHE_TTL_SECONDS and "data" in _SCHEMA_CACHE:
        logger.debug("[ClassificationAgent] Using cached column samples")
        return _SCHEMA_CACHE["data"]   # type: ignore[return-value]

    logger.info("[ClassificationAgent] Fetching fresh distinct-value samples from contacts table")
    samples: Dict[str, list] = {}

    for col in _SAMPLE_COLUMNS:
        try:
            rows = await db.execute(
                text(
                    f"SELECT DISTINCT {col} FROM contacts "
                    f"WHERE {col} IS NOT NULL AND TRIM({col}) != '' "
                    f"ORDER BY {col} LIMIT :lim"
                ),
                {"lim": _SAMPLE_LIMIT},
            )
            samples[col] = [r[0] for r in rows.fetchall()]
        except Exception as exc:
            logger.warning(f"[ClassificationAgent] Could not sample column '{col}': {exc}")
            samples[col] = []

    _SCHEMA_CACHE["data"] = samples
    _SCHEMA_CACHE["_ts"] = now
    return samples


def _format_samples(samples: Dict[str, list]) -> str:
    """Render the column samples into a readable block for the LLM prompt."""
    lines = []
    for col in _SAMPLE_COLUMNS:
        vals = samples.get(col, [])
        if vals:
            # Show at most 40 values in the prompt to keep it concise
            preview = ", ".join(f'"{v}"' for v in vals[:40])
            if len(vals) > 40:
                preview += f" … (+{len(vals) - 40} more)"
            lines.append(f"  {col}: [{preview}]")
        else:
            lines.append(f"  {col}: [no data]")
    return "\n".join(lines)


CLASSIFICATION_PROMPT_TEMPLATE = """
You are a B2B targeting expert. Given the campaign information below, extract structured targeting filters.

Campaign Information:
- Company: {company}
- Campaign Purpose: {campaign_purpose}
- Target Audience: {target_audience}

Below are the ACTUAL distinct values that exist in the contact database for each filter field.
You MUST choose values that closely match entries from these lists — do not invent values that are not present.

Available database values:
{column_samples}

Return a valid JSON object ONLY with no extra text, in exactly this format:
{{
  "filters": {{
    "role": "<target job titles/roles — pick from the role list above, comma-separated if multiple, or empty string>",
    "location": "<specific city/country from the location list above — or empty string if not mentioned>",
    "category": "<industry vertical from the category list above — or empty string>",
    "company": "<specific target company from the company list above — or empty string. Do NOT write descriptions.>"
  }}
}}

Rules:
- role: choose the closest matching title(s) from the role list; use concrete job titles only
- company: leave EMPTY unless a specific company name is mentioned as a target
- location: leave EMPTY unless a specific city/region/country is mentioned
- category: pick the closest industry vertical from the category list above
"""


async def _call_ollama(prompt: str) -> str:
    async with httpx.AsyncClient(timeout=settings.OLLAMA_TIMEOUT) as client:
        response = await client.post(
            settings.OLLAMA_URL,
            json={
                "model": settings.OLLAMA_MODEL,
                "prompt": prompt,
                "format": "json",  # strict JSON mode — no markdown wrapping
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
        # ── Fetch distinct column values to ground the LLM (cached for 1 h) ──
        column_samples = await _fetch_column_samples(db)
        formatted_samples = _format_samples(column_samples)

        prompt = CLASSIFICATION_PROMPT_TEMPLATE.format(
            company=campaign.company or "",
            campaign_purpose=campaign.campaign_purpose or "",
            target_audience=campaign.target_audience or "",
            column_samples=formatted_samples,
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
        # Non-fatal: fall back to empty filters so the pipeline fetches ALL contacts.
        # This is preferable to blocking the entire pipeline on an Ollama parsing failure.
        logger.error(f"[ClassificationAgent] Failed for campaign {campaign.id}: {exc} — falling back to empty filters")

        fallback = {"filters": {"role": "", "location": "", "category": "", "company": ""}}
        try:
            await db.execute(
                update(PipelineRun)
                .where(PipelineRun.id == pipeline_run.id)
                .values(
                    classification_summary=fallback,
                    state=PipelineState.CLASSIFIED,
                )
            )
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
                .values(
                    completed_at=completed_at,
                    duration_ms=duration_ms,
                    status="FAILED",
                    error_message=str(exc),
                )
            )
            await db.commit()
        except Exception as inner:
            logger.critical(f"[ClassificationAgent] Could not persist fallback: {inner}")

        return fallback
