"""
Agent 0 — Prompt Parser Agent
Uses Ollama to extract structured campaign metadata from a single free-text prompt.
Fills in: name, company, platform, campaign_purpose, target_audience.
This runs as the FIRST step in the pipeline so all downstream agents have rich context.
"""
import json
import logging
from datetime import datetime

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import update

from app.core.config import settings
from app.models.campaign import Campaign
from app.models.pipeline import CampaignLog

logger = logging.getLogger(__name__)

PARSE_PROMPT_TEMPLATE = """You are a B2B campaign data extractor. Read the user's campaign prompt carefully and extract structured information.

User Prompt:
"{user_prompt}"

Extract and return a JSON object ONLY (absolutely no extra text, no markdown, no explanation) with exactly these keys:
{{
  "name": "<short campaign name, 3-8 words, title-case, describing the campaign>",
  "company": "<company or brand being promoted — infer from context if not explicit>",
  "platform": "<best outreach channel based on context: email | linkedin | phone | sms>",
  "campaign_purpose": "<1-2 sentence clear statement of what the campaign aims to achieve>",
  "target_audience": "<description of ideal targets: job roles, seniority, industry vertical, location if mentioned>"
}}

Rules:
- Return ONLY valid JSON, no other text.
- If a field is not explicitly mentioned, make a smart inference from the context.
- platform must be exactly one of: email, linkedin, phone, sms
- name must be concise and descriptive (e.g. "Enterprise CTO Cold Outreach Q2")
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


async def run_prompt_parser_agent(
    db: AsyncSession,
    campaign: Campaign,
) -> None:
    """
    Extract structured campaign fields from campaign.prompt and patch the campaign row.
    Non-fatal: if Ollama fails, the pipeline continues with whatever fields already exist.
    Respects user-supplied values — only fills in fields that are blank.
    """
    if not campaign.prompt:
        logger.info(f"[PromptParser] No prompt supplied for campaign {campaign.id} — skipping")
        return

    started_at = datetime.utcnow()
    log = CampaignLog(
        campaign_id=campaign.id,
        agent_name="PromptParserAgent",
        started_at=started_at,
        status="RUNNING",
    )
    db.add(log)
    await db.flush()

    try:
        llm_prompt = PARSE_PROMPT_TEMPLATE.format(user_prompt=campaign.prompt.replace('"', "'"))
        raw = await _call_ollama(llm_prompt)
        logger.debug(f"[PromptParser] Raw LLM response: {raw[:300]}")

        # Robustly extract JSON block from response
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        if start == -1:
            raise ValueError("No JSON block found in LLM response")

        parsed: dict = json.loads(raw[start:end])

        updates: dict = {}

        # Always update name (it was set to a placeholder or truncated prompt)
        if parsed.get("name"):
            updates["name"] = str(parsed["name"]).strip()[:255]

        # Only fill in fields the user left blank
        if parsed.get("company") and not campaign.company:
            updates["company"] = str(parsed["company"]).strip()[:255]

        valid_platforms = {"email", "linkedin", "phone", "sms"}
        if parsed.get("platform") and not campaign.platform:
            pf = str(parsed["platform"]).strip().lower()
            updates["platform"] = pf if pf in valid_platforms else "email"

        if parsed.get("campaign_purpose") and not campaign.campaign_purpose:
            updates["campaign_purpose"] = str(parsed["campaign_purpose"]).strip()

        if parsed.get("target_audience") and not campaign.target_audience:
            updates["target_audience"] = str(parsed["target_audience"]).strip()

        if updates:
            await db.execute(
                update(Campaign)
                .where(Campaign.id == campaign.id)
                .values(**updates)
            )
            await db.commit()
            logger.info(f"[PromptParser] Campaign {campaign.id} enriched: {list(updates.keys())}")

        completed_at = datetime.utcnow()
        log.status = "SUCCESS"
        log.completed_at = completed_at
        log.duration_ms = int((completed_at - started_at).total_seconds() * 1000)
        log.metadata_ = {"extracted_fields": list(updates.keys()), "parsed": parsed}
        await db.commit()

    except Exception as exc:
        logger.error(f"[PromptParser] Failed for campaign {campaign.id}: {exc}", exc_info=True)
        # Non-fatal — mark log but let pipeline continue
        completed_at = datetime.utcnow()
        log.status = "FAILED"
        log.error_message = str(exc)
        log.completed_at = completed_at
        log.duration_ms = int((completed_at - started_at).total_seconds() * 1000)
        await db.commit()
