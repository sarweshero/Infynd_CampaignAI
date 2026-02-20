"""
Agent 4 — Content Generator Agent
Generates personalized content per contact and channel using Ollama.
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

# Ensure all logs are output to the console at DEBUG level
root_logger = logging.getLogger()
if not root_logger.hasHandlers():
    handler = logging.StreamHandler()
    formatter = logging.Formatter('[%(asctime)s] %(levelname)s %(name)s: %(message)s')
    handler.setFormatter(formatter)
    root_logger.addHandler(handler)
root_logger.setLevel(logging.DEBUG)


# Common template with placeholders for all contacts
EMAIL_PROMPT = """
You are a B2B email copywriter.
Write a personalized cold email for a contact.

Contact:
- Name: {{name}}
- Role: {{role}}
- Company: {{company}}
- Email Click Rate: {{emailclickrate}}
- Preferred Contact Time: {{preferredtime}}

Campaign:
- Purpose: {{campaign_purpose}}
- Product Link: {{product_link}}

User Instructions:
{{prompt}}

{{personalization_hint}}

Return a JSON object ONLY in this format:
{{
    "subject": "<email subject line>",
    "body": "<full email body with greeting, value prop, CTA>",
    "cta_link": "{{product_link}}"
}}
"""

LINKEDIN_PROMPT = """
You are a B2B LinkedIn messaging expert.
Write a SHORT personalized LinkedIn message (under 300 characters).

Contact:
- Name: {{name}}
- Role: {{role}}
- Company: {{company}}

Campaign Purpose: {{campaign_purpose}}
Product Link: {{product_link}}

User Instructions:
{{prompt}}

{{personalization_hint}}

Return a JSON object ONLY:
{{
    "message": "<LinkedIn message under 300 chars>",
    "cta_link": "{{product_link}}"
}}
"""

CALL_PROMPT = """
You are a B2B sales call script writer.
Write a concise call conversation outline for a sales representative.

Contact:
- Name: {{name}}
- Role: {{role}}
- Company: {{company}}
- Call Answer Rate: {{callanswerrate}}
- Preferred Contact Time: {{preferredtime}}

Campaign Purpose: {{campaign_purpose}}
Product Link: {{product_link}}

User Instructions:
{{prompt}}

{{personalization_hint}}

