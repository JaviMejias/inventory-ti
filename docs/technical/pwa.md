# PWA

This document defines the PWA behavior of the web application.

Related documents:

- [architecture.md](architecture.md) — system context.
- [frontend.md](frontend.md) — frontend UX.
- [realtime.md](realtime.md) — connectivity and resync.
- [security.md](security.md) — session preservation and cache policy.
- [decisions.md](decisions.md) — ADR-6 (online-first PWA).

## 1. Model: online-first

The application is **online-first**:

- the API is authoritative;
- realtime keeps open views fresh;
- the app works with the network by default.

**Offline inventory mutations are out of MVP scope.** The PWA must not claim to allow inventory changes while disconnected.

## 2. PWA capabilities

The PWA should:

- **cache the application shell / static assets** (versioned build assets, icons, offline shell fallback page);
- provide **installable app behavior** (manifest, icons, service worker requirement);
- **detect connectivity state** (online/offline indicators, toasts);
- **reconnect when connectivity returns**;
- **resync authoritative data from the API** on reconnect (see §4).

## 3. Cache policy

- Cache **static application shell** assets (JS/CSS bundles, images/icons).
- **Do NOT indiscriminately cache private inventory API data.**
  - No wholesale caching of API responses for inventory, assets, movements, corrections, or reports.
  - Cache policy must respect authentication: private data must not be served from cache without a valid session.
- Runtime data is fresh from the API (or via WebSocket refresh), not from a persistent offline cache.

## 4. Reconnect & resync

On reconnect:

1. detect connectivity;
2. re-establish WebSocket (see [realtime.md](realtime.md) §4): disconnect → reconnect → authenticate → **resync through REST**;
3. refresh current views from authoritative data;
4. notify the user when appropriate.

## 5. Update flow

When a new application version is available:

- **detect** it;
- **inform** the user;
- provide an **update action**;
- **activate** the new version;
- **reload** as appropriate.

Requirements:

- Do **not** require uninstalling the PWA or clearing browser data.
- The **session must remain intact** through normal application updates (session cookie is unaffected by shell updates; see [security.md](security.md) §8).

## 6. Out of scope (MVP)

- Offline inventory mutations.
- Full offline mode with queued writes and synchronisation jobs.