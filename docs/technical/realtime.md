# Realtime (WebSocket)

This document defines the realtime model: source of truth, publish timing, delivery guarantees, and recovery.

Related documents:

- [architecture.md](architecture.md) — request pipeline.
- [workflows.md](../product/workflows.md) — operation pipeline including the realtime step.
- [decisions.md](decisions.md) — ADR-7 (WebSocket after commit).

## 1. Source of truth

**PostgreSQL/API state is authoritative.** WebSocket is **not** a source of truth; it is a delivery/notification channel over which committed changes are broadcast to connected clients.

## 2. Publish model

```text
Client request
    ↓
validation
    ↓
authorization
    ↓
database transaction
    ↓
commit
    ↓
publish WebSocket event
```

- **Never publish a success event before the transaction commits.**
- If the transaction **fails**:
  - no partial state;
  - no success event.

The event is published only after a successful commit, from the backend (see [backend.md](backend.md) §7).

## 3. Delivery guarantees (deliberately weak)

It is **acceptable** for a client to miss an event because of:

- temporary disconnection;
- network failure;
- process failure immediately after commit.

No Redis, Kafka, queues, or event buses are introduced to strengthen delivery (ADR-7; see also ADR-1).

## 4. Recovery model

```text
disconnect
   ↓
reconnect
   ↓
authenticate
   ↓
resync through REST API
```

- On reconnect, the client authenticates (session) and **resyncs authoritative data through the REST API**.
- The WebSocket feed then continues for subsequent events.
- See [frontend.md](frontend.md) §5 for client-side consumption.

## 5. Event content (conceptual)

Events carry enough to refresh views (e.g., inventory changed for product X, correction state changed, low-stock condition changed). Clients use events to invalidate/refresh the relevant REST reads rather than treating payloads as authoritative full state.