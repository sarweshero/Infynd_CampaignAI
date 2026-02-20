import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Column, String, Text, Boolean, DateTime, JSON, Enum as SAEnum
)
from sqlalchemy.dialects.postgresql import UUID
import enum

from app.core.database import Base


class PipelineState(str, enum.Enum):
    CREATED = "CREATED"
    CLASSIFIED = "CLASSIFIED"
    CONTACTS_RETRIEVED = "CONTACTS_RETRIEVED"
    CHANNEL_DECIDED = "CHANNEL_DECIDED"
    CONTENT_GENERATED = "CONTENT_GENERATED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    DISPATCHED = "DISPATCHED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class Campaign(Base):
    __tablename__ = "campaigns"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    company = Column(String(255))
    campaign_purpose = Column(Text)
    target_audience = Column(Text)
    product_link = Column(Text)
    prompt = Column(Text)
    platform = Column(String(50))
    approval_required = Column(Boolean, default=True)
    pipeline_locked = Column(Boolean, default=False)

    pipeline_state = Column(
        SAEnum(PipelineState, name="pipeline_state_enum"),
        default=PipelineState.CREATED,
        nullable=False,
    )

    generated_content = Column(JSON, nullable=True)

    approval_status = Column(String(50), default="PENDING")
    approved_at = Column(DateTime, nullable=True)
    approved_by = Column(String(255), nullable=True)

    created_by = Column(String(255))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
