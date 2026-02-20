"""
Pipeline Orchestrator — runs all 4 agents sequentially.
Each state transition is persisted atomically.
Handles failures by marking the pipeline as FAILED.
"""
import logging
import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from app.core.database import AsyncSessionLocal
from app.models.campaign import Campaign, PipelineState
from app.models.pipeline import PipelineRun
from app.agents.prompt_parser_agent import run_prompt_parser_agent
from app.agents.classification_agent import run_classification_agent
from app.agents.contact_retrieval_agent import run_contact_retrieval_agent
from app.agents.channel_decision_agent import run_channel_decision_agent
from app.agents.content_generator_agent import run_content_generator_agent
from app.services.dispatch_service import dispatch_campaign

logger = logging.getLogger(__name__)


async def execute_pipeline(campaign_id: str):
    """
    Entry point called from Celery or BackgroundTasks.
    Opens its own DB session for full async pipeline execution.
    """
    async with AsyncSessionLocal() as db:
        try:
            campaign_uuid = uuid.UUID(campaign_id)

            # Lock check — prevent concurrent execution
            result = await db.execute(
                select(Campaign).where(Campaign.id == campaign_uuid)
            )
            campaign = result.scalar_one_or_none()

            if not campaign:
                logger.error(f"[Pipeline] Campaign {campaign_id} not found")
                return

            if campaign.pipeline_locked:
                logger.warning(f"[Pipeline] Campaign {campaign_id} is locked — skipping")
                return

            # Lock the pipeline
            await db.execute(
                update(Campaign)
                .where(Campaign.id == campaign_uuid)
                .values(pipeline_locked=True)
            )
            await db.commit()

            # Create pipeline_run record
            pipeline_run = PipelineRun(
                campaign_id=campaign_uuid,
                state=PipelineState.CREATED,
                started_at=datetime.utcnow(),
            )
            db.add(pipeline_run)
            await db.commit()
            await db.refresh(pipeline_run)
            # Refresh campaign too
            await db.refresh(campaign)

            # --- Agent 0: Prompt Parsing (extracts company, platform, purpose, audience) ---
            await run_prompt_parser_agent(db, campaign)
            await db.refresh(campaign)

            # --- Agent 1: Classification ---
            await run_classification_agent(db, campaign, pipeline_run)
            await db.refresh(pipeline_run)
            await db.refresh(campaign)

            # --- Agent 2: Contact Retrieval ---
            await run_contact_retrieval_agent(db, campaign, pipeline_run)
            await db.refresh(pipeline_run)
            await db.refresh(campaign)

            # --- Agent 3: Channel Decision ---
            await run_channel_decision_agent(db, campaign, pipeline_run)
            await db.refresh(pipeline_run)
            await db.refresh(campaign)

            # --- Agent 4: Content Generation ---
            await run_content_generator_agent(db, campaign, pipeline_run)
            await db.refresh(campaign)

            # Move to AWAITING_APPROVAL or APPROVED
            next_state = (
                PipelineState.AWAITING_APPROVAL
                if campaign.approval_required
                else PipelineState.APPROVED
            )
            await db.execute(
                update(Campaign)
                .where(Campaign.id == campaign_uuid)
                .values(
                    pipeline_state=next_state,
                    pipeline_locked=False,
                )
            )
            await db.execute(
                update(PipelineRun)
                .where(PipelineRun.id == pipeline_run.id)
                .values(state=next_state, completed_at=datetime.utcnow())
            )
            await db.commit()

            logger.info(f"[Pipeline] Campaign {campaign_id} completed → {next_state}")

            # Auto-dispatch immediately when approval is not required
            if not campaign.approval_required:
                logger.info(f"[Pipeline] approval_required=False — auto-dispatching {campaign_id}")
                async with AsyncSessionLocal() as dispatch_db:
                    await dispatch_campaign(dispatch_db, campaign_id)

        except Exception as exc:
            logger.error(f"[Pipeline] Campaign {campaign_id} FAILED: {exc}", exc_info=True)
            try:
                # Must rollback the poisoned transaction before issuing new SQL
                await db.rollback()
                await db.execute(
                    update(Campaign)
                    .where(Campaign.id == uuid.UUID(campaign_id))
                    .values(
                        pipeline_state=PipelineState.FAILED,
                        pipeline_locked=False,
                    )
                )
                await db.execute(
                    update(PipelineRun)
                    .where(PipelineRun.campaign_id == uuid.UUID(campaign_id))
                    .values(
                        state=PipelineState.FAILED,
                        completed_at=datetime.utcnow(),
                        error_message=str(exc),
                    )
                )
                await db.commit()
            except Exception as inner:
                logger.critical(f"[Pipeline] Failed to persist FAILED state for {campaign_id}: {inner}")
