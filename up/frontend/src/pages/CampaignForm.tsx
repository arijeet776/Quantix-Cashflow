import { useState } from "react";
import { IconClose, IconPlus } from "../components/Icons";

export interface CampaignEvent {
  event_name: string;
  payout: number;
  completion_source: "online" | "offline";
}

export interface CampaignFormValues {
  name: string;
  advertiser_name: string;
  advertiser_tracking_url: string;
  logo_url: string;
  description: string;
  platform: string;
  postback_platform: "trackier" | "trackix" | "offer18" | "custom";
  postback_endpoint: string;
  postback_api_key: string;
  payout_min: string;
  payout_max: string;
  daily_cap: string;
  overall_cap: string;
  approval_mode: "promote_immediately" | "requires_approval";
  category: string;
  kind: "standard" | "shopping" | "survey";
  tracking_only: boolean;
  countries: string; // comma separated
  tracking_window_hours: string; // "" = no validation window (earn at postback)
  events: CampaignEvent[];
}

export const EMPTY_CAMPAIGN_FORM: CampaignFormValues = {
  name: "",
  advertiser_name: "",
  advertiser_tracking_url: "",
  logo_url: "",
  description: "",
  platform: "",
  postback_platform: "custom",
  postback_endpoint: "",
  postback_api_key: "",
  payout_min: "",
  payout_max: "",
  daily_cap: "",
  overall_cap: "",
  approval_mode: "promote_immediately",
  category: "",
  kind: "standard",
  tracking_only: false,
  countries: "",
  tracking_window_hours: "",
  events: [{ event_name: "Install", payout: 0, completion_source: "online" }],
};

/** Converts form state (all strings, for controlled inputs) into the JSON body the API expects. */
export function toApiPayload(v: CampaignFormValues) {
  return {
    name: v.name,
    advertiser_name: v.advertiser_name || null,
    advertiser_tracking_url: v.advertiser_tracking_url || null,
    logo_url: v.logo_url || null,
    description: v.description || null,
    platform: v.platform || null,
    postback_platform: v.postback_platform,
    postback_config: {
      ...(v.postback_endpoint ? { endpoint: v.postback_endpoint } : {}),
      ...(v.postback_api_key ? { api_key: v.postback_api_key } : {}),
    },
    payout_min: v.payout_min === "" ? null : Number(v.payout_min),
    payout_max: v.payout_max === "" ? null : Number(v.payout_max),
    daily_cap: v.daily_cap === "" ? null : Number(v.daily_cap),
    overall_cap: v.overall_cap === "" ? null : Number(v.overall_cap),
    approval_mode: v.approval_mode,
    category: v.category.trim() || null,
    kind: v.kind,
    tracking_only: v.tracking_only,
    countries: v.countries.split(",").map((c) => c.trim()).filter(Boolean),
    tracking_window_hours: v.tracking_window_hours === "" ? null : Number(v.tracking_window_hours),
    events: v.events,
  };
}

