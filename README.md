# Music library

A local-first music library tool. The first feature backs up **all account-owned
playlists exposed by the official YouTube Data API** in one run, using a local
web interface or a command. Each playlist gets JSON, CSV and M3U8 files.

**These are playlist metadata and video links, not downloaded audio.**
YouTube Music has no separate public API. This tool cannot discover every playlist
saved in the Music app: saved third-party playlists, personalized mixes, Liked
Music and private music uploads are not covered. Owned YouTube playlists may also
include non-music videos that the Music app hides. The UI keeps this limitation
visible rather than calling an incomplete Music-library export "everything."

## Try it without an account

Requires **Node.js 22.12+** and npm.

```powershell
npm install
npm run build
npm run demo
```

Open **http://127.0.0.1:8787**. The clearly labeled demo uses synthetic data,
including an empty playlist, duplicates and an unavailable entry. It makes no
Google requests and stores files separately under `backups\demo`.

## Connect Google

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **YouTube Data API v3** for the project.
3. Configure the OAuth consent screen (Google Auth Platform). For a personal
   External app in Testing, add your own Google account as a test user.
4. Create an OAuth client of type **Desktop app**, not Web application. Download
   its client JSON. Keep the `installed` object as downloaded.
5. Save it as `.local\client-secret.json` in this project:

   ```powershell
   New-Item -ItemType Directory -Force .local
   # Place your downloaded Desktop OAuth JSON at .local\client-secret.json.
   npm start
   ```

6. Open **http://127.0.0.1:8787**, select **Connect Google**, and authorize the
   account/channel that owns your playlists. Only
   `https://www.googleapis.com/auth/youtube.readonly` is requested.
7. Review the discovered playlists and select **Back up all**. Discovery and every
   playlist's contents are paginated; filtering the table never limits the backup.

The app uses the system browser, PKCE and a browser-bound, short-lived OAuth state.
Its default callback is `http://127.0.0.1:8787/auth/google/callback`. Desktop clients
support loopback redirects; do not replace this with the callback setup for a Web
client. The exact URI for your configured port appears in the interface.

Google External apps in **Testing commonly receive refresh tokens that expire
after seven days** for this scope. Reconnect when required. Revocation, password or
account changes and project policy can also invalidate authorization. Google
verification and consent requirements depend on how you distribute the app.
No Spotify account, Soundiiz subscription or YouTube Music Premium subscription
is needed for this release.

If saved tokens are malformed, the interface keeps **Connect Google** available
and shows the connection error so you can authorize again. For a missing or
invalid Desktop client JSON, replace the file at its configured path and use
**Recheck connection**; this does not read playlists or reload the page. Changing
the configured path still requires a server restart. Other status failures remain
explicit and can be retried after the reported local problem is resolved.

## Connect Spotify

