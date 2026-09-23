import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { getHardware, getQueueStatus, logout, type HardwareReport, type QueueStatus } from "../api/client";
import {
  IconDashboard,
  IconFilm,
  IconQueue,
  IconHardware,
  IconSettings,
  IconBolt,
  IconPause,
  IconLogOut,
} from "./Icons";

export function Nav() {
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);

  useEffect(() => {
    getHardware().then(setHardware).catch(() => {});
    const interval = setInterval(() => {
      getQueueStatus().then(setQueueStatus).catch(() => {});
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  const totalActive = (queueStatus?.running ?? 0) + (queueStatus?.pending ?? 0);
  const hwSummary = hardware?.gpus?.[0]?.name ?? (hardware?.encoders?.find((e) => e.hwaccelType !== "cpu")?.name ?? "Hardware Auto");

  async function handleLogout() {
    try {
      await logout();
    } finally {
      window.location.reload();
    }
  }

  return (
    <header className="navbar">
      <div className="navbar-left">
        <NavLink to="/" className="brand" aria-label="Shrinkarr Home">
          <div className="brand-icon">
            <IconBolt size={18} />
          </div>
          <span>Shrinkarr</span>
        </NavLink>

        <nav className="nav-links" aria-label="Main Navigation">
          <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            <IconDashboard size={15} />
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/library" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            <IconFilm size={15} />
            <span>Library</span>
          </NavLink>
          <NavLink to="/queue" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            <IconQueue size={15} />
            <span>Queue</span>
            {totalActive > 0 && <span className="nav-badge">{totalActive}</span>}
          </NavLink>
          <NavLink to="/presets" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            <IconHardware size={15} />
            <span>Hardware & Presets</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            <IconSettings size={15} />
            <span>Settings</span>
          </NavLink>
        </nav>
      </div>

      <div className="navbar-right">
        {queueStatus?.paused && (
          <span className="badge" style={{ backgroundColor: "rgba(245, 158, 11, 0.15)", color: "var(--accent-amber)", border: "1px solid rgba(245, 158, 11, 0.35)" }}>
            <IconPause size={12} /> Queue Paused
          </span>
        )}
        {!queueStatus?.paused && queueStatus?.schedule?.enabled && !queueStatus.schedule.isWithinSchedule && (
          <span
            className="badge"
            style={{ backgroundColor: "rgba(59, 130, 246, 0.12)", color: "#93c5fd", border: "1px solid rgba(59, 130, 246, 0.28)" }}
            title={`Waiting for the next weekly processing window (scheduled time: ${queueStatus.schedule.serverTime}).`}
          >
            Outside Active Window
          </span>
        )}
        {hardware && (
          <div className="hw-pill" title={hardware.summary}>
            <IconBolt size={13} />
            <span>{hwSummary}</span>
          </div>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleLogout} title="Log Out">
          <IconLogOut size={14} />
          <span>Log Out</span>
        </button>
      </div>
    </header>
  );
}
