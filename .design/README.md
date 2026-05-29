# void-os .design — Restyle Options (VOS-178)

Three design directions for the void-os web surfaces: dashboard/session-index and session-view shell. All mockups use the ui-kit token HSL values inline (self-contained static HTML, no build step). Pick one to implement in the follow-up task.

---

## Option 1 — Compact Command-Center

**Optimises for:** minimum chrome, maximum density, keyboard-first flow. The dashboard fits above the fold at any typical height. Skills render as a chip bar — each chip expands an inline text input on focus (CSS-only expand trick). Sessions are a flat dense list with a leading status dot and truncated UUID. The session-view shell collapses everything into a single 36px header strip: back link, session name, and a monospace copy button that shows the full command truncated — confirmed state flips to green. Best for: single-user, power-user, used daily from desktop.

**Tradeoff:** chips expanding on focus is slightly discoverable but not self-evident; skill descriptions are invisible until you look. The copy button label is the command itself, which reads naturally but can truncate badly on very long vault paths.

---

## Option 2 — Sidebar Nav + Card Grid

**Optimises for:** navigability across many sessions, glanceability of session state, and onboarding clarity. A fixed left sidebar gives persistent session access + relay status. Skills render as info-cards with a visible description and per-card input; sessions are a structured table with status pills (active / idle / error). The session-view shell keeps the sidebar context so you never lose your place; the copy button is a labelled pill that, when clicked, reveals the full command in a code block below the shell header. Best for: heavier use, multiple simultaneous sessions, or sharing with a second person.

**Tradeoff:** most vertical real-estate used by the sidebar at narrow widths; the two-panel layout needs media query care in the real implementation. The persistent command display below the header adds useful discoverability at the cost of a few pixels of iframe height.

---

## Option 3 — Terminal-Chromatic

**Optimises for:** aesthetic coherence with the CLI tool it wraps. Uses monospace font throughout; skills render as `$ command` prompt lines with inline inputs; sessions are log-format lines with skill-tag color-coding and relative timestamps. The session shell mimics a macOS terminal window with traffic-light dots, a visible full-length command bar, and a bracketed `[copy]` / `[copied]` button. Introduces a new semantic accent `--color-void` (cyan-green, hsl 165 80% 42%) to tie the visual identity to the `vc` CLI brand.

**Tradeoff:** heaviest divergence from shadcn default — feels intentional but may read as "too custom" if void-os surfaces ever need to match the broader admin UI. Monospace everywhere slows scan speed for longer titles. The `--color-void` token is a **proposed ui-kit addition** (see below).

---

## Proposed ui-kit additions

| Token | Value | Rationale |
|---|---|---|
| `--color-void` | `hsl(165 80% 42%)` | Semantic brand accent for void-os / CLI-adjacent surfaces. Option 3 uses it; Option 1/2 don't require it. Propose adding to `tokens.json` only if Option 3 is chosen. |
| `--color-void-dim` | `hsl(165 60% 20%)` | Background wash behind the accent (borders, subtle fills). |
| `--color-void-glow` | `hsl(165 80% 70%)` | Lighter readable text on dark background using the accent hue. |

All three proposed tokens follow the existing DTCG pattern and would be generated into `globals.css` like the other semantic tokens. If a different option is chosen, no ui-kit changes are needed.

---

## Click-to-copy affordance summary

Each option shows a different pattern for the resume-command copy:

| Option | Pattern | Copied feedback |
|---|---|---|
| 1 | Inline monospace button in header — command is the label, truncated | Green border + text flips to "✓ copied" for 1.8 s |
| 2 | Labelled "Copy resume cmd" pill button; full command shown in code block below header | Pill turns green + "✓ copied!"; code block stays visible |
| 3 | Full command always visible in a prompt bar below the titlebar; `[copy]` bracket button at right end | Button text flips to `[copied]` with green color for 1.8 s |
