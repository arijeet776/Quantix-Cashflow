import { useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="qx-app">
      <a href="#main-content" className="qx-skip-link">Skip to main content</a>
      <Sidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <div className="qx-main">
        <Topbar title={title} onMenuClick={() => setDrawerOpen(true)} />
        <main className="qx-content" id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
