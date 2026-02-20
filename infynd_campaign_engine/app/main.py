import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.database import init_db
from app.services.logging_service import configure_logging

# API routers
from app.api.auth import router as auth_router
from app.api.campaigns import router as campaign_router
from app.api.analytics import router as analytics_router
from app.api.tracking import router as tracking_router
from app.api.websocket import router as ws_router
from app.api.voice import router as voice_router

configure_logging("DEBUG" if settings.DEBUG else "INFO")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"[Startup] {settings.APP_NAME} initializing...")
    await init_db()
    logger.info("[Startup] Database connection verified")
    yield
    logger.info("[Shutdown] Application shutting down")


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

PREFIX = settings.API_V1_PREFIX

# ─── CORS ─────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Routers ──────────────────────────────────────────────────────────────────
# Public routes (no auth required)
app.include_router(auth_router, prefix=PREFIX)
app.include_router(tracking_router, prefix=PREFIX)  # sendgrid webhook is public

# Protected routes
app.include_router(campaign_router, prefix=PREFIX)
app.include_router(analytics_router, prefix=PREFIX)

# WebSocket
app.include_router(ws_router, prefix=PREFIX)

# Voice (Twilio calling)
app.include_router(voice_router, prefix=PREFIX)


# ─── Global Exception Handlers ────────────────────────────────────────────────
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    return JSONResponse(
        status_code=422,
        content={
            "detail": "Validation error",
            "code": "VALIDATION_ERROR",
            "errors": errors,
        },
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.error(f"[UnhandledException] {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "code": "INTERNAL_ERROR"},
    )


# ─── Health Check ─────────────────────────────────────────────────────────────
@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok", "service": settings.APP_NAME}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)