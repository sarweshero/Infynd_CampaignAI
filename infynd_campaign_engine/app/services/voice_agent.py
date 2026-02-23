"""
Voice Agent Service
===================
Manages AI-powered outbound voice calls via Twilio + Ollama LLM.

Flow:
  1. POST /api/v1/campaigns/{id}/call-contacts  → initiates calls one-by-one.
  2. Twilio dials the contact, hits webhook  /api/v1/voice/answer  which delivers
     the opening pitch (TTS) and a <Gather input="speech"> element.
  3. When the contact speaks, Twilio POSTs the transcription to
     /api/v1/voice/gather.  We send the transcript + conversation history to the
     LLM, generate a reply, and return new TwiML.
  4. After MAX_TURNS exchanges, the agent says goodbye.

Conversation state is held in memory keyed by Twilio CallSid.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from twilio.rest import Client as TwilioClient

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.campaign import Campaign
from app.models.contact import Contact
from app.models.voice import VoiceCall
from app.services.sendgrid_service import send_email
from app.services.language_service import (
    LanguageConfig,
    resolve_language,
    resolve_language_from_request,
    DEFAULT_LANG,
)

logger = logging.getLogger(__name__)

MAX_TURNS = 6
LLM_TIMEOUT_SECONDS = 10
MAX_RETRIES = 2
CALL_TIMEOUT_SECONDS = 45
TWILIO_GATHER_TIMEOUT = 8

# Thread pool for blocking Twilio SDK calls
_twilio_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="twilio")

# ── In-memory conversation store (keyed by CallSid) ────────────────────────
_conversations: Dict[str, Dict[str, Any]] = {}
_conv_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Conversation memory helpers
# ---------------------------------------------------------------------------

def create_conversation(
    call_sid: str,
    contact: Dict[str, Any],
    campaign_context: str,
    campaign_id: str,
) -> None:
    # Resolve language from contact location
    location = contact.get("location", "")
    lang = resolve_language(location)

    with _conv_lock:
        _conversations[call_sid] = {
            "contact": contact,
            "campaign_context": campaign_context,
            "campaign_id": campaign_id,
            "language": lang,
            "turns": [],
            "turn_count": 0,
            "created_at": time.time(),
            "awaiting_email": False,
            "awaiting_email_confirmation": False,
            "pending_email": None,
            "email_sent": False,
        }
    logger.info(
        f"[VoiceAgent] CREATE conv CallSid={call_sid} contact={contact.get('name')} "
        f"location={location!r} → lang={lang.name} ({lang.code})"
    )


async def save_conversation_to_db(call_sid: str, campaign_id: str) -> bool:
    """
    Persist conversation state to database for recovery/analysis.
    Called at call end or on error.
    """
    conv = get_conversation(call_sid)
    if not conv:
        return False
    
    try:
        campaign_uuid = uuid.UUID(campaign_id)
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(VoiceCall).where(VoiceCall.call_sid == call_sid)
            )
            call_record = result.scalar_one_or_none()
            
            if call_record:
                call_record.conversation_state = json.dumps({
                    "contact": conv["contact"],
                    "language": conv["language"].code,
                    "turn_count": conv["turn_count"],
                    "awaiting_email": conv["awaiting_email"],
                    "email_sent": conv["email_sent"],
                    "pending_email": conv["pending_email"],
                    "created_at": conv["created_at"],
                })
                call_record.conversation_log = [
                    {"role": t["role"], "text": t["text"], "timestamp": t.get("timestamp")}
                    for t in conv.get("turns", [])
                ]
                call_record.turn_count = conv["turn_count"]
                call_record.language_code = conv["language"].code
                call_record.email_captured = conv.get("pending_email")
                call_record.email_sent = 1 if conv["email_sent"] else 0
                call_record.updated_at = datetime.utcnow()
                
                await db.commit()
                logger.info(f"[VoiceAgent] Saved conversation state for {call_sid}")
                return True
    except Exception as exc:
        logger.error(f"[VoiceAgent] Error saving conversation state: {exc}")
    
    return False


async def restore_conversation_from_db(call_sid: str) -> Optional[Dict[str, Any]]:
    """
    Restore conversation state from database if call was interrupted.
    Used for reconnection/recovery scenarios.
    """
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(VoiceCall).where(VoiceCall.call_sid == call_sid)
            )
            call_record = result.scalar_one_or_none()
            
            if call_record and call_record.conversation_state:
                state = json.loads(call_record.conversation_state)
                logger.info(f"[VoiceAgent] Restored conversation from DB for {call_sid}")
                return state
    except Exception as exc:
        logger.error(f"[VoiceAgent] Error restoring conversation state: {exc}")
    
    return None


def add_turn(call_sid: str, role: str, text: str) -> None:
    with _conv_lock:
        conv = _conversations.get(call_sid)
        if conv is None:
            logger.warning(f"[VoiceAgent] add_turn: no conv for CallSid={call_sid}")
            return
        conv["turns"].append({"role": role, "text": text})
        if role == "user":
            conv["turn_count"] += 1
    logger.debug(f"[VoiceAgent] TURN [{role}]: {text[:100]}")


def get_conversation(call_sid: str) -> Optional[Dict[str, Any]]:
    with _conv_lock:
        return _conversations.get(call_sid)


def get_language(call_sid: str) -> LanguageConfig:
    """Return the LanguageConfig for a call, or DEFAULT_LANG."""
    conv = get_conversation(call_sid)
    if conv and "language" in conv:
        return conv["language"]
    return DEFAULT_LANG


def _language_switch_confirmation(lang: LanguageConfig) -> str:
    confirmations = {
        "ta-IN": "நிச்சயமாக, தமிழில் தொடர்கிறேன்.",
        "hi-IN": "बिल्कुल, मैं हिंदी में आगे बात करूँगा।",
        "te-IN": "సరే, నేను తెలుగు లో కొనసాగిస్తాను.",
        "kn-IN": "ಖಂಡಿತ, ನಾನು ಕನ್ನಡದಲ್ಲಿ ಮುಂದುವರಿಸುತ್ತೇನೆ.",
        "ml-IN": "ശരി, ഞാൻ മലയാളത്തിൽ തുടരുമ്.",
        "en-US": "Sure — I'll continue in English.",
        "en-IN": "Sure — I'll continue in English.",
        "en-GB": "Sure — I'll continue in English.",
    }
    return confirmations.get(lang.code, f"Sure — I'll continue in {lang.name}.")


def _apply_language_switch_if_requested(call_sid: str, user_speech: str) -> Optional[str]:
    """Detect explicit language switch requests and update the conversation language."""
    requested = resolve_language_from_request(user_speech)
    if not requested:
        return None

    with _conv_lock:
        conv = _conversations.get(call_sid)
        if conv is None:
            return None
        current = conv.get("language", DEFAULT_LANG)
        if current.code == requested.code:
            return None
        conv["language"] = requested

    logger.info(
        f"[VoiceAgent] Language switch requested: {call_sid} {current.code} → {requested.code}"
    )
    return _language_switch_confirmation(requested)


def _last_agent_asked_email(conv: Dict[str, Any]) -> bool:
    """Check if agent recently mentioned sending email/mail or details."""
    turns = conv.get("turns") or []
    email_keywords = [
        "email", "mail", "send", "details", "information",
        "attachment", "link", "document", "materials",
        "மின்னஞ்சல்", "ஈமெயில்",  # Tamil
        "ईमेल", "ईमेल भेजूं", "विवरण",  # Hindi
        "ఈమెయిల్", "పంపిస్తాను",  # Telugu
    ]
    
    for turn in reversed(turns[-3:]):
        if turn.get("role") != "agent":
            continue
        text = (turn.get("text") or "").lower()
        if any(keyword.lower() in text for keyword in email_keywords):
            return True
    return False


def _is_affirmative(user_speech: str, lang: LanguageConfig) -> bool:
    text = user_speech.strip().lower()
    if not text:
        return False
    common_yes = ["yes", "yeah", "yep", "sure", "ok", "okay", "please", "go ahead", "do it", "send it"]
    tamil_yes = ["ஆமாம்", "ஆமா", "சரி", "அழகா", "பரவாயில்லை", "செய்யுங்க", "அனுப்புங்க", "அனுப்பு"]
    hindi_yes = ["हाँ", "haan", "haanji", "ठीक", "जरूर", "कर दीजिए", "भेज दीजिए"]
    if lang.code == "ta-IN":
        return any(k in text for k in [t.lower() for t in tamil_yes])
    if lang.code == "hi-IN":
        return any(k in text for k in [t.lower() for t in hindi_yes])
    return any(k in text for k in common_yes)


def _is_negative(user_speech: str, lang: LanguageConfig) -> bool:
    text = user_speech.strip().lower()
    if not text:
        return False
    common_no = ["no", "nope", "not now", "dont", "don't", "no thanks", "stop"]
    tamil_no = ["வேண்டாம்", "இல்லை", "இப்போ வேண்டாம்", "நோ"]
    hindi_no = ["नहीं", "नहीं चाहिए", "अभी नहीं", "रहने दो"]
    if lang.code == "ta-IN":
        return any(k in text for k in [t.lower() for t in tamil_no])
    if lang.code == "hi-IN":
        return any(k in text for k in [t.lower() for t in hindi_no])
    return any(k in text for k in common_no)


def _extract_email_from_speech(user_speech: str) -> Optional[str]:
    if not user_speech:
        return None
    text = user_speech.lower()
    replacements = {
        " at ": "@",
        " dot ": ".",
        " underscore ": "_",
        " dash ": "-",
        " hyphen ": "-",
        " space ": "",
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    text = text.replace(" ", "")
    match = re.search(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", text)
    return match.group(0) if match else None


def _email_prompt(lang: LanguageConfig) -> str:
    prompts = {
        "ta-IN": "உங்கள் மின்னஞ்சல் கிடைக்கவில்லை. தயவு செய்து மெதுவாக எழுத்துப்படி சொல்வீர்களா?",
        "hi-IN": "आपका ईमेल नहीं मिला। कृपया धीरे-धीरे स्पेल करके बताएँ।",
        "te-IN": "మీ ఇమెయిల్ కనిపించలేదు. దయచేసి నెమ్మదిగా స్పెల్ చేసి చెప్పండి.",
        "kn-IN": "ನಿಮ್ಮ ಇಮೇಲ್ ಸಿಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಧಾನವಾಗಿ ಸ್ಪೆಲ್ ಮಾಡಿ ಹೇಳಿ.",
        "ml-IN": "നിങ്ങളുടെ ഇമെയിൽ ലഭിച്ചില്ല. ദയവായി മന്ദഗതിയിൽ സ്പെൽ ചെയ്ത് പറയാമോ?",
    }
    return prompts.get(lang.code, "I couldn't find your email. Please spell it slowly.")


def _email_confirmation(lang: LanguageConfig) -> str:
    confirmations = {
        "ta-IN": "சரி, நான் இப்போது மின்னஞ்சல் அனுப்புகிறேன்.",
        "hi-IN": "ठीक है, मैं अभी ईमेल भेज रहा हूँ।",
        "te-IN": "సరే, నేను ఇప్పుడే ఈమెయిల్ పంపిస్తున్నాను.",
        "kn-IN": "ಸರಿ, ನಾನು ಈಗ ಇಮೇಲ್ ಕಳುಹಿಸುತ್ತೇನೆ.",
        "ml-IN": "ശരി, ഞാൻ ഇപ്പോൾ ഇമെയിൽ അയയ്ക്കുന്നു.",
    }
    return confirmations.get(lang.code, "Sure — I will send the email now.")


def _email_confirm_prompt(email: str, lang: LanguageConfig) -> str:
    # Speak email in a TTS-friendly way: "john dot doe at gmail dot com"
    def _speakable(addr: str) -> str:
        return (
            addr
            .replace("@", " at ")
            .replace(".", " dot ")
            .replace("_", " underscore ")
            .replace("-", " hyphen ")
        )

    speakable = _speakable(email)
    prompts = {
        "ta-IN": f"நான் \"{speakable}\" என்று கேட்டேன். அது சரியா?",
        "hi-IN": f"मैंने \"{speakable}\" सुना है। क्या यह सही है?",
        "te-IN": f"నేను \"{speakable}\" అని విన్నాను. ఇది సరైందేనా?",
        "kn-IN": f"ನಾನು \"{speakable}\" ಎಂದು ಕೇಳಿದ್ದೇನೆ. ಇದು ಸರಿಯೇ?",
        "ml-IN": f"ഞാൻ \"{speakable}\" എന്ന് കേട്ടു. അത് ശരിയാണോ?",
    }
    return prompts.get(lang.code, f"I heard \"{speakable}\". Is that correct?")


def _email_sent_message(lang: LanguageConfig) -> str:
    messages = {
        "ta-IN": "மின்னஞ்சல் அனுப்பிவிட்டேன். இன்னும் எதாவது உதவி வேண்டுமா?",
        "hi-IN": "मैंने ईमेल भेज दिया है। क्या मैं और मदद करूँ?",
        "te-IN": "నేను ఈమెయిల్ పంపాను. ఇంకేమైనా సహాయం కావాలా?",
        "kn-IN": "ನಾನು ಇಮೇಲ್ ಕಳುಹಿಸಿದ್ದೇನೆ. ಇನ್ನೇನಾದರೂ ಸಹಾಯ ಬೇಕೆ?",
        "ml-IN": "ഞാൻ ഇമെയിൽ അയച്ചു. മറ്റെന്തെങ്കിലും സഹായം വേണോ?",
    }
    return messages.get(lang.code, "I've sent the email. Is there anything else you need?")


def _email_failed_message(lang: LanguageConfig) -> str:
    messages = {
        "ta-IN": "மன்னிக்கவும், மின்னஞ்சல் அனுப்ப முடியவில்லை. பிறகு அனுப்ப முயற்சிக்கிறேன்.",
        "hi-IN": "माफ़ कीजिए, ईमेल भेज नहीं पाया। मैं बाद में फिर कोशिश करूँगा।",
        "te-IN": "క్షమించండి, ఈమెయిల్ పంపలేకపోయాను. తర్వాత మళ్లీ ప్రయత్నిస్తాను.",
        "kn-IN": "ಕ್ಷಮಿಸಿ, ಇಮೇಲ್ ಕಳುಹಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸುತ್ತೇನೆ.",
        "ml-IN": "ക്ഷമിക്കണം, ഇമെയിൽ അയയ്ക്കാൻ കഴിയില്ല. പിന്നീട് വീണ്ടും ശ്രമിക്കും.",
    }
    return messages.get(lang.code, "Sorry, I couldn't send the email. I'll try again later.")


def _build_followup_email(campaign_context: str, contact: Dict[str, Any]) -> tuple[str, str, str]:
    """Build follow-up email with campaign details."""
    name = contact.get("name") or "there"
    company = contact.get("company") or "your organization"
    
    # Create compelling subject line
    subject = f"Details we discussed - {company}"
    
    plain = (
        f"Hi {name},\n\n"
        f"Thank you for taking the time to chat with us today.\n\n"
        f"As promised, here's more information about our solution:\n\n"
        f"{campaign_context}\n\n"
        f"Key benefits:\n"
        f"• Automated outreach to boost your pipeline\n"
        f"• Personalized follow-up at scale\n"
        f"• Detailed analytics and tracking\n\n"
        f"Next steps:\n"
        f"1. Review the details above\n"
        f"2. Reply to this email with your thoughts\n"
        f"3. Let's schedule a quick call\n\n"
        f"Looking forward to discussing how we can help {company}!\n\n"
        f"Best regards,\n"
        f"InFynd Campaign Team"
    )
    
    html = (
        "<!DOCTYPE html><html><body style='font-family: Arial, sans-serif;'>"
        f"<p>Hi {name},</p>"
        f"<p>Thank you for taking the time to chat with us today.</p>"
        f"<p>As promised, here's more information about our solution:</p>"
        f"<blockquote style='background: #f5f5f5; padding: 15px; border-left: 4px solid #007bff;'>"
        f"{campaign_context.replace(chr(10), '<br>')}"
        f"</blockquote>"
        f"<h3>Key benefits:</h3>"
        f"<ul>"
        f"<li>Automated outreach to boost your pipeline</li>"
        f"<li>Personalized follow-up at scale</li>"
        f"<li>Detailed analytics and tracking</li>"
        f"</ul>"
        f"<h3>Next steps:</h3>"
        f"<ol>"
        f"<li>Review the details above</li>"
        f"<li>Reply to this email with your thoughts</li>"
        f"<li>Let's schedule a quick call</li>"
        f"</ol>"
        f"<p>Looking forward to discussing how we can help {company}!</p>"
        f"<p><strong>Best regards,</strong><br>InFynd Campaign Team</p>"
        "</body></html>"
    )
    return subject, plain, html


async def _send_followup_email(conv: Dict[str, Any], to_email: str) -> bool:
    """Send follow-up email via SendGrid with comprehensive logging."""
    try:
        logger.info(f"[VoiceAgent] Building follow-up email for {to_email}")
        
        subject, plain, html = _build_followup_email(
            conv.get("campaign_context", ""), 
            conv.get("contact", {})
        )
        
        logger.info(f"[VoiceAgent] Sending email to {to_email} with subject: {subject!r}")
        
        msg_id = await send_email(
            to_email=to_email,
            subject=subject,
            html_body=html,
            plain_text=plain,
            campaign_id=str(conv.get("campaign_id") or ""),
            message_id_prefix="voice-followup",
        )
        
        if msg_id:
            logger.info(f"[VoiceAgent] ✓ Email sent successfully to {to_email}, msg_id={msg_id}")
            return True
        else:
            logger.error(f"[VoiceAgent] ✗ SendGrid returned None for {to_email} (retry exhausted)")
            return False
            
    except Exception as exc:
        logger.error(f"[VoiceAgent] Exception while sending email to {to_email}: {exc}", exc_info=True)
        return False


async def _save_contact_email(conv: Dict[str, Any], email: str) -> None:
    """Save captured email to contact record in database."""
    contact_id = (conv.get("contact") or {}).get("contact_id")
    if not contact_id:
        logger.warning(f"[VoiceAgent] Cannot save email: no contact_id in conversation")
        return

    try:
        async with AsyncSessionLocal() as db:
            logger.info(f"[VoiceAgent] Saving email {email} for contact_id={contact_id}")
            
            result = await db.execute(
                update(Contact)
                .where(Contact.id == uuid.UUID(str(contact_id)))
                .values(email=email, updated_at=datetime.utcnow())
            )
            await db.commit()
            
            if result.rowcount > 0:
                logger.info(f"[VoiceAgent] ✓ Email saved: {email} for contact_id={contact_id}")
            else:
                logger.warning(f"[VoiceAgent] No rows updated for contact_id={contact_id}")
                
    except Exception as exc:
        logger.error(f"[VoiceAgent] Failed to persist email for contact {contact_id}: {exc}", exc_info=True)


def remove_conversation(call_sid: str) -> None:
    with _conv_lock:
        _conversations.pop(call_sid, None)
    logger.info(f"[VoiceAgent] REMOVE conv CallSid={call_sid}")


# ---------------------------------------------------------------------------
# LLM reply via Ollama (async)
# ---------------------------------------------------------------------------

async def _ask_ollama(prompt: str) -> str:
    """Call Ollama generate endpoint with retry logic and timeout."""
    payload = {
        "model": settings.OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"num_predict": 80, "temperature": 0.7},
    }
    
    for attempt in range(MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SECONDS) as client:
                resp = await client.post(settings.OLLAMA_URL, json=payload)
                resp.raise_for_status()
                data = resp.json()
                result = data.get("response", "").strip()
                if result:
                    return result
        except asyncio.TimeoutError:
            logger.warning(f"[VoiceAgent] Ollama timeout (attempt {attempt + 1}/{MAX_RETRIES})")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(0.3 * (attempt + 1))  # Exponential backoff
                continue
            break
        except Exception as exc:
            logger.warning(f"[VoiceAgent] Ollama error (attempt {attempt + 1}/{MAX_RETRIES}): {exc}")
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(0.3 * (attempt + 1))  # Exponential backoff
                continue
            break
    
    logger.error(f"[VoiceAgent] Ollama failed after {MAX_RETRIES} attempts")
    return ""


async def generate_voice_reply(call_sid: str, user_speech: str) -> str:
    """Generate LLM reply for a voice turn."""
    conv = get_conversation(call_sid)
    if conv is None:
        return "Thank you for your time. Goodbye!"

    add_turn(call_sid, "user", user_speech)
    conv = get_conversation(call_sid)

    # If the caller asked to switch language, comply immediately.
    confirmation = _apply_language_switch_if_requested(call_sid, user_speech)
    if confirmation:
        add_turn(call_sid, "agent", confirmation)
        return confirmation

    # If waiting for email confirmation, handle yes/no
    if conv.get("awaiting_email_confirmation"):
        lang = conv.get("language", DEFAULT_LANG)
        if _is_affirmative(user_speech, lang):
            candidate = conv.get("pending_email")
            if candidate:
                ok = await _send_followup_email(conv, candidate)
                if ok:
                    await _save_contact_email(conv, candidate)
                conv["awaiting_email_confirmation"] = False
                conv["pending_email"] = None
                conv["email_sent"] = ok
                msg = _email_sent_message(lang) if ok else _email_failed_message(lang)
                add_turn(call_sid, "agent", msg)
                return msg

        if _is_negative(user_speech, lang):
            conv["awaiting_email_confirmation"] = False
            conv["pending_email"] = None
            conv["awaiting_email"] = True
            prompt = _email_prompt(lang)
            add_turn(call_sid, "agent", prompt)
            return prompt

        # If unclear, re-ask confirmation
        candidate = conv.get("pending_email") or ""
        prompt = _email_confirm_prompt(candidate, lang)
        add_turn(call_sid, "agent", prompt)
        return prompt

    # If waiting for email spelling, parse and confirm
    if conv.get("awaiting_email"):
        lang = conv.get("language", DEFAULT_LANG)
        candidate = _extract_email_from_speech(user_speech)
        if not candidate:
            prompt = _email_prompt(lang)
            add_turn(call_sid, "agent", prompt)
            return prompt

        conv["awaiting_email"] = False
        conv["awaiting_email_confirmation"] = True
        conv["pending_email"] = candidate
        prompt = _email_confirm_prompt(candidate, lang)
        add_turn(call_sid, "agent", prompt)
        return prompt

    if conv["turn_count"] >= MAX_TURNS:
        farewell = _build_farewell(conv)
        add_turn(call_sid, "agent", farewell)
        return farewell

    contact = conv["contact"]
    lang: LanguageConfig = conv.get("language", DEFAULT_LANG)
    history = "\n".join(
        f"{'Agent' if t['role'] == 'agent' else 'Contact'}: {t['text']}"
        for t in conv["turns"]
    )

    # If the user is responding to an email-offer question, handle yes/no
    if _last_agent_asked_email(conv):
        logger.info(f"[VoiceAgent] Email offer detected for {call_sid}, user said: {user_speech!r}")
        
        if _is_affirmative(user_speech, lang):
            logger.info(f"[VoiceAgent] User CONFIRMED email send for {call_sid}")
            contact_email = (contact.get("email") or "").strip()
            
            if contact_email:
                logger.info(f"[VoiceAgent] Contact email found: {contact_email}, sending...")
                ok = await _send_followup_email(conv, contact_email)
                conv["email_sent"] = ok
                logger.info(f"[VoiceAgent] Email send result: {ok} for {contact_email}")
                reply = _email_sent_message(lang) if ok else _email_failed_message(lang)
                add_turn(call_sid, "agent", reply)
                return reply
            else:
                logger.info(f"[VoiceAgent] No email on file, requesting from user...")
                conv["awaiting_email"] = True
                reply = _email_prompt(lang)
                add_turn(call_sid, "agent", reply)
                return reply

        if _is_negative(user_speech, lang):
            logger.info(f"[VoiceAgent] User DECLINED email send for {call_sid}")
            reply = _build_farewell(conv)
            add_turn(call_sid, "agent", reply)
            return reply

    prompt = f"""### Instruction:
