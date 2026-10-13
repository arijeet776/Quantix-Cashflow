"""Company-report reconciliation of conversions.

A postback only says what the tracker claimed at the time. When the
campaign has a validation window (tracking_window_hours), the advertiser's
final report decides: CONFIRMED creates the publisher earning (Part 9,
idempotent per conversion), REJECTED never earns — or, if a confirmed
conversion is later rejected (chargeback), posts a compensating reversal.
Rejected is terminal: corrections go through a financial adjustment so the
ledger history stays honest.
"""
from app.core import audit_actions
from app.core.enums import ConversionApprovalStatus as S, Role
from app.core.exceptions import ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError
from app.core.rbac import CurrentUser
from app.db import conversion_repository, manager_repository
from app.db.audit_repository import record as audit_record
from app.services import financial_service


async def _scope_manager_id(user: CurrentUser) -> str | None:
    if user.role != Role.MANAGER:
        return None
    m = await manager_repository.get_manager_by_user_id(user.user_id)
    if m is None:
        raise ForbiddenError("Manager profile not found")
    return m["manager_id"]


async def list_review(user: CurrentUser, approval_status: str | None, campaign_id: str | None,
                      skip: int, limit: int) -> dict:
    items, total = await conversion_repository.list_for_review(
        await _scope_manager_id(user), approval_status, campaign_id, skip, limit)
    return {"items": items, "total": total}


async def record_outcome(user: CurrentUser, conversion_id: str, confirm: bool, note: str | None,
                         request_id: str | None = None) -> dict:
    mgr = await _scope_manager_id(user)
    conv = await conversion_repository.get_conversion(conversion_id)
    if conv is None or (mgr is not None and conv.get("manager_id") != mgr):
        raise NotFoundError("Conversion not found")  # no existence leak across managers

    current = conv.get("approval_status") or S.CONFIRMED.value  # legacy rows were earned at postback time
    if confirm:
        if current == S.CONFIRMED.value:
            return {"conversion": conv, "idempotent": True}
        if current == S.REJECTED.value:
            raise ConflictError("Rejected conversions are final; use a financial adjustment to correct")
        if conv.get("payout") is None:
            raise ConflictError("Conversion has no configured payout and cannot be confirmed")
        updated = await conversion_repository.transition_approval(
            conversion_id, [S.PENDING_REPORT.value], S.CONFIRMED.value, user.user_id, note)
        if updated is None:
            raise ConflictError("Conversion was already decided")
        try:
            await financial_service.create_earning_for_conversion(
                conversion_id=conversion_id, publisher_id=conv["publisher_id"], manager_id=conv.get("manager_id"),
                campaign_id=conv["campaign_id"], payout=conv["payout"], request_id=request_id)
        except Exception as exc:  # noqa: BLE001 — never leave CONFIRMED without its earning
            await conversion_repository.transition_approval(
                conversion_id, [S.CONFIRMED.value], S.PENDING_REPORT.value, user.user_id, "earning failed; reverted")
            await audit_record(audit_actions.EARNING_CREATION_FAILED, actor_user_id=user.user_id,
                               metadata={"conversion_id": conversion_id, "error": str(exc)})
            raise ServiceUnavailableError("Could not post the earning; conversion left pending") from exc
        await audit_record(audit_actions.CONVERSION_REPORT_CONFIRMED, actor_user_id=user.user_id,
                           metadata={"conversion_id": conversion_id, "note": note})
        return {"conversion": updated, "idempotent": False}

    # reject
    if current == S.REJECTED.value:
        return {"conversion": conv, "idempotent": True}
    updated = await conversion_repository.transition_approval(
        conversion_id, [S.PENDING_REPORT.value, S.CONFIRMED.value], S.REJECTED.value, user.user_id, note)
    if updated is None:
        raise ConflictError("Conversion was already decided")
    if current == S.CONFIRMED.value:
        await financial_service.reverse_earning(
            conversion_id=conversion_id, reason=note or "Rejected in company report", actor_user_id=user.user_id)
    await audit_record(audit_actions.CONVERSION_REPORT_REJECTED, actor_user_id=user.user_id,
                       metadata={"conversion_id": conversion_id, "note": note, "reversed": current == S.CONFIRMED.value})
    return {"conversion": updated, "idempotent": False}
