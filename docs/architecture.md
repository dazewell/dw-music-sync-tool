# Architecture and the next sync feature

## Decision record

The first vertical slice is **bulk owned-playlist metadata backup** using the
official YouTube Data API, a loopback web interface and a scriptable CLI. The user
explicitly accepted the official API's incomplete YouTube Music library coverage.
There is no scraper, browser-cookie extraction, audio downloader or required
Soundiiz subscription.

TypeScript and Node.js keep the provider, application and interface contracts in
one language, consistent with the direction in issue #1. The browser uses small
framework-free modules; neither backup correctness nor future sync policy
depends on a UI framework. Google OAuth uses its maintained authentication
library; the provider's HTTP calls remain injectable and independently testable.

## Boundaries

```text
CLI ------------------+
                      +--> backup application service --> PlaylistProvider
Loopback HTTP / web --+          |                           |
                                v                           +-- YouTube reader
                         local archive repository           +-- demo fixtures
                                |                           +-- future Spotify reader
                         JSON / CSV / M3U8
                         checkpointed manifest

Future:
pair repository --> observe --> plan --> user approval --> executor --> verify
                         |                    |                 |
                  provider baselines   matching decisions    direct API writes
                                                           or Soundiiz trigger
```

`src/core/models.ts` owns normalized playlist and occurrence records. Platform
IDs remain platform IDs; a YouTube video ID is never assumed to equal a Spotify
track ID. Every occurrence has an item identity and position, so repeated tracks
and unavailable entries survive export. Provider-specific data is retained
without mixing credentials into domain records. YouTube snapshot positions must
be contiguous and zero-based after sorting, even when API count hints agree;
gaps fail explicitly rather than being renumbered into an incomplete archive.

`src/providers/youtube.ts` owns endpoint details, pagination, response validation,
quota/rate-limit handling and coverage statements. `src/auth/google.ts` owns
Google credentials and token refresh. Neither knows about HTML or filenames.
A single validated pending token save is completed before using authorization;
multiple or unprovable intents require explicit inspection rather than guessing
their order. Disconnect enumerates validated pending tokens independently of the
main file and revokes/removes both, with explicit remote and local failure states.
Both credential paths share descriptor-based, no-follow reads where supported,
with single-link regular-file checks and bigint identity checks around the read
and before cleanup. Persisted credentials require the exact read-only scope.
An omitted code-exchange scope is verified through Google token info before
persistence; an omitted refresh scope inherits only the validated stored scope.

`src/core/backup.ts` and storage helpers own run lifecycle, portable filenames,
atomic writes, export formats and history. JSON is the authoritative archive;
CSV and M3U8 are projections, not lossless restore formats. Unknown/unavailable
metadata is explicit. No remote deletion or mutation is a backup operation.

`src/server/app.ts` translates HTTP into the same service used by `src/cli.ts`.
It limits execution to one in-flight backup, keeps live progress in memory and
serves only manifest-listed export files. Synchronous reservations span backup
preflight and execution, inventory reads and credential-changing operations so
disconnect or token replacement cannot interleave with a provider read. Conflicting
API operations return explicit 409 responses; browser OAuth callbacks preserve
the redirect-based error flow and do not consume pending state on a mismatch.
Status returns a typed `connectionError` alongside the session/CSRF information
for malformed tokens or Desktop-client configuration, with `connected: false`
and the known configuration state. Other errors still fail the request. The UI
retains actionable errors and offers a connection recheck independent of playlist
reads; a failed status check clears stale authorization before controls render.
The manifest, rather than browser
memory, is the durable record. Process locks protect both the data directory and
backup directory, including when different accounts choose a shared output path.
After acquiring both, the CLI recovers interrupted manifests before starting
cleanup or accepting work. These are local locks, not distributed locks.
Locks atomically publish a prepopulated directory with a nonce-specific marker.
Release removes only that lease's unique marker and then attempts an atomic
empty-directory removal, so a stale release cannot unlink a successor's marker.
Concurrent/repeated release calls share one promise. Legacy regular lock files
remain blocking; stop older application versions before upgrading, and never
manually remove a live lock.

## Backup semantics and limitations

