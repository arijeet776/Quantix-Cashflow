import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ErrorBanner } from "../components/Common";
import { formatIST } from "../lib/ist";

interface OfflineCampaign { campaign_id: string; name: string; events: string[] }
interface ClickRow { click_id: string; publisher_id: string; clicked_at: string | null; status: "approved" | "pending" | "rejected" }
interface ApproveResult { results: { click_id: string; result: string; detail?: string }[]; approved: number }

const RESULT_TEXT: Record<string, string> = {
  approved: "Approved", already_approved: "Already approved", rejected_final: "Rejected earlier (final)",
  not_found: "Not found in this campaign", error: "Error",
};

/** Settle offline events from the advertiser's report: type the Quantix click ids that appear in it and approve. */
export function OfflineReportPage() {
  const [campaigns, setCampaigns] = useState<OfflineCampaign[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [eventName, setEventName] = useState("");
  const [ids, setIds] = useState("");
  const [rows, setRows] = useState<ClickRow[]>([]);
  const [outcome, setOutcome] = useState<ApproveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<OfflineCampaign[]>("/admin/conversion-review/offline/campaigns")
      .then((r) => setCampaigns(r.data))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load campaigns"));
  }, []);

  const selected = campaigns.find((c) => c.campaign_id === campaignId);

  function loadRows() {
    if (!campaignId || !eventName) { setRows([]); return; }
    api.get<{ items: ClickRow[] }>("/admin/conversion-review/offline/clicks", { campaign_id: campaignId, event_name: eventName, page_size: 100 })
      .then((r) => setRows(r.data.items))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load clicks"));
  }
  useEffect(loadRows, [campaignId, eventName]);

  async function approve() {
    const list = ids.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) return;
    setBusy(true); setError(null); setOutcome(null);
    try {
      // Send in batches of 25 so each request stays small (the server processes clicks one by one).
      const BATCH = 25;
      const merged: ApproveResult = { results: [], approved: 0 };
      for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH);
        const r = await api.post<ApproveResult>("/admin/conversion-review/offline/approve", { campaign_id: campaignId, event_name: eventName, click_ids: chunk });
        merged.results.push(...r.data.results);
        merged.approved += r.data.approved;
        setOutcome({ ...merged, results: [...merged.results] }); // live progress
      }
      setIds(""); loadRows();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Approval failed");
    } finally { setBusy(false); }
  }

  async function mark(clickId: string, status: "pending" | "rejected") {
    setError(null);
    try {
      await api.post("/admin/conversion-review/offline/mark", { campaign_id: campaignId, event_name: eventName, click_id: clickId, status });
      loadRows();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Update failed");
    }
  }

  return (
    <AppShell title="Offline Report">
      <div className="qx-page-header">
        <div>
          <div className="qx-page-title">Offline Report</div>
          <div className="qx-page-subtitle">
            For offline events. Paste the Quantix click ids from the advertiser's report and approve — the publisher is paid
            and their postback fires. Clicks not in the report stay Pending, or mark them Rejected.
          </div>
        </div>
      </div>
      <ErrorBanner message={error} />

      <div className="qx-card" style={{ marginBottom: 18 }}>
        <div className="qx-row">
          <div className="qx-field">
            <label htmlFor="off-camp">Campaign</label>
            <select id="off-camp" className="qx-select" value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setEventName(""); setOutcome(null); }}>
              <option value="">Select campaign…</option>
              {campaigns.map((c) => <option key={c.campaign_id} value={c.campaign_id}>{c.name}</option>)}
            </select>
            {campaigns.length === 0 && <div className="qx-hint">No campaign has an offline event yet.</div>}
          </div>
          <div className="qx-field">
            <label htmlFor="off-event">Offline event</label>
            <select id="off-event" className="qx-select" value={eventName} onChange={(e) => { setEventName(e.target.value); setOutcome(null); }} disabled={!selected}>
              <option value="">Select event…</option>
              {selected?.events.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
            </select>
          </div>
        </div>
        <div className="qx-field">
          <label htmlFor="off-ids">Quantix click ids from the advertiser's report (one per line or comma-separated)</label>
          <textarea id="off-ids" className="qx-textarea" placeholder="QNCTX1866FK69G4" value={ids} onChange={(e) => setIds(e.target.value)} />
        </div>
        <button className="qx-btn qx-btn-primary" disabled={busy || !eventName || !ids.trim()} onClick={approve}>
          {busy ? "Approving…" : "Approve & credit publishers"}
        </button>

        {outcome && (
          <div className="qx-callout" style={{ marginTop: 14 }}>
            <div className="qx-callout-title">{outcome.approved} approved</div>
            {outcome.results.filter((r) => r.result !== "approved").map((r) => (
              <div key={r.click_id}><code>{r.click_id}</code> — {RESULT_TEXT[r.result] ?? r.result}{r.detail ? ` (${r.detail})` : ""}</div>
            ))}
          </div>
        )}
      </div>

      {eventName && (
        <div className="qx-table-wrap">
          <table className="qx-table">
            <thead><tr><th>click_id</th><th>Publisher id</th><th>Clicked (IST)</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} style={{ color: "var(--text-muted)" }}>No clicks yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.click_id}>
                  <td><code>{r.click_id}</code></td>
                  <td>{r.publisher_id}</td>
                  <td>{formatIST(r.clicked_at)}</td>
                  <td style={{ textTransform: "capitalize" }}>{r.status}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button className="qx-btn qx-btn-sm" disabled={r.status !== "pending"} onClick={() => mark(r.click_id, "pending")}>Pending</button>
                    <button className="qx-btn qx-btn-sm" disabled={r.status === "rejected"} onClick={() => mark(r.click_id, "rejected")}>Rejected</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
