import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { getHardware, getQueueStatus, type HardwareReport } from "../api/client";

export function Nav() {
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [queueStatus, setQueueStatus] = useState<{ running: number; pending: number; paused: boolean } | null>(null);

  useEffect(() => {
    getHardware().then(setHardware).catch(() => {});
    const interval = setInterval(() => {
      getQueueStatus().then(setQueueStatus).catch(() => {});
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  const totalActive = (queueStatus?.running ?? 0) + (queueStatus?.pending ?? 0);
  const hwSummary = hardware?.gpus?.[0]?.name ?? (hardware?.encoders?.find(e => e.hwaccelType !== 'cpu')?.name ?? "Hardware Auto");

  return (
    <header className="navbar">
      <div style={{ display: "flex", alignItems: "center", gap: "2rem" }}>
        <NavLink to="/" className="brand">
          <div className="brand-icon">⚡</div>
          <span>Shrinkarr</span>
        </NavLink>

        <nav className="nav-links">
          <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            📊 Dashboard
          </NavLink>
          <NavLink to="/library" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            🎬 Library
          </NavLink>
          <NavLink to="/queue" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            ⏳ Queue
            {totalActive > 0 && <span className="nav-badge">{totalActive}</span>}
          </NavLink>
          <NavLink to="/presets" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            ⚡ Hardware & Presets
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            ⚙️ Settings
          </NavLink>
        </nav>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        {queueStatus?.paused && (
          <span className="badge" style={{ backgroundColor: "rgba(245, 158, 11, 0.2)", color: "#f59e0b", border: "1px solid rgba(245, 158, 11, 0.4)" }}>
            ⏸️ Queue Paused
          </span>
        )}
        {hardware && (
          <div className="hw-pill" title={hardware.summary}>
            ⚡ {hwSummary}
          </div>
        )}
      </div>
    </header>
  );
}
