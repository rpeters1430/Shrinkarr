# Shrinkarr Design Direction (DESIGN.md)

> Visual and interaction design specifications for Shrinkarr.
> Created per antislop Plan B (Agent-proposed direction).

## 1. Product Identity & Soul

- **Product:** Shrinkarr — Automated self-hosted video/audio library compression workstation.
- **Audience:** Homelab operators, NAS & media server enthusiasts (Jellyfin, Plex, Emby, Unraid, TrueNAS, Docker). Users who care deeply about storage reclamation, transcode quality vs. bitrate efficiency, GPU hardware utilization, and reliable hands-off automation.
- **Mood / Character:** High-precision engineering dashboard. Functional, dense, uncluttered, and confident. Evokes the utilitarian reliability of top-tier homelab software (like Prometheus/Grafana hardware panels, Sonarr/Radarr library controls, and HandBrake/FFmpeg encoding monitors) without generic tech boilerplate.
- **Focal Point:** Storage reclamation metric (Space Reclaimed vs. Potential Savings) and live hardware encoding telemetry (active GPU runners, speed multipliers, compression ratios).

## 2. Dials

| Dial | Level | Implementation |
|---|---|---|
| **ENERGY** | **2 (Balanced)** | High-contrast data hierarchy, clear status indicators, solid surfaces with intentional contrast, no neon or screaming decorations. |
| **RHYTHM** | **2 (Consistent with breaks)** | Structured layout across all views, breaking predictably when featuring real-time transcode workers or active discovery scanners. |
| **MOTION** | **1 (Calm)** | Snappy 150ms hover/active micro-transitions. Zero looping pulses, zero bouncing indicators, zero gratuitous scroll reveals. |

## 3. Active Color Palette (Strict R-29 Compliance)

Limited to 2 core functional colors + 1 efficiency accent, on a neutral base:

- **Neutral Foundation:**
  - Base background: `#0b0f17` (Deep carbon)
  - Card / Panel background: `#131b2e` (Muted dark slate)
  - Interactive / Input surface: `#1b253d` (Elevated slate)
  - Subtle borders: `#263554` (Structural edge)
  - Text main: `#f8fafc` (High readability, WCAG AAA)
  - Text secondary: `#94a3b8` (WCAG AA compliant)
  - Text muted: `#64748b`
- **Core 1 (Storage Reclaimed & Success):** Emerald `#10b981` (hover `#059669`)
  - Used for space saved, completed transcodes, and positive storage impact.
- **Core 2 (Hardware Telemetry & Actions):** Cobalt / Electric Slate `#3b82f6` (hover `#2563eb`)
  - Used for primary CTA buttons, active GPU/encoder telemetry, and selected tabs.
- **Semantic Accents (State only, no decorative use):**
  - Warning / Paused: Amber `#f59e0b` (Queue paused, playback lock)
  - Destructive / Error: Rose `#f43f5e` (Failed encode, cancel/delete actions)

## 4. Typography

- **Font Family:** System UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`). Clean, native, fast, zero network font bloat.
- **Numeric Data:** `font-variant-numeric: tabular-nums` for all sizes, durations, percentages, and bitrates to ensure alignment in tables and cards.
- **Monospace Usage:** Strictly reserved for actual file paths, codec fourccs, and FFmpeg parameter flags. Never used for decorative card titles or headers.

## 5. Iconography & Visual Assets

- **Zero Emojis:** All emojis (`⚡`, `🎬`, `⏳`, `📊`, `🤖`, `➕`, etc.) removed from UI text, buttons, and navigation.
- **Vector Icons:** Clean inline SVGs with a uniform 1.75px stroke width and 16px/18px bounding box where visual signposting is functionally helpful.

## 6. Accessibility & Keyboard Standard

- Visible keyboard focus rings using `outline: 2px solid var(--accent-primary); outline-offset: 2px` on all interactive controls (`:focus-visible`).
- Modals always dismissable via the `Escape` key and click-outside backdrop.
- Minimum 44px tap targets for mobile interactive elements.
