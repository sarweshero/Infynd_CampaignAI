"""
Content Safety Filter Service
=============================
Validates and filters generated content for compliance, safety, and brand standards.
Prevents abusive, inappropriate, illegal, or non-compliant content generation.

Features:
  - Pattern-based filtering (regex for common abusive terms)
  - Compliance checks (GDPR, financial disclosures, privacy)
  - Brand guardrails (prohibited topics, tone violations)
  - Safety scoring (0-100 safety confidence)
  - Failure modes (log violations, fail-safe defaults)
"""

import re
import logging
from typing import Dict, List, Tuple, Optional
from enum import Enum

logger = logging.getLogger(__name__)


class SafetyLevel(Enum):
    SAFE = 100
    ACCEPTABLE = 80
    QUESTIONABLE = 50
    UNSAFE = 0


# Patterns for content that should never appear
PROHIBITED_PATTERNS = {
    "abusive": [
        r"\b(damn|hell|crap)\b",  # Mild profanity
        r"\b(f[u\*]ck|sh[i\*]t|wh[o0]re|slut|b[i\*]tch)\b",  # Strong profanity
        r"\b(idiot|moron|stupid|retard)\b",  # Insulting language
    ],
    "inappropriate": [
        r"\b(sex|porn|xxx|adult)\b",  # Sexual content
        r"\b(nude|naked|breast|penis|vagina)\b",  # Explicit body parts
        r"\b(rape|molest|assault)\b",  # Violence/abuse keywords
    ],
    "hateful": [
        r"\b(racist|sexist|homophobic|transphobic)\b",
        r"\b(terrorism|terrorist|extremist)\b",
        r"\b(kill|murder|die)\b",
        r"\b(muslim|jewish|christian|hindu|sikh).*\b(terrorist|threat|bomb)\b",  # Hate speech
    ],
    "illegal": [
        r"\b(cocaine|heroin|meth|marijuana|cannabis)\b",  # Illegal drugs
        r"\b(bomb|explosive|weapon|gun.*sale)\b",  # Weapons/explosives
        r"\b(counterfeit|fake.*product|knockoff)\b",  # Counterfeit goods
    ],
    "financial_fraud": [
        r"\b(guaranteed.*profit|risk-free.*return|make.*million)\b",  # Get-rich-quick
        r"\b(secret.*strategy|hidden.*formula|exclusive.*method)\b",  # Misleading claims
        r"\b(pump.*dump|penny.*stock.*manipulation)\b",  # Market manipulation
    ],
    "gdpr_violation": [
        r"\b(sell.*data|buy.*list|email.*database)\b",  # Data selling
        r"\b(scrape|harvest|collect.*without.*consent)\b",  # Unauthorized collection
    ],
}

# Required compliance disclaimers by country/type
COMPLIANCE_REQUIREMENTS = {
    "financial": [
        "Past performance does not guarantee future results",
        "This is not financial advice",
        "Consult a financial advisor",
    ],
    "medical": [
        "Consult a healthcare professional",
        "Not a substitute for medical advice",
        "See your doctor before use",
    ],
    "legal": [
        "Consult a legal professional",
        "Not legal advice",
        "Always verify with authorities",
    ],
    "promotional": [
        "Terms and conditions apply",
        "Promotional offer valid while supplies last",
    ],
}

# Topics that should be avoided in outreach
PROHIBITED_TOPICS = [
    "cryptocurrency",
    "forex trading",
    "weight loss pills",
    "anti-aging products",
    "get rich quick",
    "gambling",
    "payday loans",
    "timeshare",
    "multi-level marketing",
]

# Tone/style violations
TONE_VIOLATIONS = [
    r"\b(must buy|you need|don't miss out)\b",  # Manipulative urgency
    r"\b(only.*limited time|act now|expires soon)\b",  # Artificial scarcity
    r"\b(all your friends|everyone is|trending now)\b",  # False social proof
]


def _check_prohibited_patterns(text: str) -> List[Tuple[str, str]]:
    """Check text against prohibited patterns. Returns list of (category, match)."""
    violations = []
    text_lower = text.lower()
    
    for category, patterns in PROHIBITED_PATTERNS.items():
        for pattern in patterns:
            matches = re.findall(pattern, text_lower, re.IGNORECASE)
            if matches:
                violations.append((category, matches[0]))
    
    return violations


def _check_prohibited_topics(text: str) -> List[str]:
    """Check if content mentions prohibited topics."""
    text_lower = text.lower()
    found_topics = []
    
    for topic in PROHIBITED_TOPICS:
        if topic.lower() in text_lower:
            found_topics.append(topic)
    
    return found_topics


def _check_tone_violations(text: str) -> List[str]:
    """Check for manipulative tone patterns."""
    violations = []
    
    for pattern in TONE_VIOLATIONS:
        if re.search(pattern, text, re.IGNORECASE):
            violations.append(pattern)
    
    return violations


