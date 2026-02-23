"""
Localization Service
===================
Handles multi-language content generation with master English template → per-language translation.
Supports English, Tamil, Hindi, Telugu, Kannada, Malayalam, French, Spanish, German, Japanese, Korean, Chinese.

Strategy:
  1. Generate master English template once (cost-effective, consistent source)
  2. Detect target languages from contact locations
  3. Batch-translate per language (reduces API calls)
  4. Cache translations to avoid re-generating same language content
"""

import asyncio
import json
import logging
from typing import Dict, List, Optional, Any
from datetime import datetime, timedelta

import httpx

from app.core.config import settings
from app.services.language_service import LanguageConfig, resolve_language

logger = logging.getLogger(__name__)

# Translation cache: language_code → {content_type → translated_text}
_translation_cache: Dict[str, Dict[str, str]] = {}
_cache_timestamps: Dict[str, datetime] = {}
CACHE_TTL_HOURS = 24


LANGUAGE_NAMES = {
    "en-US": "English",
    "ta-IN": "Tamil",
    "hi-IN": "Hindi",
    "te-IN": "Telugu",
    "kn-IN": "Kannada",
    "ml-IN": "Malayalam",
    "fr-FR": "French",
    "es-ES": "Spanish",
    "de-DE": "German",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "zh-CN": "Simplified Chinese",
}


async def _call_translation_api(
    text: str,
    source_lang: str = "en",
    target_lang: str = "ta",
) -> Optional[str]:
    """
    Call a translation API. Currently uses Google Translate via free endpoint.
    Can be replaced with paid API (Google Cloud Translation, AWS Translate, etc.).
    """
    if target_lang == "en" or source_lang == target_lang:
        return text  # No translation needed
    
    try:
        # Using free Google Translate endpoint (for development)
        # For production, use: Google Cloud Translation, Azure Translator, or AWS Translate
        url = "https://translate.googleapis.com/translate_a/element.js"
        
        # Alternative: Simple HTTP POST to translation service
        headers = {"User-Agent": "Mozilla/5.0"}
        params = {
            "client": "gtx",
            "sl": source_lang,
            "tl": target_lang,
            "dt": "t",
            "q": text,
        }
        
        async with httpx.AsyncClient(timeout=10) as client:
            # Using public Google Translate API endpoint
            response = await client.get(
                "https://translate.googleapis.com/translate_a/single",
                params=params,
                headers=headers,
            )
            
            if response.status_code == 200:
                try:
                    data = response.json()
                    # Extract translated text from nested structure
                    if isinstance(data, list) and len(data) > 0:
                        translations = data[0]
                        if isinstance(translations, list):
                            translated = "".join([t[0] for t in translations if isinstance(t, list)])
                            logger.info(f"[Localization] Translated {source_lang}→{target_lang}: {len(text)} → {len(translated)} chars")
                            return translated
                except (json.JSONDecodeError, IndexError, TypeError) as e:
                    logger.warning(f"[Localization] Failed to parse translation response: {e}")
                    return None
            else:
                logger.warning(f"[Localization] Translation API returned {response.status_code}")
                return None
                
    except asyncio.TimeoutError:
        logger.warning(f"[Localization] Translation timeout: {source_lang}→{target_lang}")
        return None
    except Exception as exc:
        logger.error(f"[Localization] Translation error: {exc}")
        return None


async def _get_language_code_pair(lang_config: LanguageConfig) -> tuple[str, str]:
    """Convert LanguageConfig to ISO 639-1 codes for translation API."""
    code_map = {
        "en-US": ("en", "en"),
        "ta-IN": ("en", "ta"),
        "hi-IN": ("en", "hi"),
        "te-IN": ("en", "te"),
        "kn-IN": ("en", "kn"),
        "ml-IN": ("en", "ml"),
        "fr-FR": ("en", "fr"),
        "es-ES": ("en", "es"),
        "de-DE": ("en", "de"),
        "ja-JP": ("en", "ja"),
        "ko-KR": ("en", "ko"),
        "zh-CN": ("en", "zh-CN"),
    }
    return code_map.get(lang_config.code, ("en", "en"))


