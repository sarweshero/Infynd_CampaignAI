from typing import Optional

from pydantic import BaseModel, EmailStr, Field


# ── Registration ──────────────────────────────────────────────────────────────
class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)
    full_name: Optional[str] = None
    company: str = Field(..., min_length=2, max_length=255)


class RegisterResponse(BaseModel):
    id: str
    email: str
    full_name: Optional[str]
    role: str
    company: Optional[str]
    message: str = "Company registered successfully"


# ── Login ─────────────────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    email: str = ""
    role: str = "VIEWER"
    company: Optional[str] = None


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenData(BaseModel):
    email: str
    role: str


# ── Profile ───────────────────────────────────────────────────────────────────
class ProfileResponse(BaseModel):
    id: str
    email: str
    full_name: Optional[str]
    role: str
    is_active: bool


class ProfileUpdateRequest(BaseModel):
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=6, max_length=128)
