import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, JSON, ForeignKey, Integer
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base


class VoiceCall(Base):
    __tablename__ = "voice_calls"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False, index=True)
    contact_name = Column(String(255), nullable=True)
    contact_email = Column(String(255), nullable=True, index=True)
    contact_phone = Column(String(50), nullable=True)
    call_sid = Column(String(100), unique=True, nullable=True, index=True)
    status = Column(String(50), default="initiated")
    conversation_log = Column(JSON, nullable=True)
    
    # Session persistence fields
    conversation_state = Column(JSON, nullable=True)  # Save memory state for reconnection
    turn_count = Column(Integer, default=0)  # Track conversation turns
    language_code = Column(String(10), default="en-US")  # Current conversation language
    email_captured = Column(String(255), nullable=True)  # Captured email from call
    email_sent = Column(Integer, default=0)  # Whether follow-up email was sent
    
    # Reliability tracking
    retry_count = Column(Integer, default=0)  # Track retries for failed calls
    duration_seconds = Column(Integer, default=0)  # Call duration
    quality_score = Column(Integer, nullable=True)  # 0-100 call quality metric
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
