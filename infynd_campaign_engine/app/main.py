import logging
import time
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


# ─────────────────────────────────────────────────────────────
# GLOBAL LOGGING CONFIGURATION
# ─────────────────────────────────────────────────────────────
configure_logging("DEBUG" if settings.DEBUG else "INFO")

logger = logging.getLogger("app")


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


# ─────────────────────────────────────────────────────────────
# REQUEST LOGGING MIDDLEWARE (PRINTS EVERYTHING)
# ─────────────────────────────────────────────────────────────
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()

    logger.info(
        f"[REQUEST] {request.client.host} "
        f"{request.method} {request.url.path}"
    )

    try:
        response = await call_next(request)
    except Exception as e:
        logger.exception(
            f"[EXCEPTION] {request.method} {request.url.path} -> {str(e)}"
        )
        raise

    process_time = round((time.time() - start_time) * 1000, 2)

    logger.info(
        f"[RESPONSE] {request.method} {request.url.path} "
        f"Status: {response.status_code} "
        f"Time: {process_time}ms"
    )

    return response


# ─────────────────────────────────────────────────────────────
# CORS
# ─────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────
# ROUTERS
# ─────────────────────────────────────────────────────────────
app.include_router(auth_router, prefix=PREFIX)
app.include_router(tracking_router, prefix=PREFIX)
app.include_router(campaign_router, prefix=PREFIX)
app.include_router(analytics_router, prefix=PREFIX)
app.include_router(ws_router, prefix=PREFIX)
app.include_router(voice_router, prefix=PREFIX)


# ─────────────────────────────────────────────────────────────
# EXCEPTION HANDLERS
# ─────────────────────────────────────────────────────────────
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.warning(
        f"[VALIDATION_ERROR] {request.method} {request.url.path} "
        f"{exc.errors()}"
    )
    return JSONResponse(
        status_code=422,
        content={
            "detail": "Validation error",
            "code": "VALIDATION_ERROR",
            "errors": exc.errors(),
        },
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception(
        f"[UNHANDLED_EXCEPTION] {request.method} {request.url.path}"
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "code": "INTERNAL_ERROR"},
    )


# ─────────────────────────────────────────────────────────────
# HEALTH CHECK
# ─────────────────────────────────────────────────────────────
@app.get("/health", tags=["Health"])
async def health():
    logger.info("[HEALTH_CHECK] Service alive")
    return {"status": "ok", "service": settings.APP_NAME}


# ─────────────────────────────────────────────────────────────
# ENTRYPOINT
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="debug",   # Forces terminal logs
    )