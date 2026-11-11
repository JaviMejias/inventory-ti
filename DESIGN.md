---
version: alpha
name: "Inventory TI"
description: "Chilexpress internal IT inventory control room: a precise yellow, black and white operational workspace."
colors:
  primary: "#FFD000"
  ink: "#0A0A0A"
  panel: "#151515"
  paper: "#F7F7F5"
  yellow: "#FFD000"
  info: "#2563EB"
  success: "#22C55E"
  warning: "#C2410C"
  danger: "#D95D6A"
  text: "#171717"
typography:
  sans:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
rounded:
  DEFAULT: "0.75rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
spacing:
  section-gap: "3rem"
  page-max: "73.75rem"
components:
  button: { rounded: "0.75rem", height: "2.875rem", backgroundColor: "yellow", textColor: "ink" }
  card: { rounded: "1rem", backgroundColor: "panel" }
  dialog: { rounded: "1rem", backgroundColor: "paper" }
  input: { rounded: "0.75rem", height: "3rem", backgroundColor: "paper", textColor: "text" }
  status: { backgroundColor: "panel", textColor: "yellow" }
  accent: { textColor: "yellow" }
  warning: { textColor: "warning" }
  error: { textColor: "danger" }
---

# Inventory TI Design System

## Overview

### Creative North Star

Inventory TI is a Chilexpress operations control room: yellow acts as the moving operational signal, black provides structure, and white keeps dense work legible. The login is the threshold into that room, pairing a technical instrument panel with a warm, legible form rather than a generic SaaS card.

### Product context and register

- **Audience and primary job:** Internal IT staff sign in to manage products, quantitative stock, individual assets, assignments, and corrections.
- **Target market(s) and evidence:** Chilexpress internal operations in Chile; the company identity is predominantly yellow, black and white, while the interface uses Spanish copy and `es-CL` formatting.
- **Locale(s) and language policy:** Spanish UI, with `es-CL` dates and conversational operational verbs. Technical identifiers remain unchanged.
- **Usage scene:** Desktop-first internal work, with narrow-screen access for quick checks. The login must remain clear under low attention and keyboard use.
- **Register:** Product-first with a restrained brand layer across the authentication threshold and operations dashboard.
- **Memorable signature:** A yellow logistics signal that starts in authentication and resolves into the active rail marker and calm operational surfaces.
- **Restraint:** Forms, errors, and permission-sensitive actions stay quiet, high-contrast, and predictable.
- **Anti-references:** No generic gradient hero, floating marketing testimonials, or decorative glassmorphism that competes with operational information.
- **Token ownership/runtime mapping:** This file owns the durable visual intent; runtime values are implemented in `apps/web/src/styles.css` under `--auth-*`, `--dashboard-*`, and the reusable `--ui-*` foundation tokens. The UI tokens map brand, informational, success, warning, danger, surface, text, border, radius, motion, and control-height semantics to the primitives and feedback components in `apps/web/src/ui`. Review token drift when the visual system changes.

## Colors

