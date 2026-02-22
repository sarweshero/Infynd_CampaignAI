from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional, Dict, Any, List

from pydantic import BaseModel, Field


class CampaignCreate(BaseModel):
    prompt:                str = Field(..., min_length=5, description="Free-text campaign intent")
    product_link:          Optional[str] = None
    auto_approve_content:  bool = False   # False = user reviews via WS; True = auto-dispatch


class CampaignResponse(BaseModel):
    id:                  uuid.UUID
    name:                str
    company:             Optional[str]
    campaign_purpose:    Optional[str]
    target_audience:     Optional[str]
    product_link:        Optional[str]
    prompt:              Optional[str]
    platform:            Optional[str]
    pipeline_state:      str
    approval_status:     str
    approval_required:   bool
    auto_approve_content: bool
    approved_by:         Optional[str]
    approved_at:         Optional[datetime]
    created_by:          Optional[str]
    created_at:          datetime
    generated_content:   Optional[Dict[str, Any]]

    class Config:
        from_attributes = True

    @classmethod
    def from_orm_campaign(cls, c: Any) -> "CampaignResponse":
        """Map DB model to response, computing auto_approve_content."""
        data = {k: getattr(c, k, None) for k in cls.model_fields}
        data["auto_approve_content"] = not c.approval_required
        return cls(**data)


class ContentEditRequest(BaseModel):
    content: Dict[str, Any]


class ApprovalAction(BaseModel):
    action: str  # approve | approve_all | edit | regenerate
    contact_email: Optional[str] = None
    edited_content: Optional[Dict[str, Any]] = None


class LogEntry(BaseModel):
    id:            uuid.UUID
    agent_name:    str
    status:        str
    started_at:    datetime
    completed_at:  Optional[datetime]
    duration_ms:   Optional[int]
    error_message: Optional[str]

    class Config:
        from_attributes = True


class MessageEntry(BaseModel):
    id:                  uuid.UUID
    contact_email:       str
    channel:             str
    send_status:         str
    provider_message_id: Optional[str]
    sent_at:             Optional[datetime]
    latest_event:        Optional[str] = None
    event_payload:       Optional[dict] = None

    class Config:
        from_attributes = True


class ErrorResponse(BaseModel):
    detail: str
    code: str