def _check_compliance_requirements(text: str, content_type: str) -> Tuple[bool, List[str]]:
    """
    Check if content includes required compliance disclaimers.
    Returns (compliant, missing_disclaimers).
    """
    required = COMPLIANCE_REQUIREMENTS.get(content_type, [])
    if not required:
        return True, []
    
    missing = []
    text_lower = text.lower()
    
    for disclaimer in required:
        if disclaimer.lower() not in text_lower:
            missing.append(disclaimer)
    
    return len(missing) == 0, missing


def score_content(
    text: str,
    content_type: str = "email",
) -> Tuple[int, Dict[str, any]]:
    """
    Score content safety (0-100).
    Returns (score, details).
    
    Scoring:
      - Start at 100 (safe)
      - -50 for prohibited pattern match
      - -30 for prohibited topic
      - -20 for tone violation
      - -10 for each missing compliance requirement
    """
    score = 100
    details = {
        "prohibited_patterns": [],
        "prohibited_topics": [],
        "tone_violations": [],
        "missing_requirements": [],
    }
    
    # Check prohibited patterns
    pattern_violations = _check_prohibited_patterns(text)
    if pattern_violations:
        score -= 50 * len(pattern_violations)
        details["prohibited_patterns"] = pattern_violations
    
    # Check prohibited topics
    topics = _check_prohibited_topics(text)
    if topics:
        score -= 30 * len(topics)
        details["prohibited_topics"] = topics
    
    # Check tone violations
    tone_violations = _check_tone_violations(text)
    if tone_violations:
        score -= 20 * len(tone_violations)
        details["tone_violations"] = tone_violations
    
    # Check compliance
    compliant, missing = _check_compliance_requirements(text, content_type)
    if not compliant:
        score -= 10 * len(missing)
        details["missing_requirements"] = missing
    
    # Clamp score to 0-100
    score = max(0, min(100, score))
    
    return score, details


def is_safe_content(text: str, content_type: str = "email", min_score: int = 70) -> bool:
    """Check if content meets safety threshold (default 70/100)."""
    score, _ = score_content(text, content_type)
    return score >= min_score


def filter_content(text: str, content_type: str = "email") -> str:
    """
    Attempt to filter/sanitize content by removing/replacing violations.
    If too many violations, returns empty string (fail-safe).
    """
    score, details = score_content(text, content_type)
    
    if score >= 70:
        return text  # Safe to return as-is
    
    filtered = text
    
    # Remove prohibited patterns
    for category, matches in details.get("prohibited_patterns", []):
        for match in set([m[0] if isinstance(m, tuple) else m for m in matches]):
            filtered = filtered.replace(match, "[removed]")
    
    # Add required compliance if missing
    missing_reqs = details.get("missing_requirements", [])
    if missing_reqs:
        disclaimer = "\n\n" + " | ".join(missing_reqs)
        filtered += disclaimer
    
    # Re-score after filtering
    new_score, _ = score_content(filtered, content_type)
    logger.warning(
        f"[SafetyFilter] Content filtered: {score} → {new_score} (type={content_type})"
    )
    
    if new_score < 50:
        logger.error(
            f"[SafetyFilter] Content unsafe even after filtering. "
            f"Details: {details}"
        )
        return ""  # Fail-safe: return empty
    
    return filtered


def validate_email_template(
    subject: str,
    body: str,
    html_body: str = "",
) -> Tuple[bool, List[str]]:
    """
    Validate complete email template.
    Returns (is_valid, error_messages).
    """
    errors = []
    
    # Check subject
    if not subject or len(subject) < 5:
        errors.append("Email subject too short or empty")
    elif not is_safe_content(subject, "email"):
        score, details = score_content(subject, "email")
        errors.append(f"Subject line unsafe (score {score}): {details}")
    
    # Check body
    if not body or len(body) < 20:
        errors.append("Email body too short or empty")
    elif not is_safe_content(body, "email"):
        score, details = score_content(body, "email")
        errors.append(f"Email body unsafe (score {score}): {details}")
    
    # Check HTML
    if html_body and not is_safe_content(html_body, "email"):
        score, details = score_content(html_body, "email")
        errors.append(f"HTML body unsafe (score {score}): {details}")
    
    return len(errors) == 0, errors


def validate_call_script(script: str) -> Tuple[bool, List[str]]:
    """Validate voice call script for safety and tone."""
    errors = []
    
    if not script or len(script) < 20:
        errors.append("Call script too short")
    elif not is_safe_content(script, "call"):
        score, details = score_content(script, "call")
        errors.append(f"Call script unsafe (score {score}): {details}")
    
    # Check for natural tone
    if re.search(r"\[.*\]", script):
        errors.append("Call script contains bracketed instructions — should sound natural")
    
    return len(errors) == 0, errors


def log_safety_violation(violation_type: str, content: str, details: Dict):
    """
    Log safety violations for audit/monitoring.
    Useful for flagging patterns and improving filter.
    """
    logger.warning(
        f"[SafetyFilter] Violation: {violation_type}\n"
        f"Content: {content[:100]}...\n"
        f"Details: {details}"
    )


# Audit log for monitoring
def enable_audit_logging(enabled: bool = True):
    """Enable/disable detailed audit logging."""
    if enabled:
        logger.setLevel(logging.DEBUG)
    else:
        logger.setLevel(logging.WARNING)