Corporate yellow is reserved for identity, primary actions, active state and low-intensity highlights; it is not a warning color. Solid yellow always uses black text, while yellow text on light surfaces uses the darker --ui-brand-text variant. Information is blue, success is green, warning is a clearly separate orange (#C2410C), and danger is red/rose. Semantic meaning never relies on color alone. The application and login share explicit light and dark preferences plus a system-following mode, defaulting to the system; all three reuse the same semantic token layer. Operational surfaces use a neutral graphite-and-white base; yellow identifies the product and active work while green remains reserved for confirmed success or availability.

## Typography

The existing Inter/system stack remains the canonical family so no external font loading or layout shift is introduced. Uppercase micro-labels use tracking for instrument-like metadata; headings use compact bold weights; form labels and error copy use sentence case and generous line height. Monospace is reserved for technical identifiers and future data surfaces.

## Layout

The login uses a two-panel shell capped at 1180px: a restrained inventory illustration and short headline carry the desktop signature, while the form panel owns the task. Brand and the shared theme switcher occupy an in-flow header, wrapping at narrow widths instead of overlaying the title. Below 1024px the story panel is hidden and authentication becomes one compact, naturally scrolling column; no fixed form height or secondary feature cards compete with signing in. Operational indexes and the dashboard use the full content width; desktop navigation uses a persistent dark rail so route context stays stable while data changes. The rail keeps brand, primary destinations, session status and account actions in one place; the top bar only carries current view context, theme and compact account controls. Dashboard prioritizes compact period filters, metrics, charts and actionable lists, not a session/profile hero or module shortcuts. Mi cuenta separates editing controls from the personal identity/contact sheet. At responsive widths up to 1023px, the rail collapses away and the compact top header keeps brand, theme and account controls; feature screens preserve their existing safe-area-aware bottom navigation where present. Controls preserve a 44–48px touch target.

## Elevation & Depth

Depth comes from tonal layering and three restrained elevation roles: surface for resting content, dropdown for anchored overlays and dialog for modal focus. Their runtime tokens are --ui-shadow-surface, --ui-shadow-dropdown and --ui-shadow-dialog, with theme-specific values. The story panel keeps the restrained grid signature at the authentication threshold; operational surfaces stay quiet and metric/chart surfaces remain shallow so information stays in focus. Yellow identifies brand actions while accessible blue focus rings remain available where yellow would not contrast against white.

## Shapes

Controls and cards use medium rounded corners (`0.75rem`–`1rem`) with thin borders. The asset-state donut encodes distribution rather than decoration; ordinary controls do not become pills unless they are status badges. Continuous index filter/header bands keep their shared square-edged join rather than becoming detached rounded cards.

## Components

### Foundational visual states

Inputs have quiet borders, a visible high-contrast focus ring, an explicit invalid state, and preserved values. The submit button keeps its dimensions while busy and exposes a spinner plus text. Errors are inline live content, never a browser alert.

### Buttons and actions

The primary login action is yellow with black text and a right-arrow cue. Hover brightens the signal, focus uses a two-layer ring, and busy state disables duplicate submission without changing width. Secondary actions use borders and subdued text.

### Forms and overlays

The login uses real labels, password-manager autocomplete, app-owned validation messaging, a keyboard-accessible password reveal control, and `noValidate`. Application dialogs use the native dialog element with focus restoration, internal scrolling, a short enter/exit transition, and the global reduced-motion override.
### Toasts and transient feedback

Toasts are compact control-room signals: a theme-owned elevated surface (warm light or ink dark), brand-yellow accents, a semantic status cue and action-aligned Spanish copy. They stay fixed at the top-right above overlays, including the active native dialog, reflow to the phone safe area, and never replace corrective inline errors. Success, information and warning messages expire; errors remain until dismissed. Motion is a short directional arrival plus a visible lifetime rail and respects reduced-motion preferences. Host connectivity and duplicate refresh timing are specified in UX-CONTRACT.md.


### Selects and switches

The app owns `Select`/listbox geometry where filters or entity choices need visual consistency: the popup matches its trigger width, has bounded scrolling, opens away from a viewport edge, and supports keyboard selection. Use the simple variant for a small fixed choice set; enable local search only when the option set is large enough to benefit from it. Searchable lists render a short result window and ask the operator to refine the query instead of flooding the popup. Use the shared `Switch` for reversible active/inactive state; its active rail uses brand yellow rather than semantic success green, while the rail, thumb, state glyph and adjacent state copy remain visually unmistakable. Green remains reserved for status feedback. Keep confirmation when the domain operation needs one. Do not add screen-local select, toggle, or modal implementations.

### Operational tables

Catalog is one continuous operational surface for products, not a stack of cards: its shared module header carries context and the primary add action, the filter band contains only query controls, and the canonical data table owns the records below. Light mode uses neutral white and graphite surfaces; dark mode uses ink surfaces without changing hierarchy. Tables use the full available content width with deliberate column proportions, a yellow contextual signal rule and calm alternating row surfaces. Identity cells pair the product icon with its name and last-update metadata; semantic chips carry tracking and lifecycle information. Administrative actions live in a quiet control dock at the row edge. At widths up to 1023px, every tabular row across the app reflows into a labeled record card; inventory cards put product/asset identity first, key values in a compact two-column grid, and actions in a clear footer.

Responsive record cards share the desktop palette and status meanings. Each card starts with the complete product/user identity, followed by labeled values and a separated action footer. Long names, SKU, serial numbers and access identifiers wrap instead of clipping; secondary quantities can share two columns, while long values use the full card width. Actions keep touch-friendly height and never inherit flex-basis heights from desktop. Tablet-width lists may place two independent record cards side by side. Loading placeholders follow the same card geometry; document scrolling keeps the entire record and its actions reachable.

### Iconography

Icons are inline SVGs with a 1.75px round stroke, aligned optically to the text baseline. Icon-only controls always have a Spanish accessible name; decorative icons are hidden from assistive technology.

### Motion

Motion is limited to the authentication grid, a verified-session pulse, a short staggered reveal, and compact dialog/select transitions. Operational navigation uses immediate active-state feedback so route context feels dependable rather than theatrical. Interactive transitions are short and purposeful. The global reduced-motion rule disables ambient movement and compresses transitions.

### Content and data visualization

Copy names the user action directly: “Iniciar sesión”, “Ingresar”, and “Mostrar contraseña”. Login copy is limited to identity, sign-in instructions and necessary recovery. The inventory illustration is decorative and hidden from assistive technology; no invented metrics or feature-summary cards appear on the authentication screen.

## Text hierarchy

Operational text follows a deliberate two-mode hierarchy: light mode uses strong ink for primary copy and readable neutral graphite for supporting copy; dark mode uses warm white as the default and light silver only for secondary metadata. Yellow is reserved for operational labels, active context and emphasis, never for long body copy. Placeholders and helper text remain readable and are never reduced to low-contrast gray.

## Frozen visual rules

1. Yellow means identity, primary action and active state.
2. Warning uses orange/amber that is visibly distinct from corporate yellow.
3. Solid yellow always carries black text.
4. Yellow used as text on light surfaces uses the darker brand-text variant.
5. Information uses blue.
6. Success uses green.
7. Danger uses red/rose.
8. Operational views use shared UI components.
9. Do not create screen-local button, dialog or badge styles.
10. Surfaces come from semantic tokens.
11. Operational motion is short and functional.
12. Every new component must work in light, dark and system modes.

## Do's and Don'ts

- **Do:** Use yellow as the brand signal for active, actionable system states and preserve semantic colors for meaning.
- **Do:** Keep authentication copy specific, calm, and Spanish.
- **Don't:** Turn operational screens into marketing landing pages.
- **Don't:** Hide errors, focus states, or security affordances behind decoration.
