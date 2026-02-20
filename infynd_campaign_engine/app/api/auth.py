import logging

from fastapi import APIRouter, HTTPException, status

from app.core.security import create_access_token, create_refresh_token, decode_token
from app.schemas.auth import LoginRequest, TokenResponse, RefreshRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest):
    """
    Authenticate and return JWT access + refresh tokens.
    In production, validate credentials against the users table.
    """
    # TODO: replace with actual DB user lookup + password verification
    # For now: accept any well-formed email and assign role based on domain
    role = "ADMIN" if payload.email.endswith("@infynd.com") else "VIEWER"

    token_data = {"email": payload.email, "role": role}
    access_token = create_access_token(token_data)
    refresh_token = create_refresh_token(token_data)

    logger.info(f"[Auth] Login: {payload.email} → role={role}")
    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(payload: RefreshRequest):
    """Exchange a valid refresh token for a new access token."""
    try:
        data = decode_token(payload.refresh_token)
        if data.get("type") != "refresh":
            raise ValueError("Not a refresh token")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"detail": str(exc), "code": "INVALID_REFRESH_TOKEN"},
        )

    token_data = {"email": data["email"], "role": data.get("role", "VIEWER")}
    new_access = create_access_token(token_data)
    new_refresh = create_refresh_token(token_data)
    return TokenResponse(access_token=new_access, refresh_token=new_refresh)
