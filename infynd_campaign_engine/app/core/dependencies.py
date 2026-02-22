from typing import List

from fastapi import Depends, HTTPException, status, WebSocket
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.core.security import decode_token

bearer_scheme = HTTPBearer()


class TokenData:
    def __init__(self, email: str, role: str, user_id: str = None):
        self.email = email
        self.role = role
        self.user_id = user_id


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> TokenData:
    token = credentials.credentials
    try:
        payload = decode_token(token)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    email = payload.get("email")
    role = payload.get("role", "VIEWER")
    user_id = payload.get("user_id")
    if not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing required claims",
        )
    return TokenData(email=email, role=role, user_id=user_id)


def require_roles(allowed_roles: List[str]):
    def _check(current_user: TokenData = Depends(get_current_user)) -> TokenData:
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"detail": "Insufficient permissions", "code": "FORBIDDEN"},
            )
        return current_user
    return _check


async def get_ws_user(websocket: WebSocket) -> TokenData:
    """Authenticate WebSocket via token query param."""
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001)
        raise HTTPException(status_code=401, detail="Missing WebSocket token")
    try:
        payload = decode_token(token)
    except ValueError:
        await websocket.close(code=4001)
        raise HTTPException(status_code=401, detail="Invalid WebSocket token")
    return TokenData(
        email=payload.get("email"),
        role=payload.get("role", "VIEWER"),
        user_id=payload.get("user_id"),
    )
