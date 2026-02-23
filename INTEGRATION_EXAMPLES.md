# Integration Examples - How to Use New Services

## 1. Using Localization Service

### Basic Translation
```python
from app.services.localization_service import translate_content
from app.services.language_service import resolve_language, LanguageConfig

# Translate content to Tamil
tamil = LanguageConfig(code="ta-IN", name="Tamil", ...)
translated = await translate_content(
    content="We have an exciting opportunity for your organization.",
    target_lang=tamil,
    content_type="email"
)
# Returns: "உங்கள் நிறுவனத்திற்கு எங்களிடம் ஒரு சிறந்த வாய்ப்பு உள்ளது."
```

### Batch Translation for Campaign
```python
from app.services.localization_service import batch_translate_contacts

contacts = [
    {"id": "1", "email": "user1@example.com", "location": "Chennai"},  # Tamil
    {"id": "2", "email": "user2@example.com", "location": "Mumbai"},   # Hindi
    {"id": "3", "email": "user3@example.com", "location": "Delhi"},    # Hindi
]

email_body = "We have an exciting opportunity..."

translations = await batch_translate_contacts(
    contacts=contacts,
    content=email_body,
    content_type="email"
)

# Result:
# {
#   "1": "உங்கள் நிறுவனத்திற்கு...",  (Tamil)
#   "2": "आपके संगठन के लिए...",       (Hindi)
#   "3": "आपके संगठन के लिए...",       (Hindi - from cache)
# }
```

### Generate Localized Email Templates
```python
from app.services.localization_service import generate_localized_templates

master_template = {
    "subject": "Exciting Opportunity for Your Business",
    "body": "We have an exciting opportunity...",
    "cta": "Let's talk about this opportunity",
}

target_languages = [
    LanguageConfig(code="ta-IN", ...),
    LanguageConfig(code="hi-IN", ...),
    LanguageConfig(code="es-ES", ...),
]

localized = await generate_localized_templates(
    master_template=master_template,
    target_languages=target_languages,
)

# Result:
# {
#   "en-US": {master template},
#   "ta-IN": {translated template},
#   "hi-IN": {translated template},
#   "es-ES": {translated template},
# }
```

---

## 2. Using Content Safety Filter

### Score Content
```python
from app.services.safety_filter import score_content, is_safe_content

email_body = "We have an exciting opportunity for your organization..."

score, details = score_content(email_body, content_type="email")

print(f"Safety Score: {score}/100")
print(f"Violations: {details}")

# Result:
# Safety Score: 95/100
# Violations: {'prohibited_patterns': [], 'prohibited_topics': [], ...}
```

### Validate Email Template
```python
from app.services.safety_filter import validate_email_template

subject = "Exciting Opportunity"
body = "We have an opportunity for you..."
html = "<p>We have an opportunity...</p>"

is_valid, errors = validate_email_template(subject, body, html)

if is_valid:
    print("✓ Email is safe to send")
else:
    print(f"✗ Validation errors: {errors}")
    # Don't send if not valid
```

### Filter Unsafe Content
```python
from app.services.safety_filter import filter_content, log_safety_violation

unsafe_email = """
Buy our miracle weight loss pills now!
Guaranteed to lose 50 pounds in 30 days.
This is not a scam, 100% authentic.
"""

filtered = filter_content(unsafe_email, content_type="email")

if not filtered:
    # Content too unsafe even after filtering
    log_safety_violation(
        violation_type="weight_loss_product",
        content=unsafe_email,
        details={"found_prohibited_topics": ["weight loss pills"]}
    )
    # Don't send this email
else:
    print("Filtered content:", filtered)
```

### Validate Voice Script
```python
from app.services.safety_filter import validate_call_script

script = "Hello, this is a call about an exciting opportunity for your business..."

is_valid, errors = validate_call_script(script)

if is_valid:
    print("✓ Script sounds natural and is safe")
else:
    print(f"✗ Issues: {errors}")
```

---

## 3. Using Voice Call Session Persistence

### Save Conversation State
```python
from app.services.voice_agent import save_conversation_to_db

# Called at the end of a call or on error
await save_conversation_to_db(
    call_sid="CA1234567890abcdef",
    campaign_id="550e8400-e29b-41d4-a716-446655440000"
)

# Saves to database:
# {
#   "conversation_state": {
#     "contact": {...},
#     "language": "ta-IN",
#     "turn_count": 5,
#     "awaiting_email": false,
#     "email_sent": true,
#     "pending_email": "user@example.com",
#     ...
#   },
#   "conversation_log": [...],  # All turns
#   "turn_count": 5,
#   "language_code": "ta-IN",
#   "email_captured": "user@example.com",
#   "email_sent": 1,
#   "retry_count": 0,
#   "duration_seconds": 245,
#   "quality_score": 92,
#   ...
# }
```

