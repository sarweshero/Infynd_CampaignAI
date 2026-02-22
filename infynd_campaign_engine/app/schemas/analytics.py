from __future__ import annotations

import uuid
from typing import Optional

from pydantic import BaseModel


class ChannelBreakdown(BaseModel):
    channel: str
    sent: int
    delivered: int = 0
    opened: int
    clicked: int
    answered: int
    bounced: int = 0
    busy: int = 0
    no_answer: int = 0
    conversion_count: int


class HourlyActivity(BaseModel):
    hour: str      # ISO datetime string (UTC) for the hour slot
    count: int     # total engagement events (excluding SENT) in that hour


class TopContact(BaseModel):
    email: str
    events: int
    latest_event_type: Optional[str] = None


class CampaignAnalytics(BaseModel):
    campaign_id: uuid.UUID
    total_contacts: int
    sent: int
    delivered: int = 0
    opened: int
    clicked: int
    answered: int
    bounced: int = 0
    busy: int = 0
    no_answer: int = 0
    # Rates (%)
    conversion_rate: float
    open_rate: float
    click_rate: float
    delivery_rate: float = 0.0
    answer_rate: float = 0.0          # calls answered / calls dialed
    reach_rate: float = 0.0           # contacts actually reached / total contacts
    click_to_open_rate: float = 0.0   # email engagement quality
    # Call performance
    avg_call_duration_seconds: float = 0.0
    # Time distribution
    hourly_activity: list[HourlyActivity] = []
    # Top contacts for follow-up
    top_engaged_contacts: list[TopContact] = []
    # Per-channel breakdown
    breakdown_by_channel: list[ChannelBreakdown]
