"""
WebSocket Approval System.
WS /api/v1/ws/campaigns/{campaign_id}?token=<jwt>
Supports: approve, approve_all, edit, regenerate actions.
Contacts are grouped by channel (Email → LinkedIn → Call) with CHANNEL_GROUP_START messages.
After all contacts are approved, dispatch is triggered automatically.
"""
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

logger = logging.getLogger(__name__)
router = APIRouter(tags=["WebSocket"])

CHANNEL_ORDER: List[str] = ["Email", "LinkedIn", "Call"]


@router.websocket("/ws/campaigns/{campaign_id}")
async def campaign_approval_ws(websocket: WebSocket, campaign_id: str):
    """
    WebSocket endpoint for human-in-the-loop campaign approval.
    Sends each contact's content, awaits approve/edit/regenerate actions.
    """
    await websocket.accept()

    # Authenticate via token query param
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

            # Support new generated_content shape with `common` + `personalized`
            # personalized: { "alice@x.com": { channel, content }, ... }
            _RESERVED = {"common", "personalized"}
            if isinstance(generated_content.get("personalized"), dict):
                personalized = generated_content["personalized"]
            else:
                # Fallback: top-level keys are contact emails; skip structural keys
                personalized = {k: v for k, v in generated_content.items() if k not in _RESERVED}

            # ── Group and order contacts: Email → LinkedIn → Call ──────────────
            grouped: Dict[str, List[str]] = {ch: [] for ch in CHANNEL_ORDER}
            for email_key, data in personalized.items():
                ch = (data or {}).get("channel", "Email")
                bucket = ch if ch in grouped else "Email"
                grouped[bucket].append(email_key)

            ordered_emails: List[str] = []
            for ch in CHANNEL_ORDER:
                ordered_emails.extend(grouped[ch])

            pending_emails = list(ordered_emails)
            approved_emails = []

            await websocket.send_json({
                "type": "APPROVAL_START",
                "campaign_id": str(campaign_uuid),
                "total_contacts": len(pending_emails),
                "channel_counts": {ch: len(grouped[ch]) for ch in CHANNEL_ORDER},
            })

            current_channel: str = ""
            for contact_email in list(pending_emails):
                contact_data = personalized.get(contact_email, {})
                contact_channel = contact_data.get("channel", "Email")

                # Emit channel group header when channel changes
                if contact_channel != current_channel:
                    current_channel = contact_channel
                    await websocket.send_json({
                        "type": "CHANNEL_GROUP_START",
                        "channel": current_channel,
                        "count": len(grouped.get(current_channel, [])),
                    })

                await websocket.send_json({
                    "type": "CONTACT_CONTENT",
                    "contact_email": contact_email,
                    "channel": contact_data.get("channel"),
                    "content": contact_data.get("content"),
                    "index": ordered_emails.index(contact_email),
                })

                # Wait for client action on this contact
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
                        approved_emails.append(contact_email)
                        pending_emails.remove(contact_email)
                        await websocket.send_json({
                            "type": "APPROVED",
                            "contact_email": contact_email,
                        })
                        break

                    elif action_type == "approve_all":
                        for remaining_email in pending_emails[:]:
                            approved_emails.append(remaining_email)
                            pending_emails.remove(remaining_email)
                        await websocket.send_json({
                            "type": "ALL_APPROVED",
                            "approved_count": len(approved_emails),
                        })
                        break

                    elif action_type == "edit":
                        edited_content = action.get("edited_content")
                        if edited_content:
                            generated_content[contact_email]["content"] = edited_content
                            await db.execute(
                                update(Campaign)
                                .where(Campaign.id == campaign_uuid)
                                .values(generated_content=generated_content)
                            )
                            await db.commit()
                            await db.refresh(campaign)
                        await websocket.send_json({
                            "type": "CONTENT_UPDATED",
                            "contact_email": contact_email,
                        })
                        # Re-send updated content for review
                        await websocket.send_json({
                            "type": "CONTACT_CONTENT",
                            "contact_email": contact_email,
                            "channel": generated_content[contact_email].get("channel"),
                            "content": generated_content[contact_email].get("content"),
                        })
                        continue

                    elif action_type == "regenerate":
                        await websocket.send_json({
                            "type": "REGENERATING",
                            "contact_email": contact_email,
                        })
                        # Re-trigger content generation for this single contact
                        from app.agents.content_generator_agent import _call_ollama, PROMPT_MAP, _personalization_hint
                        from sqlalchemy import select as sa_select
                        from app.models.contact import Contact
                        contact_result = await db.execute(
                            sa_select(Contact).where(Contact.email == contact_email)
                        )
                        contact_record = contact_result.scalar_one_or_none()
                        if contact_record:
                            channel = generated_content[contact_email].get("channel", "Email")
                            template = PROMPT_MAP.get(channel)
                            contact_dict = {
                                "name": contact_record.name,
                                "role": contact_record.role,
                                "company": contact_record.company,
                                "emailclickrate": contact_record.emailclickrate,
                                "linkedinclickrate": contact_record.linkedinclickrate,
                                "callanswerrate": contact_record.callanswerrate,
                                "preferredtime": contact_record.preferredtime,
                            }
                            hint = _personalization_hint(contact_dict)
                            prompt_str = template.format(
                                **contact_dict,
                                campaign_purpose=campaign.campaign_purpose or "",
                                product_link=campaign.product_link or "",
                                prompt=campaign.prompt or "",
                                personalization_hint=hint,
                            )
                            try:
                                new_content = await _call_ollama(prompt_str)
                                generated_content[contact_email]["content"] = new_content
                                await db.execute(
                                    update(Campaign)
                                    .where(Campaign.id == campaign_uuid)
                                    .values(generated_content=generated_content)
                                )
                                await db.commit()
                            except Exception as regen_err:
                                await websocket.send_json({
                                    "type": "REGENERATE_FAILED",
                                    "contact_email": contact_email,
                                    "error": str(regen_err),
                                })
                        await websocket.send_json({
                            "type": "CONTACT_CONTENT",
                            "contact_email": contact_email,
                            "channel": generated_content[contact_email].get("channel"),
                            "content": generated_content[contact_email].get("content"),
                        })
                        continue

                    else:
                        await websocket.send_json({
                            "error": f"Unknown action: {action_type}",
                            "code": "UNKNOWN_ACTION",
                        })

                # Break outer loop if approve_all was triggered
                if not pending_emails:
                    break

            # All contacts processed — mark approved
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
                .values(state=PipelineState.APPROVED)
            )
            await db.commit()

            await websocket.send_json({
                "type": "CAMPAIGN_APPROVED",
                "campaign_id": str(campaign_uuid),
                "approved_by": current_user.email,
                "approved_count": len(approved_emails),
            })

            logger.info(f"[WS] Campaign {campaign_id} fully approved by {current_user.email}")

            # Trigger dispatch asynchronously (new session — this WS session stays open)
            import asyncio
            from app.services.dispatch_service import dispatch_campaign

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