### Restore Conversation After Interrupt
```python
from app.services.voice_agent import restore_conversation_from_db

# Called when Twilio tries to reconnect a dropped call
restored_state = await restore_conversation_from_db(
    call_sid="CA1234567890abcdef"
)

if restored_state:
    print("✓ Conversation restored, continuing from turn", restored_state["turn_count"])
    # Recreate memory from persisted state
    create_conversation(
        call_sid=call_sid,
        contact=restored_state["contact"],
        campaign_context=...,
        campaign_id=restored_state["campaign_id"],
    )
else:
    print("✗ No saved conversation, starting fresh")
```

---

## 4. Using Retry Logic

### Automatic LLM Retry
```python
# In generate_voice_reply():
reply = await _ask_ollama(prompt)

# Internally retries with exponential backoff:
# Attempt 1: Timeout → wait 0.3s → retry
# Attempt 2: Timeout → wait 0.6s → retry
# Attempt 3: Failed → log error, return ""

# Benefits: Handles temporary Ollama failures gracefully
```

### Automatic Email Retry
```python
from app.services.sendgrid_service import send_email

# Calling send_email automatically retries:
msg_id = await send_email(
    to_email="user@example.com",
    subject="Important Update",
    html_body="<p>We have an opportunity...</p>",
    campaign_id="550e8400-e29b-41d4-a716-446655440000"
)

# Internally:
# Attempt 1: Service unavailable (500) → wait 0.3s → retry
# Attempt 2: Service unavailable (500) → wait 0.6s → retry
# Attempt 3: Failed → log error, return None

# 4xx errors (bad email, auth fails) don't retry
```

---

## 5. Frontend Integration Examples

### Display Voice Call Monitor
```tsx
'use client';
import { useState } from 'react';
import VoiceCallMonitor from '@/app/components/VoiceCallMonitor';

export default function CampaignDetail() {
  const [monitorOpen, setMonitorOpen] = useState(false);

  const handleCallContacts = async () => {
    // Start calls
    setMonitorOpen(true);
    
    // API call to initiate calls
    const result = await fetch(`/api/v1/campaigns/${id}/call-contacts`, {
      method: 'POST',
    });
  };

  return (
    <>
      <button onClick={handleCallContacts} className="btn btn-primary">
        📞 Call Contacts
      </button>

      <VoiceCallMonitor
        campaignId={campaignId}
        isOpen={monitorOpen}
        onClose={() => setMonitorOpen(false)}
      />
    </>
  );
}
```

### Display Voice Settings
```tsx
'use client';
import VoiceSettings from '@/app/components/VoiceSettings';

export default function CampaignEdit() {
  const handleVoiceSettingsSave = async (config) => {
    const response = await fetch(
      `/api/v1/campaigns/${campaignId}/voice-config`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      }
    );
    return response.json();
  };

  return (
    <VoiceSettings
      campaignId={campaignId}
      onSave={handleVoiceSettingsSave}
    />
  );
}
```

---

## 6. Content Generation Safety Pipeline

### Complete Safe Email Generation
```python
from app.agents.content_generator_agent import generate_email
from app.services.safety_filter import validate_email_template, filter_content

# Step 1: Generate email content
email_data = await generate_email(
    recipient_name="John Smith",
    company_name="Acme Corp",
    personalization_data={...},
    campaign_context="Lead generation for enterprise software",
)

# Step 2: Validate safety
is_valid, errors = validate_email_template(
    subject=email_data["subject"],
    body=email_data["body"],
    html_body=email_data["html"],
)

if not is_valid:
    print("❌ Email failed safety validation:")
    for error in errors:
        print(f"  - {error}")
    # Don't send
    return

# Step 3: Store in database
campaign.generated_content = {
    "common": {
        "Email": {
            "subject": email_data["subject"],
            "body": email_data["body"],
            "html": email_data["html"],
        }
    }
}

# Step 4: Ready to send
print("✅ Email approved and ready to send")
```

---

## 7. Complete Voice Call Flow with All Enhancements

