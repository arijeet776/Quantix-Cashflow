import { FoundationPage } from "./FoundationPage";

export function NotificationsPage() {
  return (
    <FoundationPage
      title="Notifications"
      subtitle="Pending approvals, campaign changes, and security alerts."
      note={
        <>
          Pending Manager and Publisher approvals are shown on the Dashboard. A dedicated notification
          feed for campaign state changes and system/security alerts is not available yet. The email policy is unchanged here: no routine email for
          clicks, installs, registrations, or ordinary conversions — only the lifecycle emails already
          in place (invites, OTP, approvals, password reset).
        </>
      }
    />
  );
}
