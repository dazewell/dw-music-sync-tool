# Project memory

This file is the durable, verified knowledge base for soundiiz-client. It is intentionally conservative: unknown behavior belongs in the open questions section until confirmed. Add a source and date to facts that can change.

## Repository baseline

- Repository: `dazewell/dw-soundiiz-client`.
- Current baseline: a TypeScript scaffold with `src/api`, `src/config`, `src/services`, `src/cli`, `src/web`, and `src/types` modules. The API client uses Axios and the configuration boundary uses Zod defaults.
- Target boundaries and data flow: `docs/ARCHITECTURE.md`.
- AI workflow rules and delegation protocol: `.github/copilot-instructions.md`.

## Domain model

The canonical model should represent playlists, tracks, playlist entries/order, provider references, ownership, visibility, unavailable items, and capture/sync timestamps. Keep provider-native IDs and metadata alongside normalized fields so a backup can be reconciled without relying only on title/artist matching.

A backup is a point-in-time snapshot. A sync is a planned set of changes between collections. A plan must be inspectable, serializable, and safe to re-run; unresolved matches and unsupported capabilities must be explicit outcomes.

## Soundiiz API notes

The current scaffold defaults to `https://api.soundiiz.com/v1` and sends an `x-api-key` header, but no endpoint, authentication flow, schema, quota, or pagination contract has been verified in this repository yet. Treat these defaults as implementation placeholders until confirmed. Do not invent endpoint names or assume that a browser session, private API, or undocumented payload is stable. When investigating the integration, record:

- source URL or captured fixture and observation date;
- authentication/session requirements and token lifetime;
- pagination and rate-limit behavior;
- playlist/track request and response shapes;
- write semantics, ordering guarantees, and idempotency behavior;
- error codes and retry-safe versus non-retry-safe operations.

Redact credentials, cookies, authorization headers, and personal library data from fixtures and logs. Prefer an adapter with contract tests and an opt-in live integration suite.

## Platform notes

### Spotify

Treat Spotify IDs as stable references when available, but do not assume every track is playable or available in every market. Preserve ISRC, artist, album, duration, explicitness, and market/availability metadata when returned. Respect OAuth scopes, token expiry, pagination, rate limits, playlist ownership, and collaborative/private playlist permissions. Confirm current API policy and limits before implementation; this section is not a substitute for current Spotify documentation.

### YouTube Music

YouTube Music access and playlist behavior may vary by client/library and authenticated account. Preserve video/song/channel identifiers separately from display metadata, and expect unavailable or region-restricted entries. Do not assume that search by title is unique or that a matching result is safe to substitute. Confirm the selected integration's authentication, consent, rate limits, playlist ordering, and write capabilities before relying on them.

## Workflow conventions

- Start with a small, explicit plan and inspect the relevant files before editing.
- Keep provider logic behind ports/adapters; keep CLI/web code thin.
- Use dry-run and preview for mutating operations.
- Make changes idempotent, preserve user data, and surface partial failures.
- Run focused formatter/linter/type/test checks, then broader checks when shared code changes.
- Child-agent handoffs must list changed files, decisions, tests, risks/blockers, and follow-up. The orchestrator integrates and performs final cross-component validation.
- Never commit secrets, raw authenticated captures, or private playlist exports.

## Open questions

- Is Soundiiz an official API dependency, an existing integration, or an intermediary service for provider operations?
- What backup format and storage backend are required?
- Which sync directions and conflict policies are in scope?
- Which authentication mechanism is approved for Spotify and YouTube Music?

## Updating this file

Only add durable facts that were verified from code, tests, provider documentation, or a redacted reproducible observation. Put volatile facts beside their source and date. Record decisions rather than every transient debugging detail.



