"""
Dashboard aggregation. Every number here comes from a real repository
query — Managers/Publishers/Campaigns counts all exist as real collections
by Part 3. Metrics that depend on data models from later parts (clicks,
conversions, revenue, payouts, margin — Parts 6/7/9) are represented
explicitly as `available: false` rather than as a fabricated 0 or "-",
which would be indistinguishable from a real zero. The frontend renders
these as a clearly marked foundation/empty state, not a metric card with a
number in it.
"""
from app.core.enums import AccountStatus, CampaignStatus, Role
from app.db import campaign_repository
from app.db.mongodb import get_database


class Metric:
    def __init__(self, available: bool, value: int | float | None = None, reason: str | None = None):
        self.available = available
        self.value = value
        self.reason = reason

    def to_dict(self):
        return {"available": self.available, "value": self.value, "reason": self.reason}


async def get_dashboard() -> dict:
    db = get_database()

    total_managers = await db["users"].count_documents({"role": Role.MANAGER.value})
    active_managers = await db["users"].count_documents(
        {"role": Role.MANAGER.value, "account_status": AccountStatus.ACTIVE.value}
    )
    total_publishers = await db["users"].count_documents({"role": Role.PUBLISHER.value})
    active_publishers = await db["users"].count_documents(
        {"role": Role.PUBLISHER.value, "account_status": AccountStatus.ACTIVE.value}
    )
    pending_managers = await db["users"].count_documents(
        {"role": Role.MANAGER.value, "account_status": AccountStatus.PENDING.value}
    )
    pending_publishers = await db["users"].count_documents(
        {"role": Role.PUBLISHER.value, "account_status": AccountStatus.PENDING.value}
    )

    total_campaigns = await campaign_repository.count_all_campaigns()
    active_campaigns = await campaign_repository.count_campaigns_by_status(CampaignStatus.ACTIVE)

    not_yet_available = "Requires a data model not yet built (Parts 6/7/9)"

    return {
        "kpis": {
            "total_managers": Metric(True, total_managers).to_dict(),
            "active_managers": Metric(True, active_managers).to_dict(),
            "total_publishers": Metric(True, total_publishers).to_dict(),
            "active_publishers": Metric(True, active_publishers).to_dict(),
            "active_campaigns": Metric(True, active_campaigns).to_dict(),
            "total_campaigns": Metric(True, total_campaigns).to_dict(),
            "total_clicks": Metric(False, reason=not_yet_available).to_dict(),
            "successful_events": Metric(False, reason=not_yet_available).to_dict(),
            "network_revenue": Metric(False, reason=not_yet_available).to_dict(),
            "publisher_payout": Metric(False, reason=not_yet_available).to_dict(),
            "network_margin": Metric(False, reason=not_yet_available).to_dict(),
        },
        "pending_approvals": {
            "managers": pending_managers,
            "publishers": pending_publishers,
        },
    }