async def translate_content(
    content: str,
    target_lang: LanguageConfig,
    content_type: str = "general",
) -> str:
    """
    Translate content to target language with caching.
    Returns English content if translation fails.
    """
    # Skip if already in English
    if target_lang.code == "en-US":
        return content
    
    # Check cache
    cache_key = target_lang.code
    if cache_key in _translation_cache:
        cache_entry = _cache_timestamps.get(cache_key)
        if cache_entry and datetime.now() - cache_entry < timedelta(hours=CACHE_TTL_HOURS):
            cached = _translation_cache[cache_key].get(content_type)
            if cached:
                logger.info(f"[Localization] Cache hit for {target_lang.code}")
                return cached
    
    # Translate
    source_code, target_code = await _get_language_code_pair(target_lang)
    translated = await _call_translation_api(content, source_code, target_code)
    
    if translated:
        # Cache result
        if cache_key not in _translation_cache:
            _translation_cache[cache_key] = {}
        _translation_cache[cache_key][content_type] = translated
        _cache_timestamps[cache_key] = datetime.now()
        return translated
    
    # Fallback to English
    logger.warning(f"[Localization] Translation failed, returning English content for {target_lang.code}")
    return content


async def batch_translate_contacts(
    contacts: List[Dict[str, Any]],
    content: str,
    content_type: str = "email",
) -> Dict[str, str]:
    """
    Group contacts by language, translate content once per language.
    Returns: {contact_id → translated_content}
    """
    language_groups: Dict[str, List[str]] = {}  # language_code → [contact_ids]
    
    # Group contacts by language
    for contact in contacts:
        location = contact.get("location", "")
        lang = resolve_language(location)
        if lang.code not in language_groups:
            language_groups[lang.code] = []
        language_groups[lang.code].append(contact.get("id", contact.get("email", "")))
    
    # Translate once per language
    translations: Dict[str, str] = {}  # language_code → translated_content
    tasks = [
        translate_content(content, resolve_language(""), content_type)
        for lang_code in language_groups.keys()
    ]
    
    # Execute translations in parallel
    if tasks:
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for (lang_code, contact_ids), result in zip(language_groups.items(), results):
            if isinstance(result, Exception):
                logger.error(f"[Localization] Error translating to {lang_code}: {result}")
                translations[lang_code] = content  # Fallback to English
            else:
                translations[lang_code] = result
    
    # Map translations back to contacts
    contact_translations = {}
    for contact in contacts:
        location = contact.get("location", "")
        lang = resolve_language(location)
        contact_id = contact.get("id", contact.get("email", ""))
        contact_translations[contact_id] = translations.get(lang.code, content)
    
    return contact_translations


def clear_translation_cache(language_code: Optional[str] = None):
    """Clear translation cache for optimization."""
    global _translation_cache, _cache_timestamps
    if language_code:
        _translation_cache.pop(language_code, None)
        _cache_timestamps.pop(language_code, None)
        logger.info(f"[Localization] Cleared cache for {language_code}")
    else:
        _translation_cache.clear()
        _cache_timestamps.clear()
        logger.info("[Localization] Cleared all translation cache")


async def generate_localized_templates(
    master_template: Dict[str, Any],
    target_languages: List[LanguageConfig],
) -> Dict[str, Dict[str, Any]]:
    """
    Generate localized versions of a template for multiple languages.
    Input: master_template = {"subject": "...", "body": "...", "cta": "..."}
    Output: {language_code → localized_template}
    """
    localized = {
        "en-US": master_template,  # English is the master
    }
    
    # Translate each template field
    tasks = []
    for lang in target_languages:
        if lang.code == "en-US":
            continue
        
        lang_templates = {}
        for field, value in master_template.items():
            if isinstance(value, str):
                task = translate_content(value, lang, field)
                tasks.append((lang.code, field, task))
    
    # Execute all translations in parallel
    if tasks:
        results = await asyncio.gather(*[t[2] for t in tasks], return_exceptions=True)
        
        for (lang_code, field, _), result in zip(tasks, results):
            if lang_code not in localized:
                localized[lang_code] = master_template.copy()
            
            if isinstance(result, Exception):
                logger.error(f"[Localization] Error translating {field} to {lang_code}: {result}")
                localized[lang_code][field] = master_template[field]  # Use English
            else:
                localized[lang_code][field] = result
    
    logger.info(f"[Localization] Generated localized templates for {len(localized)} languages")
    return localized
