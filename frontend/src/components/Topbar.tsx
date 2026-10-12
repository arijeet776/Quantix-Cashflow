import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { IconLogout, IconMenu, IconNotifications } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

export function Topbar({ title, onMenuClick }: { title: string; onMenuClick: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  const initial = user?.role ? user.role.charAt(0).toUpperCase() : "?";

  return (
    <header className="qx-topbar" aria-label="Top bar">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button className="qx-icon-btn qx-menu-btn" onClick={onMenuClick} aria-label="Open navigation menu">
          <IconMenu width={16} height={16} />
        </button>
        <span className="qx-topbar-title">{title}</span>
      </div>
      <div className="qx-topbar-actions">
        <ThemeToggle />
        <button className="qx-icon-btn" aria-label="Notifications" onClick={() => navigate("/notifications")}>
          <IconNotifications width={16} height={16} />
        </button>
        <span className="qx-avatar" title={user?.role} role="img" aria-label={`Signed in as ${user?.role ?? "user"}`}>
          {initial}
        </span>
        <button className="qx-icon-btn" aria-label="Log out" onClick={handleLogout}>
          <IconLogout width={16} height={16} />
        </button>
      </div>
    </header>
  );
}
