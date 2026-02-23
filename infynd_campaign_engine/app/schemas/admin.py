from datetime import datetime
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


# ── Create User ───────────────────────────────────────────────────────────────
class AdminCreateUserRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)
    full_name: Optional[str] = None
    role: str = "VIEWER"
    company: Optional[str] = None


# ── Update User ───────────────────────────────────────────────────────────────
class AdminUpdateUserRequest(BaseModel):
    role: Optional[str] = None
    full_name: Optional[str] = None
    company: Optional[str] = None
    is_active: Optional[bool] = None


# ── Response schemas ──────────────────────────────────────────────────────────
class AdminUserResponse(BaseModel):
    id: UUID
    email: str
    full_name: Optional[str]
    role: str
    company: Optional[str]
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class AdminUserListResponse(BaseModel):
    users: List[AdminUserResponse]
    total: int