Return a JSON object ONLY:
{{
    "greeting": "<opening line>",
    "value_proposition": "<1-2 sentences>",
    "objection_handling": "<brief>",
    "closing": "<CTA with link>",
    "cta_link": "{{product_link}}"
}}
"""

PROMPT_MAP = {
    "Email": EMAIL_PROMPT,
    "LinkedIn": LINKEDIN_PROMPT,
    "Call": CALL_PROMPT,
}


def _personalization_hint(contact: Dict[str, Any]) -> str:
    hints = []
    email_rate = contact.get("emailclickrate")
    call_rate = contact.get("callanswerrate")

    try:
        if email_rate is not None and float(email_rate) > 0.5:
            hints.append("Since you've previously explored similar solutions, use a strong direct CTA.")
    except (ValueError, TypeError):
        pass

    try:
        if call_rate is not None and float(call_rate) < 0.2:
            hints.append("I know you're busy, so this will be quick - keep tone brief and punchy.")
    except (ValueError, TypeError):
        pass

    return " ".join(hints) if hints else ""


async def _call_ollama(prompt: str) -> Dict[str, Any]:
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
        raw = response.json()["response"]

    logger.debug(f"[ContentGeneratorAgent] Raw Ollama response: {raw}")
    json_start = raw.find("{")
    json_end = raw.rfind("}") + 1
    if json_start == -1:
        raise ValueError(f"Ollama returned no JSON block: {raw[:200]}")
    json_str = raw[json_start:json_end]
    # Remove ASCII control characters except for tab (\t), newline (\n), and carriage return (\r)
    import re
    json_str = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', json_str)
    try:
        return json.loads(json_str)
    except json.JSONDecodeError as e:
        logger.error(f"[ContentGeneratorAgent] JSON decode error: {e}\nRaw: {json_str}\nFull Ollama: {raw}")
        raise


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

        generated_content: Dict[str, Any] = {}
        common_templates: Dict[str, Any] = {}

        # ── Step 1: Generate one common template per channel ──────────────
        # The AI generates content with {name}, {role}, etc. still as placeholders.
        COMMON_PROMPT_MAP = {
            "Email": EMAIL_PROMPT
                .replace("{{name}}", "[CONTACT_NAME]")
                .replace("{{role}}", "[CONTACT_ROLE]")
                .replace("{{company}}", "[CONTACT_COMPANY]")
                .replace("{{emailclickrate}}", "[EMAIL_CLICK_RATE]")
                .replace("{{linkedinclickrate}}", "[LINKEDIN_CLICK_RATE]")
                .replace("{{callanswerrate}}", "[CALL_ANSWER_RATE]")
                .replace("{{preferredtime}}", "[PREFERRED_TIME]")
                .replace("{{campaign_purpose}}", campaign.campaign_purpose or "")
                .replace("{{product_link}}", campaign.product_link or "")
                .replace("{{prompt}}", campaign.prompt or "")
                .replace("{{personalization_hint}}", ""),
            "LinkedIn": LINKEDIN_PROMPT
                .replace("{{name}}", "[CONTACT_NAME]")
                .replace("{{role}}", "[CONTACT_ROLE]")
                .replace("{{company}}", "[CONTACT_COMPANY]")
                .replace("{{campaign_purpose}}", campaign.campaign_purpose or "")
                .replace("{{product_link}}", campaign.product_link or "")
                .replace("{{prompt}}", campaign.prompt or "")
                .replace("{{personalization_hint}}", ""),
            "Call": CALL_PROMPT
                .replace("{{name}}", "[CONTACT_NAME]")
                .replace("{{role}}", "[CONTACT_ROLE]")
                .replace("{{company}}", "[CONTACT_COMPANY]")
                .replace("{{callanswerrate}}", "[CALL_ANSWER_RATE]")
                .replace("{{preferredtime}}", "[PREFERRED_TIME]")
                .replace("{{campaign_purpose}}", campaign.campaign_purpose or "")
                .replace("{{product_link}}", campaign.product_link or "")
                .replace("{{prompt}}", campaign.prompt or "")
                .replace("{{personalization_hint}}", ""),
        }

        for channel, prompt in COMMON_PROMPT_MAP.items():
            logger.info(f"[ContentGeneratorAgent] Generating common template for channel: {channel}")
            common_templates[channel] = await _call_ollama(prompt)

        # ── Step 2: Personalize common template for each contact ──────────
        for contact in contacts:
            email = contact.get("email")
            if not email:
                continue

            channel = channel_map.get(email, "Email")
            template_content = common_templates.get(channel)
            if not template_content:
                continue

            hint = _personalization_hint(contact)
            # Deep-copy template content and substitute placeholders
            personalized: Dict[str, Any] = json.loads(json.dumps(template_content))
            substitutions = {
                "[CONTACT_NAME]":       contact.get("name", ""),
                "[CONTACT_ROLE]":       contact.get("role", ""),
                "[CONTACT_COMPANY]":    contact.get("company", ""),
                "[EMAIL_CLICK_RATE]":   str(contact.get("emailclickrate", "N/A")),
                "[LINKEDIN_CLICK_RATE]":str(contact.get("linkedinclickrate", "N/A")),
                "[CALL_ANSWER_RATE]":   str(contact.get("callanswerrate", "N/A")),
                "[PREFERRED_TIME]":     str(contact.get("preferredtime", "N/A")),
            }
            for k, v in personalized.items():
                if isinstance(v, str):
                    for placeholder, value in substitutions.items():
                        v = v.replace(placeholder, value)
                    personalized[k] = v

            generated_content[email] = {
                "channel": channel,
                "content": personalized,
            }

        # ── Step 3: Persist both common templates and personalized content ─
        await db.execute(
            update(Campaign)
            .where(Campaign.id == campaign.id)
            .values(
                generated_content={
                    "common": common_templates,
                    "personalized": generated_content,
                },
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
            .values(completed_at=completed_at, duration_ms=duration_ms, status="SUCCESS")
        )
        await db.commit()

        logger.info(
            f"[ContentGeneratorAgent] Campaign {campaign.id}: "
            f"{len(common_templates)} common templates, {len(generated_content)} personalized records"
        )
        return {"common": common_templates, "personalized": generated_content}

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
        logger.error(f"[ContentGeneratorAgent] Failed for campaign {campaign.id}: {exc}")
        raise
