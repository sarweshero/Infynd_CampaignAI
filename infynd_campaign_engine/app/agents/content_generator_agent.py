"""
Agent 4 — Content Generator Agent
Generates personalized content per contact and channel using Ollama (STRICT JSON MODE).
Stores in campaigns.generated_content (jsonb).
Updates state to CONTENT_GENERATED.
"""

import json
import logging
from datetime import datetime
from typing import Dict, Any, List

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import update

from app.core.config import settings
from app.models.campaign import Campaign, PipelineState
from app.models.pipeline import PipelineRun, CampaignLog

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# STRICT PROMPTS (NO MARKDOWN, NO EXTRA TEXT)
# ─────────────────────────────────────────────────────────────

EMAIL_PROMPT = """
You are a B2B email copywriter.

Write a personalized cold email template for a campaign.
Use the exact placeholder tokens below — they will be replaced with real values at send time.

Placeholder tokens (use these verbatim):
- [CONTACT_NAME]     — recipient's full name
- [CONTACT_ROLE]     — recipient's job title
- [CONTACT_COMPANY]  — recipient's company
- [PRODUCT_LINK]     — product / landing page URL

Campaign:
- Purpose: {{campaign_purpose}}
- Product Link: {{product_link}}

Instructions:
{{prompt}}

Safety and tone:
- Use respectful, professional language.
- Do NOT use abusive, inappropriate, sexual, hateful, or violent language.

Return ONLY valid JSON.
Do NOT add markdown.
Do NOT add explanations.
Do NOT add text before or after JSON.

Format:
{
    "subject": "string",
    "body": "string (use [CONTACT_NAME], [CONTACT_COMPANY] placeholders in the body)",
    "cta_link": "{{product_link}}"
}
"""

LINKEDIN_PROMPT = """
You are a B2B LinkedIn messaging expert.

Write a SHORT LinkedIn message template under 300 characters.
Use the exact placeholder tokens below — they will be replaced with real values at send time.

Placeholder tokens (use these verbatim):
- [CONTACT_NAME]    — recipient's full name
- [CONTACT_ROLE]    — recipient's job title
- [PRODUCT_LINK]    — product / landing page URL

Campaign Purpose: {{campaign_purpose}}
Product Link: {{product_link}}

Instructions:
{{prompt}}

Safety and tone:
- Use respectful, professional language.
- Do NOT use abusive, inappropriate, sexual, hateful, or violent language.

Return ONLY valid JSON.

Format:
{
    "message": "string (use [CONTACT_NAME] placeholder)",
    "cta_link": "{{product_link}}"
}
"""

CALL_PROMPT = """
You are a B2B sales call script writer.

Write a concise call script template for a sales agent.
Use the exact placeholder tokens below — they will be replaced with real values at call time.

Placeholder tokens (use these verbatim):
- [CONTACT_NAME]    — recipient's full name
- [CONTACT_ROLE]    — recipient's job title
- [CONTACT_COMPANY] — recipient's company
- [PRODUCT_LINK]    — product / landing page URL

Campaign Purpose: {{campaign_purpose}}
Product Link: {{product_link}}

Instructions:
{{prompt}}

Safety and tone:
- Use respectful, professional language.
- Do NOT use abusive, inappropriate, sexual, hateful, or violent language.

Return ONLY valid JSON.

Format:
{
    "greeting": "string (use [CONTACT_NAME] placeholder)",
    "value_proposition": "string",
    "objection_handling": "string",
    "closing": "string (use [PRODUCT_LINK] placeholder)",
    "cta_link": "{{product_link}}"
}
"""

PROMPT_MAP = {
    "Email": EMAIL_PROMPT,
    "LinkedIn": LINKEDIN_PROMPT,
    "Call": CALL_PROMPT,
}


# ─────────────────────────────────────────────────────────────
# PERSONALIZATION HINT (used by WS regenerate)
# ─────────────────────────────────────────────────────────────

def _personalization_hint(contact: dict) -> str:
    """Build a short context string from contact data for regeneration prompts."""
    parts = []
    if contact.get("name"):
        parts.append(f"Recipient: {contact['name']}")
    if contact.get("role"):
        parts.append(f"Role: {contact['role']}")
    if contact.get("company"):
        parts.append(f"Company: {contact['company']}")
    if contact.get("emailclickrate") is not None:
        parts.append(f"Email engagement: {contact['emailclickrate']}")
    if contact.get("linkedinclickrate") is not None:
        parts.append(f"LinkedIn engagement: {contact['linkedinclickrate']}")
    if contact.get("callanswerrate") is not None:
        parts.append(f"Call answer rate: {contact['callanswerrate']}")
    return "; ".join(parts) if parts else "No specific contact data available"


