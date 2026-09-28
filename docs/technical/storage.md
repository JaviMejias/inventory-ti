# Storage

This document defines how files are stored and validated.

Related documents:

- [backend.md](backend.md) — upload handling and configuration.
- [security.md](security.md) — upload validation and secret handling.
- [decisions.md](decisions.md) — ADR-9 (storage abstraction).

## 1. Metadata vs. bytes

- The **database stores file metadata** (name, MIME type, size, dimensions where applicable, hash, related entity, storage key).
- **Actual file bytes are handled through a storage abstraction.**

## 2. Abstraction

- A storage abstraction (interface) decouples domain logic from the concrete backend.
- **MVP: internal/local filesystem storage.**
- **Future: object storage** (e.g., S3-compatible) may be introduced **without changing domain logic**.
- Domain logic operates on the abstraction, never on concrete filesystem paths or provider SDKs.

## 3. Validation

Validate on upload:

- **MIME type**;
- **file size**;
- **dimensions** where applicable (e.g., images).

Rejections return structured errors (see [backend.md](backend.md) §6). See also [security.md](security.md) §6.

## 4. Image processing

Support, where the use case needs it:

- compression;
- resizing;
- optimized versions;
- thumbnails;
- lazy loading in the frontend.

**Do not store both original and optimized files unless a concrete MVP requirement needs the original.**

## 5. Integrity & lifecycle

- Ensure keys/paths are safe (no path traversal), generated server-side.
- Metadata in the database references stored bytes; ignore-from-serve of private files requires authorization.
- Clean-up (deletion) of orphaned stored bytes aligns with the reference in the database; exact policy is an implementation concern.