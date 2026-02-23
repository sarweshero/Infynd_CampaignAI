"""
SendGrid Service — sends emails via SendGrid API.
Validates webhook ECDSA signature (Event Webhook v3).
Includes automatic retry logic with exponential backoff.
"""
import asyncio
import hashlib
import base64
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

SENDGRID_API_BASE = "https://api.sendgrid.com/v3"
SENDGRID_MAX_RETRIES = 2
SENDGRID_TIMEOUT = 30


async def send_email(
    to_email: str,
    subject: str,
    html_body: str,
    campaign_id: str,
    plain_text: str = "",
    message_id_prefix: str = "",
) -> Optional[str]:
    """Send an email via SendGrid with retry logic and return the X-Message-Id header."""
    headers = {
        "Authorization": f"Bearer {settings.SENDGRID_API_KEY}",
        "Content-Type": "application/json",
    }

    reply_to_email = settings.SENDGRID_REPLY_TO_EMAIL or settings.SENDGRID_FROM_EMAIL

    # Build content blocks — always include plain-text to avoid spam flags
    content_blocks = []
    if plain_text:
        content_blocks.append({"type": "text/plain", "value": plain_text})
    content_blocks.append({"type": "text/html", "value": html_body})

    payload = {
        "personalizations": [
            {
                "to": [{"email": to_email}],
                "custom_args": {
                    "campaign_id": str(campaign_id),
                },
            }
        ],
        "from": {
            "email": settings.SENDGRID_FROM_EMAIL,
            "name": settings.SENDGRID_FROM_NAME,
        },
        "reply_to": {
            "email": reply_to_email,
            "name": settings.SENDGRID_FROM_NAME,
        },
        "subject": subject,
        "content": content_blocks,
        "headers": {
            # List-Unsubscribe makes Gmail route to Promotions instead of Spam
            "List-Unsubscribe": f"<mailto:{reply_to_email}?subject=Unsubscribe>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            "X-Entity-Ref-ID": str(campaign_id),
        },
        "tracking_settings": {
            "click_tracking": {"enable": True},
            "open_tracking": {"enable": True},
        },
        "mail_settings": {
            "bypass_spam_management": {"enable": False},
        },
        "categories": [str(campaign_id)],
    }

    for attempt in range(SENDGRID_MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=SENDGRID_TIMEOUT) as client:
                response = await client.post(
                    f"{SENDGRID_API_BASE}/mail/send",
                    headers=headers,
                    json=payload,
                )
                if response.status_code == 202:
                    msg_id = response.headers.get("X-Message-Id", "")
                    logger.info(f"[SendGrid] Sent to {to_email}, msg_id={msg_id}")
                    return msg_id
                elif response.status_code >= 500:
                    # Retryable server error
                    logger.warning(f"[SendGrid] Server error (attempt {attempt + 1}/{SENDGRID_MAX_RETRIES}): {response.status_code}")
                    if attempt < SENDGRID_MAX_RETRIES - 1:
                        await asyncio.sleep(0.5 * (attempt + 1))  # Exponential backoff
                        continue
                else:
                    # Client error — don't retry
                    logger.error(f"[SendGrid] Failed for {to_email}: {response.status_code} {response.text}")
                    return None
        except asyncio.TimeoutError:
            logger.warning(f"[SendGrid] Timeout (attempt {attempt + 1}/{SENDGRID_MAX_RETRIES}) to {to_email}")
            if attempt < SENDGRID_MAX_RETRIES - 1:
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
        except Exception as exc:
            logger.warning(f"[SendGrid] Exception (attempt {attempt + 1}/{SENDGRID_MAX_RETRIES}) to {to_email}: {exc}")
            if attempt < SENDGRID_MAX_RETRIES - 1:
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
    
    logger.error(f"[SendGrid] Failed to send to {to_email} after {SENDGRID_MAX_RETRIES} attempts")
    return None


def verify_sendgrid_signature(
    payload: bytes,
    signature: str,
    timestamp: str,
) -> bool:
    """
    Verify SendGrid Event Webhook v3 ECDSA signature.
    The SENDGRID_WEBHOOK_SECRET is a PEM-encoded ECDSA public key (base64).
    """
    if not settings.SENDGRID_WEBHOOK_SECRET:
        return True  # Bypass if not configured

    try:
        from cryptography.hazmat.primitives.asymmetric.ec import ECDSA
        from cryptography.hazmat.primitives.hashes import SHA256
        from cryptography.hazmat.primitives.serialization import load_der_public_key

        # The signed content is timestamp + payload
        signed_payload = timestamp.encode("utf-8") + payload

        # Decode the DER public key from base64
        public_key_der = base64.b64decode(settings.SENDGRID_WEBHOOK_SECRET)
        public_key = load_der_public_key(public_key_der)

        # Decode the signature from base64
        sig_bytes = base64.b64decode(signature)

        # Verify
        public_key.verify(sig_bytes, signed_payload, ECDSA(SHA256()))
        return True
    except ImportError:
        logger.warning("[SendGrid] cryptography package not installed — skipping signature verification")
        return True
    except Exception as exc:
        logger.warning(f"[SendGrid] Signature verification failed: {exc}")
        return False
