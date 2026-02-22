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
from app.core.config import settings

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
            sender_name = settings.SENDGRID_FROM_NAME if hasattr(settings, "SENDGRID_FROM_NAME") else "InFynd Team"
            reply_email = getattr(settings, "SENDGRID_REPLY_TO_EMAIL", None) or settings.SENDGRID_FROM_EMAIL

            # ── Plain-text version (spam filters reward multipart/alternative) ──
            plain_paragraphs = body.strip().replace("\r\n", "\n").split("\n\n")
            plain_text = "\n\n".join(p.strip() for p in plain_paragraphs if p.strip())
            if cta:
                plain_text += f"\n\n{cta}\n"
            plain_text += f"\n\n---\nTo stop receiving these emails, reply with 'Unsubscribe' to {reply_email}"

            # ── Styled HTML email (proper DOCTYPE + structure avoids spam) ──
            body_html = "".join(
                f"<p style='margin:0 0 14px 0;'>{p.strip()}</p>"
                for p in body.strip().replace("\r\n", "\n").split("\n\n")
                if p.strip()
            )
            cta_block = (
                f"""<table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='margin:24px 0;'>
                  <tr><td align='center'>
                    <a href='{cta}' target='_blank'
                       style='display:inline-block;background:#2563eb;color:#ffffff;font-family:Arial,sans-serif;
                              font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;
                              border-radius:6px;'>
                      Learn More →
                    </a>
                  </td></tr>
                </table>"""
                if cta else ""
            )
            html_body = f"""<!DOCTYPE html>
<html lang='en'>
<head>
  <meta charset='UTF-8' />
  <meta name='viewport' content='width=device-width,initial-scale=1.0' />
  <meta http-equiv='X-UA-Compatible' content='IE=edge' />
  <title>{subject}</title>
</head>
<body style='margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;'>
  <!-- preheader hidden preview text -->
  <div style='display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#f4f4f5;line-height:1px;'>
    {body[:90].replace(chr(10),' ')}&#847;&zwnj;&nbsp;
  </div>
  <table role='presentation' width='100%' cellpadding='0' cellspacing='0' bgcolor='#f4f4f5'>
    <tr><td align='center' style='padding:32px 16px;'>
      <table role='presentation' width='600' cellpadding='0' cellspacing='0'
             style='max-width:600px;width:100%;background:#ffffff;border-radius:10px;
                    box-shadow:0 2px 8px rgba(0,0,0,0.07);overflow:hidden;'>
        <!-- Header -->
        <tr>
          <td style='background:#2563eb;padding:24px 32px;'>
            <span style='font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;'>
              {sender_name}
            </span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style='padding:32px;color:#374151;font-size:15px;line-height:1.7;'>
            {body_html}
            {cta_block}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style='background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 32px;
                     text-align:center;color:#9ca3af;font-size:12px;line-height:1.6;'>
            <p style='margin:0 0 6px 0;'>
              You received this email because you match our target audience criteria.<br />
              <a href='mailto:{reply_email}?subject=Unsubscribe'
                 style='color:#6b7280;text-decoration:underline;'>Unsubscribe</a>
              &nbsp;·&nbsp;
              <a href='mailto:{reply_email}'
                 style='color:#6b7280;text-decoration:underline;'>Reply</a>
            </p>
            <p style='margin:0;'>{sender_name}</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""

            provider_message_id = None
            send_status = "FAILED"
            logger.info(f"[Dispatch] Sending Email → {contact_email}  subject={subject!r}")
            try:
                provider_message_id = await send_email(
                    to_email=contact_email,
                    subject=subject,
                    html_body=html_body,
                    plain_text=plain_text,
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
