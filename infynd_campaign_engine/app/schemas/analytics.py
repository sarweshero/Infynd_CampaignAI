from __future__ import annotations

import uuid
from typing import Dict, Any, Optional

from pydantic import BaseModel


class ChannelBreakdown(BaseModel):
    channel: str
    sent: int
    opened: int
    clicked: int
    answered: int
    conversion_count: int


class CampaignAnalytics(BaseModel):
    campaign_id: uuid.UUID
    total_contacts: int
    sent: int
    opened: int
    clicked: int
    answered: int
    conversion_rate: float
    open_rate: float
    click_rate: float
    breakdown_by_channel: list[ChannelBreakdown]