- Discover the complete paginated owned-playlist inventory anew for each run.
- Fetch one playlist at a time. Continue individual failures and record them.
- Preserve duplicates, ordering and inaccessible-entry indicators.
- Persist an export intent before publishing files, write atomically, checkpoint
  per-playlist results, then finalize status. The intent binds the checkpoint,
  output/staging paths, byte counts and content hashes. Recovery removes only
  verified owner-only empty runs; uncheckpointed outputs with validated intents
  remain unavailable for download but eligible for normal expiry. Unknown,
  changed or unprovable leftovers remain protected and produce an explicit error.
  Manifest v1 adds optional `playlists[].integrity.{json,csv,m3u}` records containing
  original `{size, sha256}` values. New completed exports retain these values
  before their pending intent is removed; failed and legacy results omit them.
  New files use atomic hard-link publication from flushed staging files; rename
  is reserved for explicit checkpoint replacement. Filesystems without hard-link
  support fail explicitly. A journaled output/stage pair is recoverable only with
  matching original bytes, exact device/inode identity and exactly two links;
  recovery removes only the redundant stage after a complete ownership preflight.
  Unjournaled metadata stages are preserved for inspection. Failed ownership
  initialization attempts only empty-directory removal and reports cleanup
  failures alongside the original error.
- Keep existing run contents unchanged until their 30-day expiry; don't turn a
  failed fetch into an empty playlist or overwrite a previously good export.
- Fingerprint ordered provider-native identities, not display names, added dates
  or observation times. Metadata changes are a separate future concern.
- A `complete` run means all discovered playlists were exported from the available
  API response, not complete coverage of the entire Music library or recovery of
  hidden/deleted metadata.
- API pagination is not a transactional snapshot. Count checks detect some
  concurrent edits, but same-size reorder/replacement races may not be detectable.
  A future apply operation must re-observe inputs and reject stale plans.
- Retention is a user-approved rolling 30-day history, not an indefinite archive.
  Persistent per-run ownership markers and validated manifests gate deletion.
  `src/core/retention.ts` preflights managed files and removes only recognized,
  expired, inactive runs without following links or recursively deleting content.
  Original manifest/journal hashes protect against same-name replacements; missing
  files allow retry of partial deletion, but reappearing or changed files stop it.
  Legacy manifests remain readable, but exports without original integrity proof
  are preserved with a cleanup warning and require manual resolution. Existing
  contents are never silently hashed and adopted as ownership evidence.
  `src/services/retention.ts` shares startup/minute cleanup between server and CLI.
  Failures are visible; expired data is not served and unresolved cleanup blocks
  new backups. User-created copies and shutdown/sleep gaps are explicitly outside
  the scheduler's enforcement. Revocation/user-requested deletion and wider API
  compliance remain separate obligations, documented rather than claimed solved.

No automatic retry of a whole backup occurs after restart. Interrupted history
remains visible and a new run receives its own identity. In-memory job IDs are
not durable API job handles; manifest IDs are durable archive identifiers.

## Changes to the assumptions in issue #1

**Do not use "most recent timestamp wins."** Spotify `snapshot_id` is a version
identifier, not a timestamp. YouTube does not expose a dependable general
playlist-content modification timestamp. `added_at`/`publishedAt` cannot detect
all removals or reorders. `last_verified_at` records a local outcome, not a
platform modification.

**Soundiiz triggering is currently documented.** The live
https://soundiiz.com/api/doc specification, checked September 13, 2026, exposes
listing, getting, deleting and triggering existing syncs. It does not document
creating/updating their configuration. `POST /v1/me/syncs/{id}/trigger` requires
Creator and an account-scoped key. A 202 means accepted; even HTTP 200 may report
`SYNC_PROCESSING` or `SYNC_PENDING`, not success. The adapter must interpret the
documented response body, handle destination-busy conflicts, and verify the
destination rather than treating acceptance or `idle` as successful convergence.
Future implementation should re-check this preview API before relying on it.

**Spotify eligibility and endpoint shapes have changed.** Current 2026
development-mode documentation limits playlist-content reads to playlists the
user owns or collaborates on, despite broader metadata discovery. Use the current
`/playlists/{id}/items` endpoints and `/me/playlists` creation endpoint rather than
copying deprecated `/tracks` examples. The app owner needs Premium; development
mode allows five authenticated allowlisted users for new apps. Current quota is
shared across the developer account. These are future integration gates; no
Spotify access is requested for YouTube backup.

## Planned manual same-name sync

The pure name-pairing and baseline helpers in `src/core/sync.ts` are implemented
now. Persistent pairing workflows and all remote writes are **future work**.
Future observation, match and baseline storage must also respect provider
retention rules rather than silently extending the lifetime of API-derived data.

1. **Read-only discovery.** Add Spotify reader and account identity/capability
   records. Request only needed read scopes. Surface unreadable or incomplete
   playlists; never represent them as empty.
