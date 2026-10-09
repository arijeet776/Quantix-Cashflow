"""
Platform-specific inbound postback adapters (Part 6, postback spec §3/§22).

Each adapter converts ONE platform's documented parameters into the canonical
InboundPostback. The conversion engine never sees platform-specific names.

Mapping provenance:
- Offer18: fields specified in the Quantix postback spec §4/§12
  (aff_click_id, sub_aff_id, aff_sub1..10, event_token, payout, currency, status).
- Trackier: fields specified in the Quantix postback spec §5/§13
  (click_id, txn_id, goal_value, status, revenue, sale_amount, currency, sub1..10).
- Trackix: ONLY the transport fields the spec verifies (sub1, sub2) are mapped.
  Event/click/status/transaction parameter names are deliberately left
  unmapped until the official Trackix documentation is provided — the spec
  forbids inventing them (§6/§14). A Trackix postback therefore resolves only
  when it carries a Quantix click id in a verified field; everything else it
  carries is preserved raw for later reprocessing.
"""
from app.core.exceptions import ValidationAppError

MAX_RAW_PARAMS = 60


class CanonicalPostback(dict):
    """Plain dict subclass for clarity — keys per the canonical model (spec §7/§15)."""


def _clean(params: dict) -> dict:
    """Cap the raw parameter set and value sizes; values are data, never code."""
    out = {}
    for i, (k, v) in enumerate(params.items()):
        if i >= MAX_RAW_PARAMS:
            break
        out[str(k)[:64]] = "".join(ch for ch in str(v) if ch.isprintable())[:300]
    return out


def _base(platform: str, params: dict) -> CanonicalPostback:
    return CanonicalPostback(
        platform=platform,
        quantix_click_id=None,
        external_click_id=None,
        agency_click_id=None,
        sub_affiliate_id=None,
        event=None,
        goal=None,
        raw_event_value=None,
        raw_goal_value=None,
        status=None,
        raw_status=None,
        external_conversion_id=None,
        advertiser_revenue=None,
        upstream_payout=None,
        sale_amount=None,
        currency=None,
        event_occurred_at=None,
        sub_ids={},
        utm={},
        raw_platform_parameters=_clean(params),
    )


def _subs(params: dict, prefix: str, count: int = 10) -> dict:
    return {f"{prefix}{i}": params[f"{prefix}{i}"] for i in range(1, count + 1) if params.get(f"{prefix}{i}") is not None}


def _utms(params: dict) -> dict:
    return {k: params[k] for k in ("utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content") if params.get(k) is not None}


def _qx_click(value) -> str | None:
    """A platform field carrying our own click id resolves directly (spec §16 step 1)."""
    if value and str(value).startswith("QXCLK_"):
        return str(value)
    return None


def normalize_offer18(params: dict) -> CanonicalPostback:
    canonical = _base("offer18", params)
    aff_click_id = params.get("aff_click_id")
    canonical["quantix_click_id"] = _qx_click(aff_click_id) or _qx_click(params.get("p1"))
    canonical["external_click_id"] = None if _qx_click(aff_click_id) else aff_click_id
    canonical["agency_click_id"] = params.get("sub_aff_id")
    canonical["sub_affiliate_id"] = params.get("sub_aff_id")
    canonical["event"] = params.get("event_token")
    canonical["raw_event_value"] = params.get("event_token")
    canonical["status"] = params.get("status")
    canonical["raw_status"] = params.get("status")
    canonical["upstream_payout"] = params.get("payout")
    canonical["currency"] = params.get("currency")
    canonical["external_conversion_id"] = params.get("transaction_id") or params.get("conversion_id")
    canonical["sub_ids"] = _subs(params, "aff_sub") | _subs(params, "p")
    canonical["utm"] = _utms(params)
    return canonical


def normalize_trackier(params: dict) -> CanonicalPostback:
    canonical = _base("trackier", params)
    click_id = params.get("click_id")
    canonical["quantix_click_id"] = _qx_click(click_id) or _qx_click(params.get("p1"))
    canonical["external_click_id"] = None if _qx_click(click_id) else click_id
    canonical["external_conversion_id"] = params.get("txn_id")
    # goal_value is event/goal information (spec §13) — sub params are transport.
    canonical["goal"] = params.get("goal_value")
    canonical["event"] = params.get("goal_value")
    canonical["raw_goal_value"] = params.get("goal_value")
    canonical["raw_event_value"] = params.get("goal_value")
    canonical["status"] = params.get("status")
    canonical["raw_status"] = params.get("status")
    canonical["advertiser_revenue"] = params.get("revenue")
    canonical["sale_amount"] = params.get("sale_amount")
    canonical["upstream_payout"] = params.get("payout")
    canonical["currency"] = params.get("currency")
    canonical["sub_ids"] = _subs(params, "sub") | _subs(params, "p")
    canonical["utm"] = _utms(params)
    return canonical


def normalize_trackix(params: dict) -> CanonicalPostback:
    canonical = _base("trackix", params)
    # Verified transport fields only (spec §14). Event/goal/status/txn mapping
    # is intentionally empty until Trackix's official docs confirm the names.
    canonical["quantix_click_id"] = _qx_click(params.get("sub1")) or _qx_click(params.get("sub2"))
    canonical["sub_ids"] = _subs(params, "sub", 2)
    canonical["utm"] = _utms(params)
    return canonical


ADAPTERS = {
    "offer18": normalize_offer18,
    "trackier": normalize_trackier,
    "trackix": normalize_trackix,
}

# Drives the Super Admin Postback Setup UI (spec §14) — required/optional
# parameter lists come from the adapters, never hand-typed into the frontend.
PLATFORM_METADATA = {
    "offer18": {
        "label": "Offer18",
        "required": ["aff_click_id", "event_token"],
        "optional": ["sub_aff_id", "aff_sub1", "aff_sub2", "payout", "currency", "status",
                     "transaction_id", "aff_sub3–aff_sub10"],
        "methods": ["GET", "POST"],
        "verified": True,
    },
    "trackier": {
        "label": "Trackier",
        "required": ["click_id", "goal_value"],
        "optional": ["txn_id", "status", "revenue", "sale_amount", "currency",
                     "sub1–sub10", "p1–p10"],
        "methods": ["GET", "POST"],
        "verified": True,
    },
    "trackix": {
        "label": "Trackix",
        "required": ["sub1"],
        "optional": ["sub2"],
        "methods": ["GET", "POST"],
        "verified": False,
        "note": "Awaiting official Trackix documentation — event/click/status "
                "parameter names are intentionally unmapped.",
    },
}


def normalize(platform: str, params: dict) -> CanonicalPostback:
    adapter = ADAPTERS.get(platform)
    if adapter is None and platform == "custom":
        # The project specification does not define the Custom platform's
        # parameter names, event/status mapping or payload format, so no
        # adapter is shipped (inventing one would silently mis-map
        # conversions). See docs/CUSTOM_POSTBACK_SPEC_GAP.md.
        raise ValidationAppError(
            "Custom platform postbacks are not enabled: the Custom adapter specification is not defined"
        )
    if adapter is None:
        raise ValidationAppError(f"Unsupported postback platform: {platform}")
    if not isinstance(params, dict) or not params:
        raise ValidationAppError("Malformed postback: empty parameter set")
    return adapter(params)
