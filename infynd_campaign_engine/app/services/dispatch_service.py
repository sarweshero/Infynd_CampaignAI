"""
Dispatch Service — sends the COMMON template to every contact, substituting
per-contact placeholders (name, role, company, etc.) at send time.

Strategy:
  1. Extract contact emails from generated_content["contacts"] (email → channel map).
  2. For each email, determine the channel assigned to that contact.
  3. Fetch the Contact row from the DB for placeholder substitution.
  4. Take the common template for the channel, substitute all [PLACEHOLDER] tokens.
  5. Email  → send via SendGrid.
     Call   → initiate Twilio outbound call with voice agent.
     LinkedIn → log (no API integration yet).
"""
import json
import logging
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from app.models.campaign import Campaign, PipelineState
from app.models.contact import Contact
from app.models.pipeline import PipelineRun
from app.models.tracking import EngagementHistory, OutboundMessage
from app.services.sendgrid_service import send_email
from app.services.voice_agent import initiate_call

logger = logging.getLogger(__name__)


def _substitute(template: Any, contact: "Contact | None", campaign: Campaign) -> Any:
    """
    Deep-copy *template* (dict or str) and replace every [PLACEHOLDER] token.
    Supports any bracket token, including multi-word ones like [Your Name].
    Returns the same type as the input.
    """
    if isinstance(template, dict):
        return {k: _substitute(v, contact, campaign) for k, v in template.items()}

    if not isinstance(template, str):
        return template

    def _replace(match: re.Match) -> str:
        key = match.group(1).strip()
        k = key.lower().replace(" ", "_")  # normalise: "Your Name" → "your_name"

        # Contact fields
        if contact:
            if k in ("contact_name", "name"):          return contact.name or ""
            if k in ("contact_role", "role"):          return contact.role or ""
            if k in ("contact_company", "company"):    return contact.company or ""
            if k == "email":                           return contact.email or ""
            if k == "preferred_time":                  return str(contact.preferredtime or "")
            if k == "email_click_rate":                return str(contact.emailclickrate or "")
            if k == "linkedin_click_rate":             return str(contact.linkedinclickrate or "")
            if k == "call_answer_rate":                return str(contact.callanswerrate or "")

        # Campaign / sender fields
        if k in ("product_link", "cta_link"):          return campaign.product_link or ""
        if k in ("your_name", "sender", "from_name"):  return "Xyndrix Team"
        if k == "campaign_name":                       return campaign.name or ""
        if k == "company":                             return campaign.company or ""

        # Unresolved — leave as-is so nothing is silently dropped
        return match.group(0)

    return re.sub(r"\[([^\]]+)\]", _replace, template)