2. **Pair and ignore.** Suggest names normalized with Unicode normalization,
   whitespace collapsing and case folding. A unique name match is a suggestion,
   not authorization. Show duplicate-name candidates for user choice. Persist
   stable provider/account/playlist IDs and independent ignore records; names
   can change without breaking a confirmed pair.
3. **Choose direction and operation.** Require a source, destination and a
   deliberate add-only versus replace policy. Bidirectional sync is not two
   blind replacement jobs. Confirm deletions, reorder and duplicate semantics.
4. **Resolve recording identity.** Use ISRC when available, artist/title/album/
   duration evidence, explicit user overrides and confidence thresholds.
   Distinguish live, remaster, cover, clean/explicit and music-video variants.
   Save ambiguous/unmatched items for review instead of accepting the first
   search result. Do not describe channel-owner labels as recording artists.
5. **Observe and plan.** Compare each platform against its own last verified
   fingerprint. Do not compare raw Spotify and YouTube hashes to each other.
   Neither changed: skip. Source changed: eligible for a plan. Destination-only
   or both changed: require review according to the confirmed policy. No
   baseline: require an initial direction/plan decision.
6. **Approve and execute.** Display additions/removals/reorders and unresolved
   matches before obtaining incremental write consent. Back up the destination.
   Lock the pair and destination; re-read both sides to invalidate stale plans.
   Apply bounded batches with checkpoints and explicit error/retry semantics.
7. **Verify and record.** Re-read the destination and compare with the expected
   semantic result through the accepted identity mapping. Only then advance
   both provider-native baselines and `last_verified_at`. A partly applied plan
   is a partial outcome, not a new successful baseline.

Direct Spotify/YouTube writers and a Soundiiz executor can share the planner and
verification boundary, but have different capabilities. Soundiiz configurations
must be created separately and their source, destination and add/replace mode
verified before triggering. No trigger idempotency key or reliable per-run result
history is documented; an uncertain timeout must be reconciled, not blindly
triggered again.

## Planned durable sync state

Keep portable backup files. Introduce **SQLite** for transactional sync state when
the pairing workflow lands; JSON files are sufficient for current independent
archive manifests, but not for related pair/baseline/operation updates.

Proposed records:

| Record | Key data |
| --- | --- |
| Account | provider, account ID, capabilities, credential-vault reference |
| Pair | source/destination account and playlist IDs, direction, method, enabled |
| Ignore | account/provider/playlist ID, reason, created time |
| Observation | ordered fingerprint, provider version, completeness, observed time |
| Match | source identity, destination identity, evidence, confidence, override |
| Plan | input fingerprints, ordered changes, unresolved matches, approval |
| Run | plan ID, executor, stage, checkpoints, result/error, verification |
| Baseline | pair ID, verified source/target fingerprints, last verified time |

Credentials never belong in these records, exports or logs. Before expanding
distribution, replace the current explicitly documented private token file with
OS credential storage and establish encryption/access rules for library data.

## Scheduling is later, not a second engine

Manual and scheduled triggers must call the same planner/executor. Scheduling
must obey ignored/disabled pairs, destination locks, quota limits, review-required
conflicts and persistent run reconciliation. A sleeping/offline local machine
cannot run jobs; choose an explicit catch-up policy. Do not combine unobserved
Soundiiz scheduling with local scheduling for the same destination.

Decisions still requiring user input: overwrite versus add-only defaults,
two-sided conflicts, automatic matching confidence, missing/unavailable track
handling, deletion approval, metadata synchronization and catch-up behavior.

## Verified references

- [YouTube playlist discovery](https://developers.google.com/youtube/v3/docs/playlists/list)
- [YouTube playlist items](https://developers.google.com/youtube/v3/docs/playlistItems/list)
- [YouTube Music playlist visibility](https://support.google.com/youtubemusic/answer/7205933)
- [Google native-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [OAuth expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [YouTube quota table](https://developers.google.com/youtube/v3/determine_quota_cost)
- [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies)
- [Spotify February 2026 migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [Spotify July 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/july-2026)
- [Spotify playlist versions](https://developer.spotify.com/documentation/web-api/concepts/playlists)
- [Spotify loopback redirects](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)
- [Soundiiz published User API](https://soundiiz.com/api/doc)
- [Soundiiz access requirements](https://support.soundiiz.com/hc/en-us/articles/37958897763730-Soundiiz-API-Access-Creator-API-Key-and-Public-Playlist-Import)
