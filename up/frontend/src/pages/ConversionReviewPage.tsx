import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { AppShell } from "../components/AppShell";
import { EmptyState, ErrorBanner, Modal, Pagination, StatusBadge } from "../components/Common";

interface Row {
  conversion_id: string;
  campaign_id: string;
  publisher_id: string;
  event: string | null;
  status: string | null;
  payout: number | null;
  approval_status: string;
  postback_received_at: string | null;
}
const PAGE_SIZE = 20;

export function ConversionReviewPage() {
  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("pending_report");
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ row: Row; action: "confirm" | "reject" } | null>(null);
  const [note, setNote] = useState("");

  function load() {
    api
      .get<{ items: Row[]; total: number }>("/admin/conversion-review", { approval_status: filter || undefined, page, page_size: PAGE_SIZE })
      .then((r) => { setItems(r.data.items); setTotal(r.data.total); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load conversions"));
  }
  useEffect(load, [page, filter]);

  async function submit() {
    if (!target) return;
    try {
      await api.post(`/admin/conversion-review/${target.row.conversion_id}/${target.action}`, { note: note || null });
      setTarget(null);
      setNote("");
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Action failed");
      setTarget(null);
    }
  }

  return (
    <AppShell title="Conversion Review">
      <div className="qx-page-header">
        <div>
          <div className="qx-page-title">Conversion Review</div>
          <div className="qx-page-subtitle">
            Record the company's final report. Confirming credits the publisher; rejecting never credits (or reverses a credited conversion).
          </div>
        </div>
        <select className="qx-select" value={filter} onChange={(e) => { setPage(1); setFilter(e.target.value); }} aria-label="Filter">
          <option value="pending_report">Awaiting company report</option>
          <option value="confirmed">Confirmed</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      <ErrorBanner message={error} />
      {items.length === 0 ? <EmptyState message="No conversions." /> : (
        <div className="qx-table-wrap">
          <table className="qx-table">
            <thead><tr><th>Received</th><th>Campaign</th><th>Publisher</th><th>Event</th><th>Payout</th><th>Postback</th><th>Report</th><th /></tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.conversion_id}>
                  <td>{r.postback_received_at ? new Date(r.postback_received_at).toLocaleString() : "—"}</td>
                  <td>{r.campaign_id}</td>
                  <td>{r.publisher_id}</td>
                  <td>{r.event ?? "—"}</td>
                  <td>{r.payout != null ? `₹${r.payout}` : "—"}</td>
                  <td>{r.status ?? "—"}</td>
                  <td><StatusBadge status={r.approval_status} /></td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {r.approval_status === "pending_report" && (
                      <>
                        <button className="qx-btn qx-btn-primary qx-btn-sm" onClick={() => setTarget({ row: r, action: "confirm" })}>Confirm</button>{" "}
                        <button className="qx-btn qx-btn-sm" onClick={() => setTarget({ row: r, action: "reject" })}>Reject</button>
                      </>
                    )}
                    {r.approval_status === "confirmed" && (
                      <button className="qx-btn qx-btn-sm" onClick={() => setTarget({ row: r, action: "reject" })}>Reverse</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
      {target && (
        <Modal title={target.action === "confirm" ? "Confirm conversion" : "Reject conversion"} onClose={() => setTarget(null)}>
          <div className="qx-field">
            <label htmlFor="cr-note">Note (optional)</label>
            <input id="cr-note" className="qx-input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <button className="qx-btn qx-btn-primary" onClick={submit}>{target.action === "confirm" ? "Confirm & credit" : "Reject"}</button>
        </Modal>
      )}
    </AppShell>
  );
}
