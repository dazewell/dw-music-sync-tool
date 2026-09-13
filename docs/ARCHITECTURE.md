# soundiiz-client architecture

## Status and goals

The repository currently contains a TypeScript scaffold: `src/api` owns an Axios-based `SoundiizApiClient`, `src/config` validates environment configuration with Zod, `src/services` contains a playlist-service placeholder, and `src/cli` and `src/web` expose initial interfaces. Backup, sync, and durable storage behavior are target components, not yet complete implementations. The architecture below preserves those boundaries as the client grows.

The client should support reliable playlist backup and synchronization while keeping provider-specific behavior isolated. It should be usable from automation and from a human-facing CLI or web interface, with a dry-run-first workflow for operations that can modify remote services.

## System context

```text
CLI / Web UI
    |
Application services (backup, sync, preview, restore)
    |
Domain model + operation plans
    |                    \
Provider ports             Storage ports
    |                         |
Soundiiz adapter       Backup store / state store
    |
Soundiiz API and provider connections
```

Spotify and YouTube Music are domain providers involved in playlist content. Soundiiz is the integration surface for the client where applicable; provider-specific capabilities must not leak into the canonical model.

## Components

### Soundiiz API integration

The integration adapter owns authentication/session setup, request construction, pagination, throttling, retries, response validation, and provider error mapping. It exposes typed ports to the application layer rather than leaking HTTP responses or SDK types. Credentials and session material are supplied through validated configuration and are never written to logs or backups.

API behavior must be treated as externally versioned and changeable. Record observed endpoints, payload shapes, limits, and required headers in `docs/MEMORY.md` with a source and date. Contract tests should use captured, redacted fixtures; live tests must be opt-in.

### Playlist Backup Engine

The backup engine reads source playlists through a provider port, normalizes them into the canonical model, and writes an immutable or versioned snapshot through a storage port. A snapshot should preserve playlist identity, name, description, ordering, track/provider references, unavailable items, ownership, and capture time. Re-running a backup should be idempotent and should not overwrite historical snapshots accidentally.

Backup format and schema migrations belong to the storage boundary. The engine should be able to produce a manifest and a human-readable export without requiring the CLI to understand provider payloads.

### Sync Engine

The sync engine compares two canonical collections and produces an explicit operation plan: additions, removals, metadata changes, unresolved matches, and skipped items. Matching should prefer stable provider IDs, then carefully scoped normalized metadata; fuzzy matching must be explainable and never silently replace a track.

The plan is reviewed or previewed before apply. Apply executes operations through provider capabilities, records per-operation results, supports safe retries, and verifies the resulting state when possible. Capability gaps (for example, unsupported ordering or unavailable tracks) become visible plan outcomes rather than hidden data loss.

### CLI and web interface

Both interfaces are thin adapters over application services. They handle configuration selection, authentication prompts, progress, plan display, confirmation, exit codes, and presentation of errors. They must not call provider APIs directly or implement separate sync logic. The CLI should support non-interactive automation, structured output, dry-run, and cancellation. A future web interface should use the same application service layer and enforce authentication/authorization at its boundary.

### Storage and configuration

Storage is split conceptually into:

- **Backup store:** versioned playlist snapshots and manifests.
- **State store:** operation checkpoints, mappings, sync history, and provider cursors.
- **Configuration/secrets:** typed non-secret settings plus an external secret source or environment variables.

Use atomic writes and explicit schema versions. Never store access tokens in snapshots. Configuration is loaded and validated once at startup; adapters receive typed values and do not independently read environment variables.

## Data flow

1. The interface validates the requested source, destination, filters, and mode.
2. An application service loads configuration and asks a provider adapter for pages of data.
3. The adapter validates and normalizes responses into provider-neutral entities.
4. Backup stores a snapshot, or sync compares entities and emits an operation plan.
5. In apply mode, the engine executes the plan with bounded retries and checkpoints.
6. The engine records outcomes and performs verification; the interface renders a summary and actionable failures.

## Cross-cutting requirements

- Do not log secrets or full user libraries.
- Make rate limits, retries, pagination, and cancellation explicit.
- Preserve deterministic ordering and stable identifiers in exports.
- Keep dry-run side-effect free.
- Test provider adapters with contracts and application logic with deterministic fixtures.
- Update this document when a boundary, persistence contract, or data-flow guarantee changes.

