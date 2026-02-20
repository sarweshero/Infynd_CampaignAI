from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional, Dict, Any

from pydantic import BaseModel


class PipelineRunResponse(BaseModel):
    id: uuid.UUID
    campaign_id: uuid.UUID
    state: str
    classification_summary: Optional[Dict[str, Any]]
    downstream_results: Optional[Dict[str, Any]]
    started_at: datetime
    completed_at: Optional[datetime]
    error_message: Optional[str]

    class Config:
        from_attributes = True


class ClassificationFilters(BaseModel):
    role: Optional[str] = None
    location: Optional[str] = None
    category: Optional[str] = None
    company: Optional[str] = None
