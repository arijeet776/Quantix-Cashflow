"""Company-report reconciliation endpoints (Super Admin + scoped Manager)."""
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from app.core.enums import Role
from app.core.rbac import CurrentUser, require_role
from app.services import conversion_review_service as svc

router = APIRouter()
_reviewer = require_role(Role.SUPER_ADMIN, Role.MANAGER)


class OutcomeBody(BaseModel):
    note: str | None = Field(default=None, max_length=500)


@router.get("")
async def list_conversions(
    approval_status: str | None = Query(default=None, pattern="^(pending_report|confirmed|rejected)$"),
    campaign_id: str | None = Query(default=None, max_length=32),
    page: int = Query(default=1, ge=1), page_size: int = Query(default=20, ge=1, le=100),
    user: CurrentUser = Depends(_reviewer),
):
    return await svc.list_review(user, approval_status, campaign_id, (page - 1) * page_size, page_size)


@router.post("/{conversion_id}/confirm")
async def confirm(conversion_id: str, request: Request, body: OutcomeBody = OutcomeBody(),
                  user: CurrentUser = Depends(_reviewer)):
    return await svc.record_outcome(user, conversion_id, True, body.note, getattr(request.state, "request_id", None))


@router.post("/{conversion_id}/reject")
async def reject(conversion_id: str, request: Request, body: OutcomeBody = OutcomeBody(),
                 user: CurrentUser = Depends(_reviewer)):
    return await svc.record_outcome(user, conversion_id, False, body.note, getattr(request.state, "request_id", None))