# ─────────────────────────────────────────────────────────────
# OLLAMA STRICT JSON CALL
# ─────────────────────────────────────────────────────────────

async def _call_ollama(prompt: str) -> Dict[str, Any]:
    """
    Calls Ollama using the user's API endpoint from settings.
    No cleaning. No repairing. Fails if invalid JSON.
    """
    logger.info(f"[ContentGeneratorAgent] Calling Ollama API: {settings.OLLAMA_URL}")
    async with httpx.AsyncClient(timeout=settings.OLLAMA_TIMEOUT) as client:
        response = await client.post(
            settings.OLLAMA_URL,
            json={
                "model": settings.OLLAMA_MODEL,
                "prompt": prompt,
                "format": "json",  # STRICT JSON MODE
                "stream": False,
            },
        )
        response.raise_for_status()
        data = response.json()
        logger.debug(f"[ContentGeneratorAgent] Ollama API response: {data}")
        if "response" not in data:
            raise ValueError("Invalid Ollama response format")
        raw = data["response"]
    logger.debug(f"[ContentGeneratorAgent] Raw JSON from Ollama: {raw}")
    return json.loads(raw)


# ─────────────────────────────────────────────────────────────
# MAIN AGENT EXECUTION
# ─────────────────────────────────────────────────────────────

async def run_content_generator_agent(
    db: AsyncSession,
    campaign: Campaign,
    pipeline_run: PipelineRun,
) -> Dict[str, Any]:

    started_at = datetime.utcnow()

    log = CampaignLog(
        campaign_id=campaign.id,
        agent_name="ContentGeneratorAgent",
        started_at=started_at,
        status="RUNNING",
    )
    db.add(log)
    await db.flush()

    try:
        downstream = pipeline_run.downstream_results or {}
        contacts: List[Dict[str, Any]] = downstream.get("contacts", [])
        channel_map: Dict[str, str] = downstream.get("channel_map", {})

        # ── Always generate all 3 channel templates ─────────────────────
        # Even if no contacts are currently assigned to a channel, the user
        # should see all templates and can reassign contacts during approval.
        channels_needed: set = {"Email", "LinkedIn", "Call"}

        # ── Step 1: Generate ONE common template per channel ─────────────
        # Templates use [CONTACT_NAME], [CONTACT_COMPANY] etc. as placeholders.
        # Real values are substituted at dispatch time per contact.
        common_templates: Dict[str, Any] = {}

        for channel in channels_needed:
            base_prompt = PROMPT_MAP.get(channel)
            if not base_prompt:
                logger.warning(f"[ContentGeneratorAgent] No prompt for channel: {channel}")
                continue

            prompt = (
                base_prompt
                .replace("{{campaign_purpose}}", campaign.campaign_purpose or "")
                .replace("{{product_link}}", campaign.product_link or "")
                .replace("{{prompt}}", campaign.prompt or "")
            )

            logger.info(f"[ContentGeneratorAgent] Generating common template for channel: {channel}")
            common_templates[channel] = await _call_ollama(prompt)

        # ── Step 2: Build contacts map (email → channel) ─────────────────
        contacts_map: Dict[str, str] = {
            contact["email"]: channel_map.get(contact["email"], "Email")
            for contact in contacts
            if contact.get("email")
        }

        generated_content = {
            "common": common_templates,
            "contacts": contacts_map,
        }

        # ── Step 3: Persist ───────────────────────────────────────────────
        await db.execute(
            update(Campaign)
            .where(Campaign.id == campaign.id)
            .values(
                generated_content=generated_content,
                pipeline_state=PipelineState.CONTENT_GENERATED,
            )
        )

        await db.execute(
            update(PipelineRun)
            .where(PipelineRun.id == pipeline_run.id)
            .values(state=PipelineState.CONTENT_GENERATED)
        )

        completed_at = datetime.utcnow()
        duration_ms = int((completed_at - started_at).total_seconds() * 1000)

        await db.execute(
            update(CampaignLog)
            .where(CampaignLog.id == log.id)
            .values(
                completed_at=completed_at,
                duration_ms=duration_ms,
                status="SUCCESS",
            )
        )

        await db.commit()

        logger.info(
            f"[ContentGeneratorAgent] Campaign {campaign.id}: "
            f"{len(common_templates)} channel templates, {len(contacts_map)} contacts"
        )

        return generated_content

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

        logger.error(
            f"[ContentGeneratorAgent] Failed for campaign {campaign.id}: {exc}"
        )

        raise