You are a friendly, professional sales agent on a phone call.
Sound natural, like a helpful human — not robotic.
You are speaking to {contact.get('name', 'the contact')} who works as
{contact.get('role', 'a professional')} at {contact.get('company', 'their company')}.
The contact is located in {contact.get('location', 'unknown')}.

Campaign pitch:
{conv['campaign_context'][:500]}

Conversation so far:
{history}

Language: {lang.llm_instruction}

Rules:
- Reply in 1-2 short sentences ONLY. This is a phone call.
- {lang.llm_instruction}
- Stay on topic. Be polite and professional.
- Never use abusive, inappropriate, sexual, hateful, or violent language.
- If the user asks to switch language, comply and reply in the requested language.
- Plain speech only — no markdown, no special characters.

### Response:
"""

    raw = await _ask_ollama(prompt)

    # Take first non-empty, non-header line
    reply = ""
    for line in raw.strip().split("\n"):
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("---"):
            reply = line
            break
    if not reply:
        reply = raw[:200] if raw else _get_fallback_reply(conv)

    add_turn(call_sid, "agent", reply)
    logger.info(f"[VoiceAgent] LLM reply for {call_sid}: {reply!r}")
    return reply


def _get_fallback_reply(conv: Dict[str, Any]) -> str:
    name = conv["contact"].get("name", "")
    if conv.get("turn_count", 0) >= MAX_TURNS - 1:
        return _build_farewell(conv)
    return (
        f"That's really interesting{', ' + name if name else ''}. "
        "Could I send you more details via email?"
    )


def _build_farewell(conv: Dict[str, Any]) -> str:
    name = conv["contact"].get("name", "")
    lang: LanguageConfig = conv.get("language", DEFAULT_LANG)

    # Localised farewell templates for common languages
    _FAREWELLS = {
        "hi-IN": f"{'धन्यवाद ' + name + ', ' if name else 'धन्यवाद, '}आपके समय के लिए बहुत शुक्रिया। "
                  "हम आपको एक फॉलो-अप ईमेल भेजेंगे। आपका दिन शुभ हो! अलविदा।",
        "ta-IN": f"{'நன்றி ' + name + ', ' if name else 'நன்றி, '}உங்கள் நேரத்திற்கு மிகவும் நன்றி। "
                  "நாங்கள் உங்களுக்கு ஒரு பின்தொடர்தல் மின்னஞ்சல் அனுப்புவோம்। நல்ல நாள்! நன்றி போய் வருகிறேன்.",
        "te-IN": f"{'ధన్యవాదాలు ' + name + ', ' if name else 'ధన్యవాదాలు, '}మీ సమయానికి చాలా ధన్యవాదాలు। "
                  "మేము మీకు ఫాలో-అప్ ఈమెయిల్ పంపుతాము। మంచి రోజు! వెళ్ళొస్తాను.",
        "kn-IN": f"{'ಧನ್ಯವಾದ ' + name + ', ' if name else 'ಧನ್ಯವಾದ, '}ನಿಮ್ಮ ಸಮಯಕ್ಕೆ ತುಂಬಾ ಧನ್ಯವಾದ। "
                  "ನಾವು ನಿಮಗೆ ಫಾಲೋ-ಅಪ್ ಇಮೇಲ್ ಕಳುಹಿಸುತ್ತೇವೆ। ಒಳ್ಳೆಯ ದಿನ! ಹೋಗಿ ಬರುತ್ತೇನೆ.",
        "de-DE": f"Vielen Dank für Ihre Zeit{', ' + name if name else ''}. "
                  "Wir senden Ihnen eine Nachfass-E-Mail. Einen schönen Tag noch! Auf Wiedersehen.",
        "fr-FR": f"Merci beaucoup pour votre temps{', ' + name if name else ''}. "
                  "Nous vous enverrons un e-mail de suivi. Bonne journée ! Au revoir.",
        "es-ES": f"Muchas gracias por su tiempo{', ' + name if name else ''}. "
                  "Le enviaremos un correo de seguimiento. ¡Que tenga un buen día! Adiós.",
        "ar-XA": f"{'شكراً جزيلاً ' + name + '، ' if name else 'شكراً جزيلاً، '}شكراً لوقتك. "
                  "سنرسل لك بريداً إلكترونياً للمتابعة. يوماً سعيداً! مع السلامة.",
        "ja-JP": f"{name + '様、' if name else ''}お時間をいただきありがとうございます。"
                  "フォローアップのメールをお送りいたします。良い一日を！失礼いたします。",
        "ko-KR": f"{name + '님, ' if name else ''}시간 내주셔서 감사합니다. "
                  "후속 이메일을 보내드리겠습니다. 좋은 하루 되세요! 안녕히 계세요.",
        "zh-CN": f"{'谢谢' + name + '，' if name else '谢谢，'}感谢您抽出时间。"
                  "我们会给您发送跟进邮件。祝您有美好的一天！再见。",
    }

    if lang.code in _FAREWELLS:
        return _FAREWELLS[lang.code]

    # Default English farewell
    return (
        f"Thank you so much for your time{', ' + name if name else ''}. "
        "We'll send you a follow-up email with all the details. "
        "Have a great day! Goodbye."
    )


# ---------------------------------------------------------------------------
# Opening pitch
# ---------------------------------------------------------------------------

def build_opening_pitch(contact: Dict[str, Any], campaign_context: str, lang: Optional[LanguageConfig] = None) -> str:
    name = contact.get("name", "there")
    company = contact.get("company", "your company")

    if lang is None:
        lang = resolve_language(contact.get("location", ""))

    # Localised opening pitches for common languages
    _OPENINGS = {
        "hi-IN": (
            f"नमस्ते {name}, मैं कैम्पेन आउटरीच टीम से बोल रहा हूं। "
            f"मैं आपको कॉल कर रहा हूं क्योंकि {company} के लिए हमारे पास एक शानदार अवसर है। "
            "क्या आपके पास बात करने के लिए कुछ मिनट हैं?"
        ),
        "ta-IN": (
            f"வணக்கம் {name}, நான் கேம்பெயின் அவுட்ரீச் குழுவிலிருந்து பேசுகிறேன். "
            f"{company}-க்கு ஒரு அருமையான வாய்ப்பு இருப்பதால் உங்களை அழைக்கிறேன். "
            "உங்களுக்கு சிறிது நேரம் இருக்கிறதா?"
        ),
        "te-IN": (
            f"నమస్కారం {name}, నేను క్యాంపెయిన్ ఆఉట్‌రీచ్ టీమ్ నుండి మాట్లాడుతున్నాను. "
            f"{company} కోసం మా దగ్గర ఒక గొప్ప అవకాశం ఉంది. "
            "మీకు కొద్ది సేపు ఉందా?"
        ),
        "kn-IN": (
            f"ನಮಸ್ಕಾರ {name}, ನಾನು ಕ್ಯಾಂಪೇನ್ ಔಟ್‌ರೀಚ್ ತಂಡದಿಂದ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ. "
            f"{company} ಗೆ ಒಂದು ಅದ್ಭುತ ಅವಕಾಶವಿದೆ. "
            "ನಿಮಗೆ ಸ್ವಲ್ಪ ಸಮಯವಿದೆಯೇ?"
        ),
        "de-DE": (
            f"Hallo {name}, hier ist das Kampagnen-Outreach-Team. "
            f"Ich rufe an, weil wir eine spannende Möglichkeit für {company} haben. "
            "Haben Sie einen Moment Zeit?"
        ),
        "fr-FR": (
            f"Bonjour {name}, ici l'équipe de campagne. "
            f"Je vous appelle car nous avons une opportunité passionnante pour {company}. "
            "Avez-vous un moment pour discuter ?"
        ),
        "es-ES": (
            f"Hola {name}, soy del equipo de campaña. "
            f"Le llamo porque tenemos una oportunidad emocionante para {company}. "
            "¿Tiene un momento para hablar?"
        ),
        "ar-XA": (
            f"مرحباً {name}، أنا من فريق التواصل للحملات. "
            f"أتصل بك لأن لدينا فرصة رائعة لـ {company}. "
            "هل لديك بضع دقائق للحديث؟"
        ),
        "ja-JP": (
            f"もしもし、{name}様、キャンペーンチームの者です。"
            f"{company}様に素晴らしい機会がございますのでお電話いたしました。"
            "少しお時間よろしいでしょうか？"
        ),
        "ko-KR": (
            f"안녕하세요 {name}님, 캠페인 아웃리치 팀입니다. "
            f"{company}에 좋은 기회가 있어서 연락드렸습니다. "
            "잠시 통화 가능하시겠습니까?"
        ),
        "zh-CN": (
            f"您好{name}，我是活动推广团队的。"
            f"我打电话是因为我们为{company}提供了一个很好的机会。"
            "您现在方便聊聊吗？"
        ),
    }

    if lang.code in _OPENINGS:
        return _OPENINGS[lang.code]

    # Default English
    return (
        f"Hello {name}, this is the campaign outreach team. "
        f"I'm calling because we have an exciting opportunity for {company}. "
        "Do you have a moment to chat?"
    )


# ---------------------------------------------------------------------------
# Twilio: place one outbound call
# ---------------------------------------------------------------------------

def _get_twilio_client() -> TwilioClient:
    if not settings.TWILIO_ACCOUNT_SID or not settings.TWILIO_AUTH_TOKEN:
        raise RuntimeError("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured in .env")
    return TwilioClient(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)


async def initiate_call(
    to_number: str,
    contact: Dict[str, Any],
    campaign_context: str,
    campaign_id: str,
) -> Dict[str, Any]:
    """Place a single outbound call via Twilio (async wrapper)."""
    if not settings.NGROK_BASE_URL:
        raise RuntimeError("NGROK_BASE_URL not set in .env — start ngrok first.")
    if not settings.TWILIO_FROM_NUMBER:
        raise RuntimeError("TWILIO_FROM_NUMBER not set in .env.")

    answer_url = f"{settings.NGROK_BASE_URL}/api/v1/voice/answer"
    status_url = f"{settings.NGROK_BASE_URL}/api/v1/voice/status"

    def _create_call():
        client = _get_twilio_client()
        return client.calls.create(
            to=to_number,
            from_=settings.TWILIO_FROM_NUMBER,
            url=answer_url,
            status_callback=status_url,
            status_callback_event=["completed", "busy", "no-answer", "failed", "canceled"],
            status_callback_method="POST",
            method="POST",
        )

    loop = asyncio.get_event_loop()
    call = await loop.run_in_executor(_twilio_pool, _create_call)

    logger.info(f"[VoiceAgent] Call created SID={call.sid} to={to_number}")

    # Pre-seed conversation memory
    create_conversation(
        call_sid=call.sid,
        contact=contact,
        campaign_context=campaign_context,
        campaign_id=campaign_id,
    )

    # Record in DB
    await _record_call_db(campaign_id, contact, call.sid, "initiated")

    return {
        "call_sid": call.sid,
        "to": to_number,
        "name": contact.get("name"),
        "status": "initiated",
    }


# ---------------------------------------------------------------------------
# Batch call campaign contacts
# ---------------------------------------------------------------------------

async def call_campaign_contacts(
    campaign_id: str,
    delay_between: float = 2.0,
) -> Dict[str, Any]:
    """
    Dispatch outbound calls to every contact in the campaign.
    Contacts are sourced from generated_content['contacts'] map
    (these are the email → channel assignments from the pipeline).
    Phone numbers are looked up in the contacts table.
    """
    campaign_uuid = uuid.UUID(campaign_id)

    async with AsyncSessionLocal() as db:
        # Load campaign
        result = await db.execute(select(Campaign).where(Campaign.id == campaign_uuid))
        campaign = result.scalar_one_or_none()
        if not campaign:
            raise ValueError(f"Campaign {campaign_id} not found")

        generated: Dict[str, Any] = campaign.generated_content or {}
        contacts_map: Dict[str, str] = generated.get("contacts") or {}
        common_templates: Dict[str, Any] = generated.get("common") or {}
        call_template = common_templates.get("Call", {})
        call_script: str = " | ".join(
            f"{k}: {v}" for k, v in call_template.items() if isinstance(v, str) and k != "cta_link"
        ) or (
            f"We have an exciting opportunity that could benefit your company. "
            f"Campaign: {campaign.name}."
        )

        # Collect email → channel entries where channel is Call
        contact_emails: List[str] = [
            email for email, channel in contacts_map.items()
            if isinstance(email, str) and "@" in email and channel == "Call"
        ]

        # Fallback: if no Call-channel contacts, call everyone
        if not contact_emails:
            contact_emails = [e for e in contacts_map.keys() if isinstance(e, str) and "@" in e]

        # Fetch contact records
        contacts_result = await db.execute(
            select(Contact).where(Contact.email.in_(contact_emails))
        )
        contact_records: List[Contact] = contacts_result.scalars().all()

    if not contact_records:
        logger.warning(f"[VoiceAgent] No contacts found for campaign {campaign_id}")
        return {"total": 0, "called": 0, "skipped": 0, "results": [], "message": "No contacts found"}

    called = 0
    skipped = 0
    results: List[Dict[str, Any]] = []

    for contact in contact_records:
        # Prefer phone_number column if present, else fallback
        phone = getattr(contact, "phone_number", None) or getattr(contact, "phoneno", None) or getattr(contact, "phone", None) or ""
        phone = str(phone).strip().replace(" ", "")

        logger.info(f"[VoiceAgent] Contact: {contact.name} | email={contact.email} | phone={phone!r}")

        if not phone:
            skipped += 1
            logger.warning(f"[VoiceAgent] SKIP {contact.name} — no phone number")
            results.append({
                "contact_email": contact.email,
                "name": contact.name,
                "status": "skipped",
                "reason": "No phone number",
            })
            continue

        # Ensure E.164 format
        if not phone.startswith("+"):
            phone = "+91" + phone

        contact_dict = {
            "contact_id": str(contact.id) if getattr(contact, "id", None) else None,
            "name": contact.name,
            "email": contact.email,
            "company": contact.company,
            "role": contact.role,
            "location": contact.location or "",
        }

        try:
            call_result = await initiate_call(phone, contact_dict, call_script, campaign_id)
            called += 1
            results.append(call_result)
        except Exception as exc:
            logger.error(f"[VoiceAgent] Call FAILED for {contact.name}: {exc}")
            results.append({
                "contact_email": contact.email,
                "name": contact.name,
                "status": "failed",
                "error": str(exc),
            })

        if delay_between > 0:
            await asyncio.sleep(delay_between)

    return {
        "total": len(contact_records),
        "called": called,
        "skipped": skipped,
        "results": results,
    }


# ---------------------------------------------------------------------------
# DB helpers (async)
# ---------------------------------------------------------------------------

async def _record_call_db(campaign_id: str, contact: Dict[str, Any], call_sid: str, status: str) -> None:
    try:
        async with AsyncSessionLocal() as db:
            db.add(VoiceCall(
                campaign_id=uuid.UUID(campaign_id),
                contact_name=contact.get("name"),
                contact_email=contact.get("email"),
                contact_phone=contact.get("phone", ""),
                call_sid=call_sid,
                status=status,
            ))
            await db.commit()
        logger.info(f"[VoiceAgent] DB: recorded call {call_sid}")
    except Exception as exc:
        logger.warning(f"[VoiceAgent] DB: failed to record call {call_sid}: {exc}")


async def update_call_status(call_sid: str, status: str) -> None:
    """Update call status and save conversation log to DB."""
    conv = get_conversation(call_sid)
    try:
        async with AsyncSessionLocal() as db:
            values: Dict[str, Any] = {
                "status": status,
                "updated_at": datetime.utcnow(),
            }
            if conv and conv.get("turns"):
                values["conversation_log"] = conv["turns"]
            await db.execute(
                update(VoiceCall).where(VoiceCall.call_sid == call_sid).values(**values)
            )
            await db.commit()
        logger.info(f"[VoiceAgent] DB: call {call_sid} → {status}")
    except Exception as exc:
        logger.warning(f"[VoiceAgent] DB: failed to update call {call_sid}: {exc}")
    finally:
        remove_conversation(call_sid)
