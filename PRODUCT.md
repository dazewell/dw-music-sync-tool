# Music library tool

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A music listener managing a personal library across YouTube Music and Spotify,
starting with bulk local playlist backups instead of one-at-a-time exports.

## Product Purpose

Preserve playlist metadata and ordered entries in local files, then grow into a
cross-platform library manager with deliberate, inspectable synchronization.
Backups are playlist records, not downloaded audio.

## Operating Context

The repository starts on Windows. The user prefers a web interface and accepts
a terminal application. The first release will run locally, not as a hosted service.

## Capabilities and Constraints

- Back up all account-owned playlists exposed by the official YouTube Data API.
- The user explicitly chose official APIs only, accepting incomplete coverage
  of saved third-party and special YouTube Music library playlists.
- Never claim that an official YouTube export covers the entire Music library.
- Keep each export local with a rolling 30-day history. After reviewing the
  official API retention policy, the user explicitly approved automatic removal
  of expired app-created backups while the app is running. Never delete unrelated
  files or imply that a stopped local app can enforce a deletion deadline.
- The next requested feature is manual sync between Spotify and YouTube Music
  playlists matching by name; issue #1 also describes pairing, ignored playlists,
  history and eventual scheduling.
- Treat the supplied API comparison as a research starting point, not authority.
- Direct-API bidirectional sync is implemented per issue #1's explicit,
  user-confirmed decisions: pairs are explicit and provider-agnostic; a
  "Sync Pair" run always re-observes and mirrors both sides against the last
  verified baseline (never a blind one-shot replace); "Auto-pair by name"
  creates a pair immediately for every unique normalized-title match with no
  confirmation step, and skips and reports ambiguous titles; every run and
  every per-item removal is recorded in a durable, searchable audit trail.
  Provider writes (YouTube via a separately-consented write scope, Spotify via
  an operator-provided refresh token) are in scope for this release, not
  future work.

## Evidence on Hand

The user's brief and GitHub issue #1. There is no existing implementation,
visual identity, user library data or account authorization in the repository.

## Product Principles

- Be precise about coverage and partial failures.
- Keep local records useful without this application.
- Separate platform access from backup and sync policy.
- Require an explicit plan before future cross-platform changes.

## Open Decisions

Sync direction is bidirectional per pair (mirroring both sides against the
last verified baseline, not a one-shot copy); deletion handling mirrors
removals on the changed side and records every one in the audit trail; track
matching for pairing uses an exact normalized-title match only (no fuzzy
threshold); and scheduling remains manual (an explicit "Sync Pair" or "Sync
all pairs" action) with no background/automatic runs yet. Cross-provider
track-level translation (matching a specific YouTube video to a specific
Spotify track) remains unresolved, so a pair with untranslated cross-provider
entries is reported as review-required rather than written.
