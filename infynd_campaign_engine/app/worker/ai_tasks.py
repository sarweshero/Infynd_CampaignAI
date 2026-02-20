import asyncio
import logging

from app.worker.celery_app import celery_app

logger = logging.getLogger(__name__)


@celery_app.task(
    bind=True,
    max_retries=3,
    default_retry_delay=10,
    name="app.worker.ai_tasks.run_campaign_pipeline",
)
def run_campaign_pipeline(self, campaign_id: str):
    """
    Celery task: orchestrates the full multi-agent pipeline for a campaign.
    Called from API as a background task or queued via Celery.
    """
    try:
        from app.services.pipeline_runner import execute_pipeline
        asyncio.run(execute_pipeline(campaign_id))
        logger.info(f"[CeleryTask] Pipeline completed for campaign {campaign_id}")
    except Exception as exc:
        logger.error(f"[CeleryTask] Pipeline failed for campaign {campaign_id}: {exc}", exc_info=True)
        raise self.retry(exc=exc, countdown=10)


@celery_app.task(
    bind=True,
    max_retries=3,
    default_retry_delay=5,
    name="app.worker.ai_tasks.run_dispatch",
)
def run_dispatch(self, campaign_id: str):
    """
    Celery task: handles dispatch after campaign approval.
    """
    try:
        import asyncio
        from app.core.database import AsyncSessionLocal
        from app.services.dispatch_service import dispatch_campaign

        async def _dispatch():
            async with AsyncSessionLocal() as db:
                await dispatch_campaign(db, campaign_id)

        asyncio.run(_dispatch())
        logger.info(f"[CeleryTask] Dispatch completed for campaign {campaign_id}")
    except Exception as exc:
        logger.error(f"[CeleryTask] Dispatch failed for campaign {campaign_id}: {exc}", exc_info=True)
        raise self.retry(exc=exc, countdown=5)
