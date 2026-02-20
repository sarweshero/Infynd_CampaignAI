"""
Agent 2 — Contact Retrieval Agent
Builds a dynamic SQL query from classification filters.
Joins contacts with icp_results (optional).
Orders by buying_probability_score DESC NULLS LAST.
Updates pipeline state to CONTACTS_RETRIEVED.
"""
import logging
from datetime import datetime
from typing import Dict, Any, List

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text, update

from app.models.campaign import Campaign, PipelineState
from app.models.pipeline import PipelineRun, CampaignLog

logger = logging.getLogger(__name__)


def _normalize_role_term(term: str) -> str:
    """
    Normalise a role term for LIKE matching.
    Strips trailing 's' so 'Developers' matches 'Developer' and
    'CTOs' matches 'CTO' in the database.
    Also strips trailing 'es' for words like 'engineers' → 'engineer'.
    """
    t = term.strip().lower()
    if t.endswith("es") and len(t) > 4:
        return t[:-2]
    if t.endswith("s") and len(t) > 3:
        return t[:-1]
    return t


def _build_contact_query(filters: Dict[str, Any]) -> tuple:
    """Build parameterized query string and bind params from filters."""
    conditions = []
    params = {}

    role = (filters.get("filters") or {}).get("role", "")
    location = (filters.get("filters") or {}).get("location", "")
    category = (filters.get("filters") or {}).get("category", "")
    company = (filters.get("filters") or {}).get("company", "")

    base_query = """
        SELECT
            c.id,
            c.email,
            c.name,
            c.role,
            c.company,
            c.location,
            c.category,
            c.emailclickrate,
            c.linkedinclickrate,
            c.callanswerrate,
            c.preferredtime,
            COALESCE(icp.buying_probability_score, 0) AS buying_probability_score
        FROM contacts c
        LEFT JOIN icp_results icp ON icp.contact_id = c.id
    """

    if role:
        # Ollama may return role as a list OR a comma-separated string
        if isinstance(role, list):
            raw_terms = [str(t).strip() for t in role if str(t).strip()]
        else:
            raw_terms = [t.strip() for t in str(role).split(",") if t.strip()]

        if len(raw_terms) == 1:
            conditions.append("LOWER(c.role) LIKE :role")
            params["role"] = f"%{_normalize_role_term(raw_terms[0])}%"
        else:
            role_clauses = []
            for i, term in enumerate(raw_terms):
                key = f"role_{i}"
                role_clauses.append(f"LOWER(c.role) LIKE :{key}")
                params[key] = f"%{_normalize_role_term(term)}%"
            conditions.append("(" + " OR ".join(role_clauses) + ")")

    if location:
        loc = location if isinstance(location, str) else ", ".join(str(x) for x in location)
        conditions.append("LOWER(c.location) LIKE :location")
        params["location"] = f"%{loc.lower()}%"

    if category:
        cat = category if isinstance(category, str) else ", ".join(str(x) for x in category)
        conditions.append("LOWER(c.category) LIKE :category")
        params["category"] = f"%{cat.lower()}%"

    if company:
        comp = company if isinstance(company, str) else ", ".join(str(x) for x in company)
        conditions.append("LOWER(c.company) LIKE :company")
        params["company"] = f"%{comp.lower()}%"

    if conditions:
        base_query += " WHERE " + " AND ".join(conditions)

    base_query += " ORDER BY buying_probability_score DESC NULLS LAST"

    return base_query, params


async def run_contact_retrieval_agent(
    db: AsyncSession,
    campaign: Campaign,
    pipeline_run: PipelineRun,
) -> List[Dict[str, Any]]:
    started_at = datetime.utcnow()
    log = CampaignLog(
        campaign_id=campaign.id,
        agent_name="ContactRetrievalAgent",
        started_at=started_at,
        status="RUNNING",
    )
    db.add(log)
    await db.flush()

    try:
        classification = pipeline_run.classification_summary or {}
        query_str, params = _build_contact_query(classification)

        result = await db.execute(text(query_str), params)
        rows = result.mappings().all()
        contacts = [dict(row) for row in rows]

        # ── Fallback: progressively relax filters if no contacts found ───
        if not contacts:
            filters = (classification.get("filters") or {})
            # Order of filter relaxation: company → location → category → role
            relax_keys = ["company", "location", "category", "role"]
            relaxed = dict(filters)
            for key in relax_keys:
                if not relaxed.get(key):
                    continue
                logger.info(
                    f"[ContactRetrievalAgent] 0 contacts — relaxing filter '{key}' "
                    f"(was: {relaxed[key]!r})"
                )
                relaxed[key] = ""
                query_str, params = _build_contact_query({"filters": relaxed})
                result = await db.execute(text(query_str), params)
                rows = result.mappings().all()
                contacts = [dict(row) for row in rows]
                if contacts:
                    break

        # ── Ultimate fallback: return top contacts by ICP score ──────────
        if not contacts:
            logger.warning(
                f"[ContactRetrievalAgent] All filters exhausted — returning top contacts"
            )
            fallback_query = """
                SELECT c.id, c.email, c.name, c.role, c.company, c.location,
                       c.category, c.emailclickrate, c.linkedinclickrate,
                       c.callanswerrate, c.preferredtime,
                       COALESCE(icp.buying_probability_score, 0) AS buying_probability_score
                FROM contacts c
                LEFT JOIN icp_results icp ON icp.contact_id = c.id
                ORDER BY buying_probability_score DESC NULLS LAST
                LIMIT 50
            """
            result = await db.execute(text(fallback_query))
            rows = result.mappings().all()
            contacts = [dict(row) for row in rows]

        # Serialize UUIDs to string for JSON storage
        serializable_contacts = []
        for c in contacts:
            row = dict(c)
            for k, v in row.items():
                try:
                    from uuid import UUID
                    if isinstance(v, UUID):
                        row[k] = str(v)
                except Exception:
                    pass
            serializable_contacts.append(row)

        # Update pipeline_run with contact list
        existing = pipeline_run.downstream_results or {}
        existing["contacts"] = serializable_contacts
        await db.execute(
            update(PipelineRun)
            .where(PipelineRun.id == pipeline_run.id)
            .values(
                downstream_results=existing,
                state=PipelineState.CONTACTS_RETRIEVED,
            )
        )
        await db.execute(
            update(Campaign)
            .where(Campaign.id == campaign.id)
            .values(pipeline_state=PipelineState.CONTACTS_RETRIEVED)
        )

        completed_at = datetime.utcnow()
        duration_ms = int((completed_at - started_at).total_seconds() * 1000)
        await db.execute(
            update(CampaignLog)
            .where(CampaignLog.id == log.id)
            .values(completed_at=completed_at, duration_ms=duration_ms, status="SUCCESS")
        )
        await db.commit()

        logger.info(f"[ContactRetrievalAgent] Campaign {campaign.id}: retrieved {len(contacts)} contacts")
        return serializable_contacts

    except Exception as exc:
        completed_at = datetime.utcnow()
        duration_ms = int((completed_at - started_at).total_seconds() * 1000)
        await db.execute(
            update(CampaignLog)
            .where(CampaignLog.id == log.id)
            .values(
                completed_at=completed_at,
                duration_ms=duration_ms,
                status="FAILED",
                error_message=str(exc),
            )
        )
        await db.commit()
        logger.error(f"[ContactRetrievalAgent] Failed for campaign {campaign.id}: {exc}")
        raise
