import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.dependencies import require_roles, TokenData
from app.core.security import hash_password
from app.models.user import User
from app.schemas.admin import (
    AdminCreateUserRequest,
    AdminUpdateUserRequest,
    AdminUserListResponse,
    AdminUserResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["Admin"])

# All admin routes require the ADMIN role
_admin = require_roles(["ADMIN"])


# ── LIST USERS ────────────────────────────────────────────────────────────────
@router.get("/users", response_model=AdminUserListResponse)
async def list_users(
    current_user: TokenData = Depends(_admin),
    db: AsyncSession = Depends(get_db),
):
    """Return all registered users. ADMIN only."""
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    users = result.scalars().all()
    return AdminUserListResponse(
        users=[AdminUserResponse.model_validate(u) for u in users],
        total=len(users),
    )


# ── CREATE USER ───────────────────────────────────────────────────────────────
@router.post("/users", response_model=AdminUserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: AdminCreateUserRequest,
    current_user: TokenData = Depends(_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a new user with a specific role. ADMIN only."""
    # Reject unknown roles
    valid_roles = {"ADMIN", "MANAGER", "VIEWER"}
    if payload.role not in valid_roles:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid role '{payload.role}'. Must be one of {sorted(valid_roles)}",
        )

    # Email uniqueness check
    result = await db.execute(select(User).where(User.email == payload.email))
    if result.scalars().first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with this email already exists",
        )

    user = User(
        email=payload.email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
        role=payload.role,
        company=payload.company,
        is_active=True,
    )
    db.add(user)
    await db.flush()

    logger.info(f"[Admin] Created user {user.email} (role={user.role}) by {current_user.email}")
    return AdminUserResponse.model_validate(user)


# ── UPDATE USER ───────────────────────────────────────────────────────────────
@router.patch("/users/{user_id}", response_model=AdminUserResponse)
async def update_user(
    user_id: str,
    payload: AdminUpdateUserRequest,
    current_user: TokenData = Depends(_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update a user's role, name, company, or active status. ADMIN only."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if payload.role is not None:
        valid_roles = {"ADMIN", "MANAGER", "VIEWER"}
        if payload.role not in valid_roles:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid role '{payload.role}'. Must be one of {sorted(valid_roles)}",
            )
        user.role = payload.role

    if payload.full_name is not None:
        user.full_name = payload.full_name

    if payload.company is not None:
        user.company = payload.company

    if payload.is_active is not None:
        # Prevent admin from deactivating their own account
        if not payload.is_active and user.email == current_user.email:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot deactivate your own account",
            )
        user.is_active = payload.is_active

    logger.info(f"[Admin] Updated user {user.email} by {current_user.email}")
    return AdminUserResponse.model_validate(user)


# ── DELETE USER ───────────────────────────────────────────────────────────────
@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: str,
    current_user: TokenData = Depends(_admin),
    db: AsyncSession = Depends(get_db),
):
    """Permanently delete a user. ADMIN only."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalars().first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if user.email == current_user.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete your own account",
        )

    await db.delete(user)
    logger.info(f"[Admin] Deleted user {user.email} by {current_user.email}")
