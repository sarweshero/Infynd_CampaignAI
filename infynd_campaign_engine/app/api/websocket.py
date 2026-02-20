"""
WebSocket Approval System.
WS /api/v1/ws/campaigns/{campaign_id}?token=<jwt>

Content structure: generated_content = {
    "common":   { "Email": {subject, body, cta_link}, "LinkedIn": {...}, "Call": {...} },
    "contacts": { "email@example.com": "Email", ... }
}

Flow:
1. Send APPROVAL_START with channel list and contact counts.
2. For each channel, send the common template for review.
3. Client can: approve, edit, regenerate per channel.
4. After all channels approved -> mark campaign APPROVED -> trigger dispatch.
"""
import asyncio
import copy
import json
import logging
import uuid
from datetime import datetime
from typing import Dict, Any, List

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select, update

from app.core.database import AsyncSessionLocal
from app.core.dependencies import get_ws_user
from app.models.campaign import Campaign, PipelineState
from app.models.pipeline import PipelineRun
from app.services.dispatch_service import dispatch_campaign

logger = logging.getLogger(__name__)
router = APIRouter(tags=["WebSocket"])

CHANNEL_ORDER: List[str] = ["Email", "LinkedIn", "Call"]


@router.websocket("/ws/campaigns/{campaign_id}")
async def campaign_approval_ws(websocket: WebSocket, campaign_id: str):
    """
    WebSocket endpoint for human-in-the-loop campaign approval.
    Sends each channel's common template for review.
    Supports: approve, approve_all, edit, regenerate actions.
    """
    await websocket.accept()

    try:
        current_user = await get_ws_user(websocket)
    except Exception:
        return

    async with AsyncSessionLocal() as db:
        try:
            campaign_uuid = uuid.UUID(campaign_id)
            result = await db.execute(select(Campaign).where(Campaign.id == campaign_uuid))
            campaign = result.scalar_one_or_none()

            if not campaign:
                await websocket.send_json({"error": "Campaign not found", "code": "NOT_FOUND"})
                await websocket.close()
                return

            if campaign.pipeline_state != PipelineState.AWAITING_APPROVAL:
                await websocket.send_json({
                    "error": f"Campaign state is {campaign.pipeline_state}, not AWAITING_APPROVAL",
                    "code": "INVALID_STATE",
                })
                await websocket.close()
                return

            generated_content: Dict[str, Any] = campaign.generated_content or {}
            common: Dict[str, Any] = generated_content.get("common", {})
            contacts_map: Dict[str, str] = generated_content.get("contacts", {})

            # Count contacts per channel
            channel_counts: Dict[str, int] = {}
            for email, ch in contacts_map.items():
                channel_counts[ch] = channel_counts.get(ch, 0) + 1

            channels = [ch for ch in CHANNEL_ORDER if ch in common]
            total_contacts = sum(channel_counts.values())

            await websocket.send_json({
                "type": "APPROVAL_START",
                "campaign_id": str(campaign_uuid),
                "total_contacts": total_contacts,
                "channel_counts": channel_counts,
                "channels": channels,
            })

            approved_channels: List[str] = []
            pending_channels = list(channels)

            for channel in list(pending_channels):
                template = common.get(channel, {})

                await websocket.send_json({
                    "type": "CHANNEL_GROUP_START",
                    "channel": channel,
                    "count": channel_counts.get(channel, 0),
                })

                await websocket.send_json({
                    "type": "CHANNEL_CONTENT",
                    "channel": channel,
                    "content": template,
                    "contact_count": channel_counts.get(channel, 0),
                    "contacts": [
                        email for email, ch in contacts_map.items() if ch == channel
                    ][:20],
                })

                while True:
                    try:
                        raw = await websocket.receive_text()
                        action = json.loads(raw)
                    except WebSocketDisconnect:
                        logger.warning(f"[WS] Client disconnected during approval for {campaign_id}")
                        return
                    except json.JSONDecodeError:
                        await websocket.send_json({"error": "Invalid JSON", "code": "BAD_REQUEST"})
                        continue

                    action_type = action.get("action")

                    if action_type == "approve":
                        approved_channels.append(channel)
                        pending_channels.remove(channel)
                        await websocket.send_json({
                            "type": "CHANNEL_APPROVED",
                            "channel": channel,
                        })
                        break

                    elif action_type == "approve_all":
                        for remaining in pending_channels[:]:
                            approved_channels.append(remaining)
                            pending_channels.remove(remaining)
                        await websocket.send_json({
                            "type": "ALL_APPROVED",
                            "approved_count": len(approved_channels),
                        })
                        break

                    elif action_type == "edit":
                        edited_content = action.get("edited_content")
                        if edited_content and isinstance(edited_content, dict):
                            new_gc = copy.deepcopy(generated_content)
                            new_gc["common"][channel] = edited_content
                            await db.execute(
                                update(Campaign)
                                .where(Campaign.id == campaign_uuid)
                                .values(generated_content=new_gc)
                            )
                            await db.commit()
                            generated_content = new_gc
                            common = new_gc.get("common", {})
                        await websocket.send_json({
                            "type": "CONTENT_UPDATED",
                            "channel": channel,
                        })
                        await websocket.send_json({
                            "type": "CHANNEL_CONTENT",
                            "channel": channel,
                            "content": common.get(channel, {}),
                            "contact_count": channel_counts.get(channel, 0),
                        })
                        continue

                    elif action_type == "regenerate":
                        await websocket.send_json({
                            "type": "REGENERATING",
                            "channel": channel,
                        })
                        from app.agents.content_generator_agent import _call_ollama, PROMPT_MAP
                        base_prompt = PROMPT_MAP.get(channel)
                        if base_prompt:
                            prompt_str = (
                                base_prompt
                                .replace("{{campaign_purpose}}", campaign.campaign_purpose or "")
                                .replace("{{product_link}}", campaign.product_link or "")
                                .replace("{{prompt}}", campaign.prompt or "")
                            )
                            try:
                                new_template = await _call_ollama(prompt_str)
                                new_gc = copy.deepcopy(generated_content)
                                new_gc["common"][channel] = new_template
                                await db.execute(
                                    update(Campaign)
                                    .where(Campaign.id == campaign_uuid)
                                    .values(generated_content=new_gc)
                                )
                                await db.commit()
                                generated_content = new_gc
                                common = new_gc.get("common", {})
                            except Exception as regen_err:
                                await websocket.send_json({
                                    "type": "REGENERATE_FAILED",
                                    "channel": channel,
                                    "error": str(regen_err),
                                })
                        await websocket.send_json({
                            "type": "CHANNEL_CONTENT",
                            "channel": channel,
                            "content": common.get(channel, {}),
                            "contact_count": channel_counts.get(channel, 0),
                        })
                        continue

                    else:
                        await websocket.send_json({
                            "error": f"Unknown action: {action_type}",
                            "code": "UNKNOWN_ACTION",
                        })

                if not pending_channels:
                    break

            # All channels approved -> mark campaign APPROVED
            await db.execute(
                update(Campaign)
                .where(Campaign.id == campaign_uuid)
                .values(
                    pipeline_state=PipelineState.APPROVED,
                    approval_status="APPROVED",
                    approved_by=current_user.email,
                    approved_at=datetime.utcnow(),
                )
            )
            await db.execute(
                update(PipelineRun)
                .where(PipelineRun.campaign_id == campaign_uuid)
                .values(state="APPROVED")
            )
            await db.commit()

            await websocket.send_json({
                "type": "CAMPAIGN_APPROVED",
                "campaign_id": str(campaign_uuid),
                "approved_by": current_user.email,
                "approved_channels": approved_channels,
            })

            logger.info(f"[WS] Campaign {campaign_id} fully approved by {current_user.email}")

            # Trigger dispatch asynchronously
            async def _dispatch():
                async with AsyncSessionLocal() as dispatch_db:
                    await dispatch_campaign(dispatch_db, str(campaign_uuid))

            asyncio.ensure_future(_dispatch())

        except WebSocketDisconnect:
            logger.warning(f"[WS] Client disconnected: {campaign_id}")
        except Exception as exc:
            logger.error(f"[WS] Error in approval flow for {campaign_id}: {exc}", exc_info=True)
            try:
                await websocket.send_json({"error": str(exc), "code": "INTERNAL_ERROR"})
            except Exception:
                pass
        finally:
            try:
                await websocket.close()
            except Exception:
                pass