Spotify sync is optional and only needed if you want an explicitly paired
playlist mirrored to or from Spotify (see [The path to Spotify / YouTube
sync](#the-path-to-spotify--youtube-sync)). **There is no in-app (web UI)
Spotify connect flow.** You register your own Spotify app and generate a
refresh token with the project-native `spotify-auth` command, once, before
starting this tool.

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
   Note its **Client ID** and **Client Secret**.
2. In the app's settings, add a **Redirect URI** of `http://127.0.0.1:8888/callback`
   (or your own port; see below). This loopback URI is only used by the
   `spotify-auth` command below to receive Spotify's redirect after you
   approve access; this application has no callback endpoint of its own and
   never receives this redirect.
3. Copy `.env.example` to `.env` if you have not already, then set:

   ```
   SPOTIFY_CLIENT_ID=your-client-id
   SPOTIFY_CLIENT_SECRET=your-client-secret
   ```

   Leave `SPOTIFY_REFRESH_TOKEN` unset for now; the next step produces it.
4. Run:

   ```powershell
   npm run spotify-auth
   ```

   This runs a local Authorization Code flow with PKCE and a
   state-protected, loopback-only (`127.0.0.1`) callback listener. It opens
   your system browser to Spotify's consent screen for exactly the scopes
   this tool's Spotify provider needs to read and modify your playlists
   (`playlist-read-private playlist-read-collaborative
   playlist-modify-public playlist-modify-private`), exchanges the returned
   code for a refresh token, and atomically writes only
   `SPOTIFY_REFRESH_TOKEN` into your local, Git-ignored `.env`. The
   authorization code and short-lived access token are discarded once the
   exchange succeeds, and no credential value is ever printed to the
   terminal. Use `--port <number>` if you registered a different Redirect
   URI port.
5. Restart the app (`npm start`) so it picks up the new environment. There is
   no live reload for `.env` changes.

**Never commit, log, paste into an issue/PR, or otherwise expose your Client
Secret or refresh token.** `.env` is Git-ignored, but that only protects you if
you never copy the values elsewhere. Treat a refresh token like a password:
anyone holding it can read and modify your Spotify playlists until it is
revoked (from your [Spotify account apps](https://www.spotify.com/account/apps/)
page) or Spotify rotates/expires it. The three `SPOTIFY_*` variables are
**all-or-nothing**: set every one of them, or leave every one of them unset; a
partial set fails startup with an explicit configuration error instead of
running with reduced access. Running `npm run spotify-auth` itself only
requires `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to already be set;
it is what supplies the refresh token to complete the all-or-nothing set.

## Local files and commands

```powershell
npm start                                    # Real account, local web UI
npm start -- --port 8790                      # Alternate loopback port
npm run backup                               # Bulk backup with existing authorization
npm run spotify-auth                         # One-time Spotify PKCE authorization
npm run backup -- --output D:\Music\Backups    # Choose a local destination
node dist\cli.js backup --demo                # Synthetic CLI export
node dist\cli.js --help
```

Close the web app before running the standalone backup command. Runtime locks
protect both the application data directory and backup directory, so different
accounts cannot race over a shared output folder. Each `runtime.lock` is a
directory containing a uniquely named JSON ownership marker. If a process
crashes, inspect those markers in both locations (including the `demo`
subdirectories in demo mode), verify the recorded PID is no longer running,
then remove **only that marker and its empty lock directory**. Windows first
claims `runtime.lock` with exclusive file creation, then replaces its own claim
with the prepared directory; a racing legacy process cannot claim that name.
A regular lock file from an older version or interrupted Windows acquisition
remains blocking until the same PID check and explicit removal. Stop older versions before upgrading or starting the new
version; never remove or modify a live process's lock. Unpublished
`.runtime-lock-<nonce>` staging directories can remain after a crash but do not
hold a lock; use the same marker/PID checks before removing them.

Each run has a new directory under `backups` and a `manifest.json` describing its
coverage, counts, per-playlist files, fingerprints, warnings and failures.
Previous runs are not overwritten. **App-managed runs expire after 30 days and
are automatically removed while the app is running.** This is a rolling backup
history, not a permanent archive.

The backup filesystem must support regular-file hard links (for example, NTFS).
New files are published from flushed staging files with an atomic no-overwrite
operation. Unsupported filesystems produce an explicit error, not a fallback
that could replace existing files; some removable-drive and network filesystems
may not provide the required operation.

| Format | Purpose |
| --- | --- |
| JSON | Authoritative versioned metadata, ordered entries, duplicate occurrences, IDs, available provider data and missing-data indicators. |
| CSV | Spreadsheet-friendly rows; values are quoted and spreadsheet formula prefixes neutralized. |
| M3U8 | Ordered video links and comments for unavailable entries. This is not an audio download; playback support depends on the player. |
| Manifest | Run history and per-playlist success/failure, even when other playlists fail. |

A failed playlist does not prevent other playlists from being exported. A failed
inventory request is not treated as an empty account. An empty playlist is a valid
export. Interrupted runs remain distinguishable from completed runs. Files are
written atomically; an unwritable destination is reported rather than hidden.
Startup removes positively owned empty runs that crashed before their first
manifest. Export intent journals record exact output and staging paths, sizes,
hashes and original filesystem identities before publication, so validated uncheckpointed files can expire safely
without being advertised as completed exports. Unrecognized or changed leftovers
are preserved with an inspection error rather than guessed to be safe to delete.
Completed results retain each export's original byte count, SHA-256 hash and
filesystem generation (device, inode and creation time) in the manifest. Cleanup
checks this persisted evidence instead of adopting a newly observed file, even
if a replacement has identical bytes.
After an interrupted publication, a journaled export and its staging name are
reconciled only when they are the same file with exactly two links and matching
recorded bytes. Unknown metadata staging files remain protected for inspection.
The CLI prints the final manifest as JSON to stdout and progress to stderr; it exits
nonzero for partial or failed runs.

Video titles, artist/album metadata and availability are limited to what Google
actually returns. A video-owner channel is not assumed to be a recording artist.
Private/deleted entries cannot reliably recover their former metadata, and the
API does not guarantee it returns placeholders for everything that used to exist.
Paginated API reads are not a transaction; avoid editing playlists during export.
During playlist discovery, Google's reported `pageInfo.totalResults` can differ
from the number actually returned. The tool follows every `nextPageToken` until
pagination ends, uses the returned playlists, and logs a count discrepancy rather
than treating it as an authorization error or conflict. Duplicate playlist IDs
and repeated continuation tokens still stop discovery.

### Configuration

Copy `.env.example` to `.env` to override defaults, or set environment variables:

| Variable | Default |
| --- | --- |
| `MUSIC_PORT` | `8787` |
| `MUSIC_DATA_DIR` | `.local` |
| `MUSIC_BACKUP_DIR` | `backups` |
| `GOOGLE_CLIENT_SECRET_FILE` | `.local\client-secret.json` |
| `SPOTIFY_CLIENT_ID` | unset (direct Spotify sync execution disabled) |
| `SPOTIFY_CLIENT_SECRET` | unset (direct Spotify sync execution disabled) |
| `SPOTIFY_REFRESH_TOKEN` | unset (direct Spotify sync execution disabled) |

The three `SPOTIFY_*` variables are optional and must be set together, or all
left unset; a partial set fails startup with an explicit configuration error.
There is no in-app (web UI) Spotify connect flow yet, so the refresh token
must be obtained with `npm run spotify-auth` (see Connect Spotify above) and
stored only in your local, Git-ignored `.env`. Without
them, an explicitly paired run whose changed side is Spotify fails closed with
an actionable `SPOTIFY_NOT_CONFIGURED` error instead of pretending to sync.

Relative paths resolve from the directory where the command runs. Demo mode uses
a `demo` subdirectory for data and backups so it never uses real Google tokens.
`--output` overrides the backup destination; `--port` overrides the port.

### Credential and metadata handling

This is a **single-user loopback application**, not a remotely hosted service.
It binds only to `127.0.0.1`, validates Host and Origin, uses an HttpOnly same-site
session cookie and requires a CSRF token for mutations. Do not expose it through a
reverse proxy or port-forward it. It has no multi-user login system.

Google tokens are stored **locally, not encrypted**, in
`.local\google-tokens.json`, separately from exports. The app requests restrictive
POSIX file permissions; **on Windows these do not replace NTFS ACLs**. Use a
private user-owned directory, review its permissions, and use device encryption.
OS credential-vault integration is not implemented. Client files, tokens, `.env`,
local state and the default backup directory are Git-ignored. Custom paths are
your responsibility; do not commit credentials or private library exports.

Main and pending token files must be ordinary files without symbolic or hard
links. Reads verify file identity before and after reading, and disconnect
rechecks identity before cleanup so detected replacements are preserved.
Persisted tokens must explicitly record the exact read-only YouTube scope;
older files without scope need reconnection, not an assumed permission. If
Google omits scope during a new authorization exchange, the app verifies it
through Google's token-info endpoint before saving. Refresh responses may retain
the already-verified stored scope when they omit it.

An interrupted credential save is recovered from a single intact pending file
before authorization is used. Pending files are checked for the exact generated
name, token shape, read-only scope, ordinary-file ownership and changes during
inspection. New saves record the original destination identity (or its absence);
publication and recovery refuse a mismatch detected during validation. Failed
publication preserves the pending credentials rather than discarding a rotated
refresh token. Ambiguous, partial, legacy unbound or unsafe leftovers require
inspection instead of being silently accepted or deleted. A legacy pending file
with valid credentials can still be revoked/removed through Disconnect, but
cannot be automatically published without destination evidence.

On Windows, token and manifest replacement retry brief sharing conflicts up to
three times (25/50/100 ms), rechecking file identities before each attempt.
Persistent sharing or permission failures remain errors; the app never deletes
the destination first as a replacement workaround.

**Single-writer safety boundary:** while the app runs, only this app may modify
its token files, run metadata, exports and runtime locks. Do not let another
editor, sync client or script write these paths; edit downloaded copies instead,
and stop the app before manually repairing its managed files. Runtime locks
coordinate cooperating app instances, not unrelated programs. Atomic rename
prevents partially written replacements, but it is **not compare-and-swap**:
identity checks cannot prevent an outside writer changing a path between the
check and rename or deletion. Concurrent external writes are unsupported, not
guaranteed safe. The documented Desktop OAuth client-file recheck is separate
from editing the app-managed token file.

Disconnect revokes/removes authorization. Review any reported revocation failure
and revoke access in your [Google account](https://myaccount.google.com/permissions)
if necessary. Disconnect also revokes/removes validated pending credentials,
even when the main token file was never published or cannot be safely read.
An invalid or undeletable file does not prevent processing other validated
credentials. Files detected as unreadable or replaced are preserved, and all partial cleanup or
revocation failures remain explicit. Disconnect does not itself remove exports. Google's revocation and
user-deletion requirements are separate from routine 30-day retention: remove
app-managed exports and any user-created copies when those requirements apply.
Do not treat routine expiry as satisfying every revocation/deletion obligation.

### Rolling 30-day retention

The [YouTube API developer policies, III.E.4.c](https://developers.google.com/youtube/terms/developer-policies)
require ordinary authorized playlist metadata to be **refreshed or deleted within
30 calendar days**. Checking authorization alone is not a refresh of metadata.
There is no express local-personal-export exception. In this application:

- Each app-created run has a persistent ownership marker and expires 30 days
  after its start time. Expiry is shown in backup history.
- Cleanup runs on startup, before a backup, and once per minute while the app is
  running. New snapshots do not reset old snapshots' deadlines.
- Only positively marked, expired, inactive run directories with valid manifests
  and original export-integrity and filesystem-generation evidence are eligible. Cleanup verifies content
  before deleting any exports and rechecks files during deletion. It removes known files individually;
  unrelated files, unmarked folders, symlinks and unexpected content are preserved.
- **Earlier backups without original integrity or generation records remain
  readable but require manual cleanup at expiry.** Hash-only records are not
  ownership proof, and current files are never adopted as the originals. These runs
  produce a cleanup warning and require inspection/removal before another backup.
- Copying or recreating an export changes its filesystem generation, even with
  identical content. Such files are not automatically deleted or adopted;
  app-managed validation requires inspection. The export formats themselves
  remain portable, but automatic cleanup requires verifiable original files.
- Cleanup errors are visible, expired exports are not offered for download, and
  starting another backup is blocked until cleanup problems are resolved.
- An active run's initialization is tracked before its directory is published,
  so cleanup does not mistake an owner marker awaiting its first manifest for a
  damaged archive. Inactive missing/corrupt archives still report errors.
- **A stopped or sleeping local app cannot enforce the deadline.** Leave it
  running when required, or remove expired outputs yourself. Cleanup happens on
  the next launch, but that does not retroactively satisfy a missed deadline.
- Browser-downloaded copies, moved exports and manually duplicated files are not
  tracked or removed. Their retention is your responsibility. Do not add your own
  files to app-managed run directories.

This implements the rolling-history behavior, not a certification of compliance
with every API policy or distribution requirement. For durable personal archives,
consider user-requested
[Google Takeout](https://support.google.com/accounts/answer/3024190) exports instead;
Takeout import is not implemented.

### Quota and common problems

Playlist discovery and item-list requests normally cost **one quota unit per
page**, up to 50 records per page; backups never issue search or write
requests. An explicit sync run additionally issues YouTube `playlistItems`
insert/delete write requests (each at YouTube's own, separately published
per-write quota cost) and Spotify API requests, but only for the one paired
playlist you selected to mirror. Check your project's actual quota in Cloud
Console. Rate limits and temporary server errors use bounded retries; quota
exhaustion and authorization problems require action, not an infinite retry
loop.

| Problem | Recovery |
| --- | --- |
| No playlists | Confirm the account/channel owns them. Saved third-party and special Music collections are outside official discovery. |
| API disabled / access denied | Enable YouTube Data API v3, review the consent test-user list and reconnect. |
| Authorization expired | Connect Google again; Testing-mode refresh tokens may last only seven days. |
| Quota exhausted | Check the Cloud project quota and retry after its reset; the app does not buy additional quota. |
| Port in use | Stop the other app or choose `--port`; reopen the displayed `127.0.0.1` address. |
| Partial run | Read individual failures in history or `manifest.json`, resolve them and run a new backup. |
| Playlist changed during export | Stop editing it and retry; a known count mismatch is not accepted as a complete export. |

## The path to Spotify / YouTube sync

An explicitly paired playlist can be evaluated bidirectionally against the
real YouTube and Spotify APIs (no Soundiiz), from the web app's sync run
control, the local API, or the CLI (`sync --pair-left`/`--pair-right`,
`--ignore`/`--unignore`, `--run`; see `--help`). Pairing, ignoring, ordered
fingerprints, baseline change classification and plan/apply are implemented in
`src/core/sync.ts` and `src/core/sync-state.ts`; running a pair re-observes
both sides fresh and classifies the change (unchanged, one side changed, or
both sides changed since the last acknowledged baseline).

**Every pair is necessarily cross-provider** (pairing the same provider twice
is rejected), and **cross-platform recording-identity resolution (matching a
YouTube video to the equivalent Spotify track) is not implemented yet.**
Without a verified translation, a source platform's native identifiers (a
YouTube video ID, a Spotify track URI) cannot be safely written to the other
platform. So today, a real run always reports `review-required` instead of
writing anything; no destructive mutation is currently reachable through a
created pair. This is a deliberate, conservative response to a real risk
(silently writing an untranslated or wrong identifier to the other platform's
API), not an oversight, and it is covered by regression tests. Automatic
mirroring, the durable per-removal audit trail (filterable by pair, platform,
playlist, track identity, direction and outcome; readable with
`sync --removals` or `GET /api/sync/removals`) and destination verification
are implemented and unit-tested against `applySyncPlan` directly, and will
take effect once cross-platform matching lands. There is also no name-based
auto-matching or scheduling yet.

Direct Spotify execution additionally needs `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET` and `SPOTIFY_REFRESH_TOKEN` (see Configuration above).
YouTube playlist writes require a separate write-scope Google consent; with the
server running, POST to `/api/auth/connect-write` from the local app session
with its CSRF token to open that authorization flow. There is no in-app Spotify
connect flow yet, so an unconfigured or demo-mode run fails closed with an
actionable `SPOTIFY_NOT_CONFIGURED` / `YOUTUBE_SYNC_NOT_AVAILABLE` error rather
than a fake success.

[#1](https://github.com/dazewell/dw-music-sync-tool/issues/1) still calls for
richer review UI (preview before applying), scheduling and Soundiiz as an
optional alternate executor. Timestamps alone cannot determine direction or
conflicts; matching tracks across platforms is separate from matching names.

**Research correction:** as checked on September 13, 2026, Soundiiz's live
[User API documentation](https://soundiiz.com/api/doc) **does document**
`POST /v1/me/syncs/{id}/trigger`. It requires Creator and an existing configured
sync; an accepted trigger is asynchronous, not proof that playlists converged.
The current published contract does not document creating or updating a sync.
Soundiiz is an optional future executor, not a dependency of backup.

See [architecture and the staged sync design](docs/architecture.md) for decisions,
boundaries, storage contracts and what remains deliberately unimplemented.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run dev
```

For repeatable desktop/mobile browser checks:

```powershell
npx playwright install chromium
npm run build
npm run test:browser
```

`dev` runs the TypeScript server; rebuild after browser TypeScript/HTML/CSS changes.
Automated tests use temporary directories, synthetic providers and mocked Google
responses. Real account authorization, account-specific coverage and actual
quotas must be checked with your own account; credentials are not bundled.