async def dispatch_campaign(db: AsyncSession, campaign_id: str) -> None:
    """Send the common email/LinkedIn/call template to every approved contact."""

    campaign_uuid = uuid.UUID(campaign_id)

    # Fetch campaign
    result = await db.execute(select(Campaign).where(Campaign.id == campaign_uuid))
    campaign = result.scalar_one_or_none()
    if not campaign:
        logger.error(f"[Dispatch] Campaign {campaign_id} not found")
        return
    if campaign.pipeline_state not in (PipelineState.APPROVED,):
        logger.warning(f"[Dispatch] Campaign {campaign_id} not in APPROVED state: {campaign.pipeline_state}")
        return

    generated: Dict[str, Any] = campaign.generated_content or {}

    # Common templates — keyed by channel name
    common_templates: Dict[str, Any] = generated.get("common") or {}

    # contacts map: { "email@domain.com": "Email" | "Call" | "LinkedIn" }
    contacts_map: Dict[str, str] = generated.get("contacts") or {}
    contact_emails = [
        email for email in contacts_map
        if isinstance(email, str) and "@" in email
    ]

    if not contact_emails:
        logger.warning(f"[Dispatch] Campaign {campaign_id} has no contacts")
        return

    if not common_templates:
        logger.error(f"[Dispatch] Campaign {campaign_id} has no common templates")
        return

    logger.info(f"[Dispatch] Campaign {campaign_id}: dispatching to {len(contact_emails)} contacts")
    dispatched_count = 0

    for contact_email in contact_emails:
        channel = contacts_map.get(contact_email, "Email")

        # Idempotency guard
        existing = await db.execute(
            select(OutboundMessage).where(
                OutboundMessage.campaign_id == campaign_uuid,
                OutboundMessage.contact_email == contact_email,
                OutboundMessage.channel == channel,
                OutboundMessage.send_status == "SENT",
            )
        )
        if existing.scalar_one_or_none():
            logger.info(f"[Dispatch] Already sent to {contact_email} — skipping")
            continue

        # Fetch contact record for placeholder substitution
        contact: "Contact | None" = None
        try:
            cr = await db.execute(select(Contact).where(Contact.email == contact_email))
            contact = cr.scalar_one_or_none()
        except Exception as exc:
            logger.warning(f"[Dispatch] Could not fetch contact {contact_email}: {exc}")

        # ── EMAIL ─────────────────────────────────────────────────────────
        if channel == "Email":
            template = common_templates.get("Email") or {}
            if not template:
                logger.warning(f"[Dispatch] No Email template for {contact_email}")
                continue

            import json as _json
            content = _substitute(_json.loads(_json.dumps(template)), contact, campaign)

            subject = content.get("subject", f"Message from {campaign.name}")
            body    = content.get("body", "")
            cta     = content.get("cta_link", campaign.product_link or "")
            html_body = (
                f"<p>{body.replace(chr(10), '</p><p>')}</p>"
                + (f'<br><p><a href="{cta}">{cta}</a></p>' if cta else "")
            )

            provider_message_id = None
            send_status = "FAILED"
            logger.info(f"[Dispatch] Sending Email → {contact_email}  subject={subject!r}")
            try:
                provider_message_id = await send_email(
                    to_email=contact_email,
                    subject=subject,
                    html_body=html_body,
                    campaign_id=str(campaign_uuid),
                )
                send_status = "SENT" if provider_message_id else "FAILED"
                if provider_message_id:
                    logger.info(f"[Dispatch] ✓ Email sent to {contact_email}")
                else:
                    logger.error(f"[Dispatch] ✗ Email FAILED for {contact_email}")
            except Exception as exc:
                logger.error(f"[Dispatch] Exception sending email to {contact_email}: {exc}")

            db.add(OutboundMessage(
                campaign_id=campaign_uuid,
                contact_email=contact_email,
                channel=channel,
                message_payload=json.dumps(content),
                send_status=send_status,
                provider_message_id=provider_message_id,
                sent_at=datetime.utcnow() if send_status == "SENT" else None,
            ))
            db.add(EngagementHistory(
                campaign_id=campaign_uuid,
                contact_email=contact_email,
                channel=channel,
                event_type="SENT",
                payload=content,
                occurred_at=datetime.utcnow(),
            ))
            dispatched_count += 1

        # ── CALL (Twilio voice agent) ──────────────────────────────────────
        elif channel == "Call":
            template = common_templates.get("Call") or {}
            if not template:
                logger.warning(f"[Dispatch] No Call template for {contact_email}")
                continue

            if not contact:
                logger.warning(f"[Dispatch] No contact record for {contact_email} — cannot call")
                continue

            phone = (
                getattr(contact, "phone_number", None)
                or getattr(contact, "phoneno", None)
                or getattr(contact, "phone", None)
                or ""
            )
            phone = str(phone).strip().replace(" ", "")
            if not phone:
                logger.warning(f"[Dispatch] No phone number for {contact_email} — skipping call")
                continue
            if not phone.startswith("+"):
                phone = "+91" + phone

            # Build campaign context from the call template
            call_script = " | ".join(
                f"{k}: {v}" for k, v in template.items() if isinstance(v, str) and k != "cta_link"
            )
            contact_dict = {
                "name":    getattr(contact, "name", ""),
                "email":   contact_email,
                "company": getattr(contact, "company", ""),
                "role":    getattr(contact, "role", ""),
            }
            try:
                call_result = await initiate_call(
                    to_number=phone,
                    contact=contact_dict,
                    campaign_context=call_script,
                    campaign_id=str(campaign_uuid),
                )
                logger.info(f"[Dispatch] ✓ Call initiated for {contact_email}: {call_result}")
                send_status = "SENT"
                provider_message_id = call_result.get("call_sid")
            except Exception as exc:
                logger.error(f"[Dispatch] ✗ Call FAILED for {contact_email}: {exc}")
                send_status = "FAILED"
                provider_message_id = None

            db.add(OutboundMessage(
                campaign_id=campaign_uuid,
                contact_email=contact_email,
                channel=channel,
                message_payload=json.dumps(template),
                send_status=send_status,
                provider_message_id=provider_message_id,
                sent_at=datetime.utcnow() if send_status == "SENT" else None,
            ))
            db.add(EngagementHistory(
                campaign_id=campaign_uuid,
                contact_email=contact_email,
                channel=channel,
                event_type="SENT",
                payload=template,
                occurred_at=datetime.utcnow(),
            ))
            dispatched_count += 1

        # ── LINKEDIN ───────────────────────────────────────────────────────
        elif channel == "LinkedIn":
            template = common_templates.get("LinkedIn") or {}
            if not template:
                logger.warning(f"[Dispatch] No LinkedIn template for {contact_email}")
                continue

            import json as _json
            content = _substitute(_json.loads(_json.dumps(template)), contact, campaign)
            logger.info(f"[Dispatch] LinkedIn message prepared for {contact_email} (no API — logged only)")

            db.add(OutboundMessage(
                campaign_id=campaign_uuid,
                contact_email=contact_email,
                channel=channel,
                message_payload=json.dumps(content),
                send_status="SENT",
                provider_message_id=None,
                sent_at=datetime.utcnow(),
            ))
            db.add(EngagementHistory(
                campaign_id=campaign_uuid,
                contact_email=contact_email,
                channel=channel,
                event_type="SENT",
                payload=content,
                occurred_at=datetime.utcnow(),
            ))
            dispatched_count += 1

        else:
            logger.warning(f"[Dispatch] Unknown channel {channel!r} for {contact_email} — skipping")

    # Commit all rows
    await db.execute(
        update(Campaign).where(Campaign.id == campaign_uuid)
        .values(pipeline_state=PipelineState.DISPATCHED)
    )
    await db.commit()

    await db.execute(
        update(Campaign).where(Campaign.id == campaign_uuid)
        .values(pipeline_state=PipelineState.COMPLETED)
    )
    await db.execute(
        update(PipelineRun).where(PipelineRun.campaign_id == campaign_uuid)
        .values(state=PipelineState.COMPLETED, completed_at=datetime.utcnow())
    )
    await db.commit()

    logger.info(
        f"[Dispatch] Campaign {campaign_id}: "
        f"{dispatched_count}/{len(contact_emails)} messages dispatched → COMPLETED"
    )
