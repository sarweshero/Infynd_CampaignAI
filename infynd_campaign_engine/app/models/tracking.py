import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, DateTime, JSON, ForeignKey, BigInteger, Float
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base


class OutboundMessage(Base):
    __tablename__ = "outbound_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey("campaigns.id"), nullable=False, index=True)
    contact_email = Column(String(255), nullable=False, index=True)
    channel = Column(String(50), nullable=False)
    message_payload = Column(Text, nullable=True)
    send_status = Column(String(50), default="PENDING")
    provider_message_id = Column(String(255), nullable=True, index=True)
    sent_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class EmailTrackingEvent(Base):
    __tablename__ = "email_tracking_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    contact_email = Column(String(255), nullable=False, index=True)
    event_type = Column(String(50), nullable=False)
    message_id = Column(String(255), nullable=True)
    event_at = Column(BigInteger, nullable=True)
    raw_payload = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class EngagementHistory(Base):
    __tablename__ = "engagement_history"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey("campaigns.id"), nullable=False, index=True)
    contact_email = Column(String(255), nullable=False, index=True)
    channel = Column(String(50), nullable=False)
    event_type = Column(String(50), nullable=False)
    payload = Column(JSON, nullable=True)
    occurred_at = Column(DateTime, default=datetime.utcnow)


class ConversionEvent(Base):
    __tablename__ = "conversion_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey("campaigns.id"), nullable=False, index=True)
    contact_email = Column(String(255), nullable=False, index=True)
    event_type = Column(String(100), nullable=False)
    value = Column(Float, nullable=True)
    metadata_ = Column("metadata", JSON, nullable=True)
    occurred_at = Column(DateTime, default=datetime.utcnow)