```python
# 1. Initialize call with session tracking
call = await initiate_call(
    to_number="+1234567890",
    contact={
        "name": "John Smith",
        "email": "john@example.com",
        "location": "Chennai",  # Auto-detect language: Tamil
    },
    campaign_context="Q4 Lead Generation",
    campaign_id=campaign_id,
)

# 2. Twilio answer webhook
# → LLM generates response (with retry logic)
# → Translate to Tamil if needed (with cache)
# → Return TwiML with voice output

# 3. User responds, transcribed by Twilio
# → Call generate_voice_reply()
#   → Retry LLM on timeout (exponential backoff)
#   → Check for email capture
#   → Spell confirmation
#   → Send follow-up email (retry policy)
#   → Save contact email to database
#   → Save conversation state

# 4. Call ends after MAX_TURNS
# → save_conversation_to_db() persists:
#   - Turn history
#   - Language switches
#   - Email captured
#   - Quality metrics
#   - Duration

# 5. Frontend displays in VoiceCallMonitor:
# - Call status: "completed" ✓
# - Duration: "3m 45s"
# - Email captured: "john@example.com"
# - Email sent: "✓"
# - Quality score: "92/100"
# - Language: "ta-IN (Tamil)"
```

---

## Database Queries

### Get All Calls for Campaign with Stats
```python
from sqlalchemy import func, select
from app.models.voice import VoiceCall

# Get campaign call stats
result = await db.execute(
    select(
        func.count(VoiceCall.id).label("total"),
        func.count(
            case((VoiceCall.status == "completed", VoiceCall.id))
        ).label("completed"),
        func.count(
            case((VoiceCall.status == "failed", VoiceCall.id))
        ).label("failed"),
        func.avg(VoiceCall.duration_seconds).label("avg_duration"),
        func.count(
            case((VoiceCall.email_sent == 1, VoiceCall.id))
        ).label("emails_sent"),
    ).where(VoiceCall.campaign_id == campaign_id)
)

stats = result.one()
# Returns: (total=45, completed=40, failed=2, avg_duration=187, emails_sent=38)
```

### Get Call Quality Trends
```python
# Get calls with quality scores
result = await db.execute(
    select(VoiceCall)
    .where(VoiceCall.campaign_id == campaign_id)
    .where(VoiceCall.quality_score != None)
    .order_by(VoiceCall.updated_at.desc())
    .limit(20)
)

calls = result.scalars().all()
avg_quality = sum(c.quality_score for c in calls) / len(calls)
print(f"Average call quality: {avg_quality:.1f}/100")
```

---

## Configuration Examples

### .env file settings
```env
# Localization
TRANSLATION_API_PROVIDER=google          # google, azure, aws
CACHE_TTL_HOURS=24

# Retries
LLM_TIMEOUT_SECONDS=10
SENDGRID_MAX_RETRIES=2
SENDGRID_TIMEOUT=30
MAX_RETRIES=2

# Timeouts
CALL_TIMEOUT_SECONDS=45
TWILIO_GATHER_TIMEOUT=8

# CallSafety
CONTENT_SAFETY_MIN_SCORE=70              # Reject scores below this
ENABLE_CONTENT_AUDIT_LOGGING=true        # Log all violations

# Voice
OLLAMA_MODEL=neural-voice
TWILIO_FROM_NUMBER=+1234567890
```

---

## Monitoring & Debugging

### Check Service Health
```python
# Check if localization cache is working
from app.services.localization_service import _translation_cache

print(f"Cached languages: {list(_translation_cache.keys())}")
print(f"Cache size: {len(_translation_cache)} entries")

# Check safety violations
from app.services.safety_filter import log_safety_violation

# All violations logged with:
# [SafetyFilter] Violation: <type>
# Content: <preview>
# Details: <categories>

# Check call quality
result = await db.execute(
    select(func.avg(VoiceCall.quality_score)).where(
        VoiceCall.campaign_id == campaign_id
    )
)
avg_score = result.scalar()
print(f"Campaign average call quality: {avg_score:.1f}/100")
```

---

## Troubleshooting

| Issue | Root Cause | Solution |
|-------|-----------|----------|
| Translation taking too long | API rate limit | Clear cache: `clear_translation_cache()` |
| Email not sending | Network timeout | Already retried 2x, check logs for persistent error |
| Call drops mid-conversation | Network interrupt | Session restored from DB, continue from last turn |
| Content flagged as unsafe | Prohibited pattern match | Review safety_filter.py patterns, adjust if false positive |
| LLM not responding | Ollama offline | Check Ollama service, already retried 2x |

---

Done! All enhancements fully integrated and documented. 🎉
