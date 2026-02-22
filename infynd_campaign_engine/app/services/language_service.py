"""
Language Service
================
Resolves a contact's location to the appropriate language configuration
for voice calls — including Twilio voice name, speech-recognition language,
and LLM instruction language.

Supports:
  - Indian regional languages (Tamil, Telugu, Hindi, Kannada, Malayalam, etc.)
  - Major world languages (English, German, French, Spanish, Arabic, etc.)
  - Fallback to English (US) for unknown locations
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LanguageConfig:
    """Immutable language configuration for a voice call."""
    code: str            # BCP-47 code, e.g. "ta-IN"
    name: str            # Human name, e.g. "Tamil"
    twilio_voice: str    # Twilio <Say> voice attribute
    gather_lang: str     # Twilio <Gather> speech recognition language
    llm_instruction: str # Short instruction to include in the LLM prompt


# ── Default ─────────────────────────────────────────────────────────────────
DEFAULT_LANG = LanguageConfig(
    code="en-US",
    name="English",
    twilio_voice="Polly.Matthew",
    gather_lang="en-US",
    llm_instruction="Reply in English.",
)


# ── Pre-built configs ──────────────────────────────────────────────────────
_ENGLISH_US = DEFAULT_LANG

_ENGLISH_UK = LanguageConfig(
    code="en-GB",
    name="English (UK)",
    twilio_voice="Polly.Brian",
    gather_lang="en-GB",
    llm_instruction="Reply in English.",
)

_ENGLISH_IN = LanguageConfig(
    code="en-IN",
    name="English (India)",
    twilio_voice="Polly.Aditi",
    gather_lang="en-IN",
    llm_instruction="Reply in English.",
)

_HINDI = LanguageConfig(
    code="hi-IN",
    name="Hindi",
    twilio_voice="Polly.Aditi",
    gather_lang="hi-IN",
    llm_instruction="Reply in Hindi (Devanagari script). Use simple conversational Hindi.",
)

_TAMIL = LanguageConfig(
    code="ta-IN",
    name="Tamil",
    twilio_voice="Google.ta-IN-Standard-A",
    gather_lang="ta-IN",
    llm_instruction="Reply in Tamil (தமிழ்). Use simple conversational Tamil.",
)

_TELUGU = LanguageConfig(
    code="te-IN",
    name="Telugu",
    twilio_voice="Google.te-IN-Standard-A",
    gather_lang="te-IN",
    llm_instruction="Reply in Telugu (తెలుగు). Use simple conversational Telugu.",
)

_KANNADA = LanguageConfig(
    code="kn-IN",
    name="Kannada",
    twilio_voice="Google.kn-IN-Standard-A",
    gather_lang="kn-IN",
    llm_instruction="Reply in Kannada (ಕನ್ನಡ). Use simple conversational Kannada.",
)

_MALAYALAM = LanguageConfig(
    code="ml-IN",
    name="Malayalam",
    twilio_voice="Google.ml-IN-Standard-A",
    gather_lang="ml-IN",
    llm_instruction="Reply in Malayalam (മലയാളം). Use simple conversational Malayalam.",
)

_BENGALI = LanguageConfig(
    code="bn-IN",
    name="Bengali",
    twilio_voice="Google.bn-IN-Standard-A",
    gather_lang="bn-IN",
    llm_instruction="Reply in Bengali (বাংলা). Use simple conversational Bengali.",
)

_MARATHI = LanguageConfig(
    code="mr-IN",
    name="Marathi",
    twilio_voice="Google.mr-IN-Standard-A",
    gather_lang="mr-IN",
    llm_instruction="Reply in Marathi (मराठी). Use simple conversational Marathi.",
)

_GUJARATI = LanguageConfig(
    code="gu-IN",
    name="Gujarati",
    twilio_voice="Google.gu-IN-Standard-A",
    gather_lang="gu-IN",
    llm_instruction="Reply in Gujarati (ગુજરાતી). Use simple conversational Gujarati.",
)

_GERMAN = LanguageConfig(
    code="de-DE",
    name="German",
    twilio_voice="Polly.Hans",
    gather_lang="de-DE",
    llm_instruction="Reply in German (Deutsch). Use professional conversational German.",
)

_FRENCH = LanguageConfig(
    code="fr-FR",
    name="French",
    twilio_voice="Polly.Mathieu",
    gather_lang="fr-FR",
    llm_instruction="Reply in French (Français). Use professional conversational French.",
)

_SPANISH = LanguageConfig(
    code="es-ES",
    name="Spanish",
    twilio_voice="Polly.Miguel",
    gather_lang="es-ES",
    llm_instruction="Reply in Spanish (Español). Use professional conversational Spanish.",
)

_ARABIC = LanguageConfig(
    code="ar-XA",
    name="Arabic",
    twilio_voice="Google.ar-XA-Standard-A",
    gather_lang="ar-SA",
    llm_instruction="Reply in Arabic (العربية). Use professional conversational Arabic.",
)

_JAPANESE = LanguageConfig(
    code="ja-JP",
    name="Japanese",
    twilio_voice="Polly.Takumi",
    gather_lang="ja-JP",
    llm_instruction="Reply in Japanese (日本語). Use polite conversational Japanese.",
)

_KOREAN = LanguageConfig(
    code="ko-KR",
    name="Korean",
    twilio_voice="Polly.Seoyeon",
    gather_lang="ko-KR",
    llm_instruction="Reply in Korean (한국어). Use polite conversational Korean.",
)

_PORTUGUESE_BR = LanguageConfig(
    code="pt-BR",
    name="Portuguese",
    twilio_voice="Polly.Ricardo",
    gather_lang="pt-BR",
    llm_instruction="Reply in Portuguese (Português). Use professional conversational Portuguese.",
)

_MANDARIN = LanguageConfig(
    code="zh-CN",
    name="Mandarin Chinese",
    twilio_voice="Polly.Zhiyu",
    gather_lang="zh-CN",
    llm_instruction="Reply in Mandarin Chinese (中文). Use professional conversational Mandarin.",
)

_ITALIAN = LanguageConfig(
    code="it-IT",
    name="Italian",
    twilio_voice="Polly.Giorgio",
    gather_lang="it-IT",
    llm_instruction="Reply in Italian (Italiano). Use professional conversational Italian.",
)

_DUTCH = LanguageConfig(
    code="nl-NL",
    name="Dutch",
    twilio_voice="Polly.Ruben",
    gather_lang="nl-NL",
    llm_instruction="Reply in Dutch (Nederlands). Use professional conversational Dutch.",
)


# ── Location → Language mapping ────────────────────────────────────────────
# Keys are LOWERCASED. The resolver normalises input before lookup.

_LOCATION_MAP: Dict[str, LanguageConfig] = {
    # ── India: regional by city / state ──
    "chennai":        _TAMIL,
    "coimbatore":     _TAMIL,
    "madurai":        _TAMIL,
    "trichy":         _TAMIL,
    "salem":          _TAMIL,
    "tamil nadu":     _TAMIL,
    "tamilnadu":      _TAMIL,
    "tn":             _TAMIL,

    "hyderabad":      _TELUGU,
    "visakhapatnam":  _TELUGU,
    "vijayawada":     _TELUGU,
    "andhra pradesh": _TELUGU,
    "telangana":      _TELUGU,
    "ap":             _TELUGU,

    "bangalore":      _KANNADA,
    "bengaluru":      _KANNADA,
    "mysore":         _KANNADA,
    "mysuru":         _KANNADA,
    "karnataka":      _KANNADA,

    "kochi":          _MALAYALAM,
    "cochin":         _MALAYALAM,
    "trivandrum":     _MALAYALAM,
    "thiruvananthapuram": _MALAYALAM,
    "calicut":        _MALAYALAM,
    "kozhikode":      _MALAYALAM,
    "kerala":         _MALAYALAM,

    "kolkata":        _BENGALI,
    "calcutta":       _BENGALI,
    "west bengal":    _BENGALI,

    "mumbai":         _MARATHI,
    "pune":           _MARATHI,
    "nagpur":         _MARATHI,
    "maharashtra":    _MARATHI,

    "ahmedabad":      _GUJARATI,
    "surat":          _GUJARATI,
    "vadodara":       _GUJARATI,
    "rajkot":         _GUJARATI,
    "gujarat":        _GUJARATI,

    "delhi":          _HINDI,
    "new delhi":      _HINDI,
    "lucknow":        _HINDI,
    "jaipur":         _HINDI,
    "bhopal":         _HINDI,
    "chandigarh":     _HINDI,
    "noida":          _HINDI,
    "gurgaon":        _HINDI,
    "gurugram":       _HINDI,
    "patna":          _HINDI,
    "varanasi":       _HINDI,
    "indore":         _HINDI,
    "uttar pradesh":  _HINDI,
    "rajasthan":      _HINDI,
    "madhya pradesh": _HINDI,
    "bihar":          _HINDI,
    "haryana":        _HINDI,
    "uttarakhand":    _HINDI,
    "jharkhand":      _HINDI,
    "chhattisgarh":   _HINDI,

    # India (generic) → Hindi
    "india":          _HINDI,

    # ── USA / English-speaking ──
    "usa":            _ENGLISH_US,
    "united states":  _ENGLISH_US,
    "san francisco":  _ENGLISH_US,
    "new york":       _ENGLISH_US,
    "los angeles":    _ENGLISH_US,
    "chicago":        _ENGLISH_US,
    "houston":        _ENGLISH_US,
    "seattle":        _ENGLISH_US,
    "austin":         _ENGLISH_US,
    "boston":          _ENGLISH_US,
    "san jose":       _ENGLISH_US,
    "denver":         _ENGLISH_US,
    "miami":          _ENGLISH_US,
    "dallas":         _ENGLISH_US,
    "atlanta":        _ENGLISH_US,
    "california":     _ENGLISH_US,
    "texas":          _ENGLISH_US,

    # UK
    "uk":             _ENGLISH_UK,
    "united kingdom": _ENGLISH_UK,
    "london":         _ENGLISH_UK,
    "manchester":     _ENGLISH_UK,
    "birmingham":     _ENGLISH_UK,
    "edinburgh":      _ENGLISH_UK,
    "glasgow":        _ENGLISH_UK,
    "england":        _ENGLISH_UK,
    "scotland":       _ENGLISH_UK,

    # Canada / Australia → English US (closest Polly match)
    "canada":         _ENGLISH_US,
    "toronto":        _ENGLISH_US,
    "vancouver":      _ENGLISH_US,
    "montreal":       _ENGLISH_US,
    "australia":      _ENGLISH_US,
    "sydney":         _ENGLISH_US,
    "melbourne":      _ENGLISH_US,

    # Singapore → English (India accent is close for SEA)
    "singapore":      _ENGLISH_IN,

    # ── Europe ──
    "germany":        _GERMAN,
    "berlin":         _GERMAN,
    "munich":         _GERMAN,
    "hamburg":        _GERMAN,
    "frankfurt":      _GERMAN,

    "france":         _FRENCH,
    "paris":          _FRENCH,
    "lyon":           _FRENCH,
    "marseille":      _FRENCH,

    "spain":          _SPANISH,
    "madrid":         _SPANISH,
    "barcelona":      _SPANISH,

    "italy":          _ITALIAN,
    "rome":           _ITALIAN,
    "milan":          _ITALIAN,

    "netherlands":    _DUTCH,
    "amsterdam":      _DUTCH,
    "rotterdam":      _DUTCH,

    "portugal":       _PORTUGUESE_BR,
    "lisbon":         _PORTUGUESE_BR,
    "brazil":         _PORTUGUESE_BR,
    "sao paulo":      _PORTUGUESE_BR,

    # ── Middle East ──
    "uae":            _ARABIC,
    "dubai":          _ARABIC,
    "abu dhabi":      _ARABIC,
    "saudi arabia":   _ARABIC,
    "riyadh":         _ARABIC,
    "qatar":          _ARABIC,
    "doha":           _ARABIC,

    # ── East Asia ──
    "japan":          _JAPANESE,
    "tokyo":          _JAPANESE,
    "osaka":          _JAPANESE,

    "south korea":    _KOREAN,
    "korea":          _KOREAN,
    "seoul":          _KOREAN,

    "china":          _MANDARIN,
    "beijing":        _MANDARIN,
    "shanghai":       _MANDARIN,
    "shenzhen":       _MANDARIN,

    # ── Catch-all ──
    "remote":         _ENGLISH_US,
}


def resolve_language(location: Optional[str]) -> LanguageConfig:
    """
    Resolve a contact's location string to a LanguageConfig.

    Matching strategy:
      1. Exact match (lowercased)
      2. Substring match (location contains a known key)
      3. Fallback to English (US)
    """
    if not location:
        return DEFAULT_LANG

    loc = location.strip().lower()

    # 1. Exact match
    if loc in _LOCATION_MAP:
        logger.info(f"[LanguageService] Exact match: '{location}' → {_LOCATION_MAP[loc].name} ({_LOCATION_MAP[loc].code})")
        return _LOCATION_MAP[loc]

    # 2. Substring match — check if any key is contained in the location string
    for key, config in _LOCATION_MAP.items():
        if key in loc:
            logger.info(f"[LanguageService] Substring match: '{location}' contains '{key}' → {config.name} ({config.code})")
            return config

    # 3. Fallback
    logger.info(f"[LanguageService] No match for '{location}', falling back to English (US)")
    return DEFAULT_LANG


def get_supported_languages() -> list[dict[str, str]]:
    """Return a list of unique supported languages (for reference / UI)."""
    seen = set()
    langs = []
    for cfg in _LOCATION_MAP.values():
        if cfg.code not in seen:
            seen.add(cfg.code)
            langs.append({
                "code": cfg.code,
                "name": cfg.name,
                "voice": cfg.twilio_voice,
            })
    return sorted(langs, key=lambda x: x["name"])
