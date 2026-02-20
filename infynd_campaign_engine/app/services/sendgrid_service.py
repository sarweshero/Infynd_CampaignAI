"""
SendGrid Service — sends emails via SendGrid API.
Validates webhook HMAC signature.
"""
import hashlib
import hmac
import base64
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

SENDGRID_API_BASE = "https://api.sendgrid.com/v3"


async def send_email(
    to_email: str,
    subject: str,
    html_body: str,
    campaign_id: str,
    message_id_prefix: str = "",
) -> Optional[str]:
    """Send an email via SendGrid and return the X-Message-Id header."""
    headers = {
        "Authorization": f"Bearer {settings.SENDGRID_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "personalizations": [
            {
                "to": [{"email": to_email}],
                "custom_args": {
                    "campaign_id": str(campaign_id),
                },
            }
        ],
        "from": {"email": settings.SENDGRID_FROM_EMAIL},
        "subject": subject,
        "content": [{"type": "text/html", "value": html_body}],
        "tracking_settings": {
            "click_tracking": {"enable": True},
            "open_tracking": {"enable": True},
        },
        "categories": [str(campaign_id)],
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{SENDGRID_API_BASE}/mail/send",
                headers=headers,
                json=payload,
            )
            if response.status_code == 202:
                msg_id = response.headers.get("X-Message-Id", "")
                logger.info(f"[SendGrid] Sent to {to_email}, msg_id={msg_id}")
                return msg_id
            else:
                logger.error(f"[SendGrid] Failed for {to_email}: {response.status_code} {response.text}")
                return None
    except Exception as exc:
        logger.error(f"[SendGrid] Exception sending to {to_email}: {exc}")
        return None


def verify_sendgrid_signature(
    payload: bytes,
    signature: str,
    timestamp: str,
) -> bool:
    """Verify SendGrid Event Webhook signature (HMAC-SHA256)."""
    if not settings.SENDGRID_WEBHOOK_SECRET:
        return True  # Bypass if not configured

    signed_payload = (timestamp + payload.decode("utf-8")).encode("utf-8")
    secret = base64.b64decode(settings.SENDGRID_WEBHOOK_SECRET)
    computed = hmac.new(secret, signed_payload, hashlib.sha256).digest()
    computed_b64 = base64.b64encode(computed).decode("utf-8")
    return hmac.compare_digest(computed_b64, signature)