export function CampaignForm({ value, onChange }: { value: CampaignFormValues; onChange: (v: CampaignFormValues) => void }) {
  function set<K extends keyof CampaignFormValues>(key: K, val: CampaignFormValues[K]) {
    onChange({ ...value, [key]: val });
  }

  function updateEvent(index: number, patch: Partial<CampaignEvent>) {
    const events = value.events.map((ev, i) => (i === index ? { ...ev, ...patch } : ev));
    set("events", events);
  }

  function addEvent() {
    set("events", [...value.events, { event_name: "", payout: 0, completion_source: "online" }]);
  }

  function removeEvent(index: number) {
    set("events", value.events.filter((_, i) => i !== index));
  }

  return (
    <>
      <div className="qx-section-title" style={{ marginTop: 0 }}>Basics</div>
      <div className="qx-row">
        <div className="qx-field">
          <label htmlFor="c-name">Campaign name</label>
          <input id="c-name" className="qx-input" value={value.name} onChange={(e) => set("name", e.target.value)} required />
        </div>
        <div className="qx-field">
          <label htmlFor="c-advertiser">Advertiser / Company</label>
          <input id="c-advertiser" className="qx-input" value={value.advertiser_name} onChange={(e) => set("advertiser_name", e.target.value)} />
        </div>
      </div>
      <div className="qx-row">
        <div className="qx-field">
          <label htmlFor="c-tracking-url">Advertiser tracking URL</label>
          <input id="c-tracking-url" className="qx-input" value={value.advertiser_tracking_url} onChange={(e) => set("advertiser_tracking_url", e.target.value)} />
        </div>
        <div className="qx-field">
          <label htmlFor="c-logo">Logo URL</label>
          <input id="c-logo" className="qx-input" value={value.logo_url} onChange={(e) => set("logo_url", e.target.value)} />
          <div className="qx-hint">Binary upload isn't available yet (no storage service integrated) — paste a hosted image URL.</div>
        </div>
      </div>
      <div className="qx-field">
        <label htmlFor="c-desc">Description / Instructions</label>
        <textarea id="c-desc" className="qx-textarea" value={value.description} onChange={(e) => set("description", e.target.value)} />
      </div>
      <div className="qx-field">
        <label htmlFor="c-platform">Platform (free text)</label>
        <input id="c-platform" className="qx-input" placeholder="e.g. Direct, VCommission, HIQ…" value={value.platform} onChange={(e) => set("platform", e.target.value)} />
      </div>

      <div className="qx-section-title">Postback</div>
      <div className="qx-row">
        <div className="qx-field">
          <label htmlFor="c-pb-platform">Postback platform</label>
          <select id="c-pb-platform" className="qx-select" value={value.postback_platform} onChange={(e) => set("postback_platform", e.target.value as CampaignFormValues["postback_platform"]) }>
            <option value="trackier">Trackier</option>
            <option value="trackix">Trackix</option>
            <option value="offer18">Offer18</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div className="qx-field">
          <label htmlFor="c-pb-endpoint">Postback endpoint</label>
          <input id="c-pb-endpoint" className="qx-input" value={value.postback_endpoint} onChange={(e) => set("postback_endpoint", e.target.value)} />
        </div>
      </div>
      <div className="qx-field">
        <label htmlFor="c-pb-key">Postback API key (stored server-side; masked when viewing this campaign later)</label>
        <input id="c-pb-key" className="qx-input" type="password" value={value.postback_api_key} onChange={(e) => set("postback_api_key", e.target.value)} />
      </div>

      <div className="qx-section-title">Payout &amp; Caps</div>
      <div className="qx-row">
        <div className="qx-field">
          <label htmlFor="c-payout-min">Payout min</label>
          <input id="c-payout-min" className="qx-input" type="number" min={0} value={value.payout_min} onChange={(e) => set("payout_min", e.target.value)} />
        </div>
        <div className="qx-field">
          <label htmlFor="c-payout-max">Payout max</label>
          <input id="c-payout-max" className="qx-input" type="number" min={0} value={value.payout_max} onChange={(e) => set("payout_max", e.target.value)} />
        </div>
      </div>
      <div className="qx-row">
        <div className="qx-field">
          <label htmlFor="c-daily-cap">Daily cap (blank = unlimited)</label>
          <input id="c-daily-cap" className="qx-input" type="number" min={0} value={value.daily_cap} onChange={(e) => set("daily_cap", e.target.value)} />
        </div>
        <div className="qx-field">
          <label htmlFor="c-overall-cap">Overall / lifetime cap (blank = unlimited)</label>
          <input id="c-overall-cap" className="qx-input" type="number" min={0} value={value.overall_cap} onChange={(e) => set("overall_cap", e.target.value)} />
        </div>
      </div>

      <div className="qx-section-title">Access &amp; Validation</div>
      <div className="qx-row">
        <div className="qx-field">
          <label htmlFor="c-approval">Publisher access</label>
          <select id="c-approval" className="qx-select" value={value.approval_mode} onChange={(e) => set("approval_mode", e.target.value as CampaignFormValues["approval_mode"])}>
            <option value="promote_immediately">Promote immediately — no approval needed</option>
            <option value="requires_approval">Requires approval — manager/admin approves each publisher</option>
          </select>
        </div>
        <div className="qx-field">
          <label htmlFor="c-window">Tracking / validation time</label>
          <select id="c-window" className="qx-select" value={["", "24", "48", "72", "168", "360"].includes(value.tracking_window_hours) ? value.tracking_window_hours : "custom"} onChange={(e) => set("tracking_window_hours", e.target.value === "custom" ? "1" : e.target.value)}>
            <option value="">None — earn when the postback arrives</option>
            <option value="24">24 hours</option>
            <option value="48">48 hours</option>
            <option value="72">72 hours</option>
            <option value="168">7 days</option>
            <option value="360">15 days</option>
            <option value="custom">Custom (hours)…</option>
          </select>
          {!["", "24", "48", "72", "168", "360"].includes(value.tracking_window_hours) && (
            <input className="qx-input" style={{ marginTop: 6 }} type="number" min={1} value={value.tracking_window_hours} onChange={(e) => set("tracking_window_hours", e.target.value)} aria-label="Custom validation hours" />
          )}
          <div className="qx-hint">With a window set, conversions stay pending until the company's report is recorded; the publisher is only credited when it is confirmed.</div>
        </div>
      </div>

      <div className="qx-row">
        <div className="qx-field">
          <label htmlFor="c-category">Category</label>
          <input id="c-category" className="qx-input" placeholder="e.g. Finance" value={value.category} onChange={(e) => set("category", e.target.value)} />
        </div>
        <div className="qx-field">
          <label htmlFor="c-kind">Kind</label>
          <select id="c-kind" className="qx-select" value={value.kind} onChange={(e) => set("kind", e.target.value as CampaignFormValues["kind"])}>
            <option value="standard">Standard</option><option value="shopping">Shopping</option><option value="survey">Survey</option>
          </select>
        </div>
      </div>
      <div className="qx-row">
        <div className="qx-field">
          <label htmlFor="c-countries">Countries (comma separated)</label>
          <input id="c-countries" className="qx-input" placeholder="India, UAE" value={value.countries} onChange={(e) => set("countries", e.target.value)} />
        </div>
        <div className="qx-field">
          <label htmlFor="c-trackonly">Tracking only</label>
          <select id="c-trackonly" className="qx-select" value={value.tracking_only ? "yes" : "no"} onChange={(e) => set("tracking_only", e.target.value === "yes")}>
            <option value="no">No</option><option value="yes">Yes — show "Tracking Only" label</option>
          </select>
        </div>
      </div>

      <div className="qx-section-title">Events</div>
      {value.events.map((ev, i) => (
        <div key={i} className="qx-row" style={{ alignItems: "end", marginBottom: 8 }}>
          <div className="qx-field" style={{ marginBottom: 0 }}>
            <label>Event name</label>
            <input className="qx-input" value={ev.event_name} onChange={(e) => updateEvent(i, { event_name: e.target.value })} />
          </div>
          <div className="qx-field" style={{ marginBottom: 0 }}>
            <label>Payout (₹0 is valid)</label>
            <input className="qx-input" type="number" min={0} value={ev.payout} onChange={(e) => updateEvent(i, { payout: Number(e.target.value) })} />
          </div>
          <div className="qx-field" style={{ marginBottom: 0, display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label>Completion source</label>
              <select className="qx-select" value={ev.completion_source} onChange={(e) => updateEvent(i, { completion_source: e.target.value as "online" | "offline" })}>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
              </select>
            </div>
            <button type="button" className="qx-icon-btn" onClick={() => removeEvent(i)} aria-label="Remove event">
              <IconClose width={14} height={14} />
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="qx-btn qx-btn-sm" onClick={addEvent}>
        <IconPlus width={13} height={13} /> Add event
      </button>
    </>
  );
}

export function useCampaignForm(initial: CampaignFormValues = EMPTY_CAMPAIGN_FORM) {
  return useState<CampaignFormValues>(initial);
}
