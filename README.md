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

## Local files and commands

```powershell
npm start                                    # Real account, local web UI
npm start -- --port 8790                      # Alternate loopback port
npm run backup                               # Bulk backup with existing authorization
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
then remove **only that marker and its empty lock directory**. Older versions
used a regular `runtime.lock` file; it remains blocking until the same PID check
and explicit removal. Stop older versions before upgrading or starting the new
version; never remove or modify a live process's lock. Unpublished
`.runtime-lock-<nonce>` staging directories can remain after a crash but do not
hold a lock; use the same marker/PID checks before removing them.

Each run has a new directory under `backups` and a `manifest.json` describing its
coverage, counts, per-playlist files, fingerprints, warnings and failures.
Previous runs are not overwritten. **App-managed runs expire after 30 days and
are automatically removed while the app is running.** This is a rolling backup
history, not a permanent archive.

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
manifest. Export intent journals record exact output and staging paths, sizes and
hashes before publication, so validated uncheckpointed files can expire safely
without being advertised as completed exports. Unrecognized or changed leftovers
are preserved with an inspection error rather than guessed to be safe to delete.
Completed results retain each export's original byte count and SHA-256 hash in
the manifest, allowing cleanup to detect replacement files even at a known name.
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

An interrupted credential save is recovered from a single intact pending file
before authorization is used. Pending files are checked for the exact generated
name, token shape, read-only scope, ordinary-file ownership and changes during
inspection. Ambiguous, partial or unsafe leftovers produce an explicit error
instead of silently being accepted or deleted; inspect them in the private token
directory before retrying.

Disconnect revokes/removes authorization. Review any reported revocation failure
and revoke access in your [Google account](https://myaccount.google.com/permissions)
if necessary. Disconnect also revokes/removes validated pending credentials,
even when the main token file was never published; a failed local cleanup is
not reported as success. Disconnect does not itself remove exports. Google's revocation and
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
  and original export-integrity evidence are eligible. Cleanup verifies content
  before deleting any exports and rechecks files during deletion. It removes known files individually;
  unrelated files, unmarked folders, symlinks and unexpected content are preserved.
- **Earlier backups without original integrity records remain readable but
  require manual cleanup at expiry.** The app will not trust freshly calculated
  hashes as proof that existing files are still its original exports. These runs
  produce a cleanup warning and require inspection/removal before another backup.
- Cleanup errors are visible, expired exports are not offered for download, and
  starting another backup is blocked until cleanup problems are resolved.
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
page**, up to 50 records per page. No search or write requests are used. Check
your project's actual quota in Cloud Console. Rate limits and temporary server
errors use bounded retries; quota exhaustion and authorization problems require
action, not an infinite retry loop.

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

This release **does not sync or modify platform playlists**. It establishes a
provider interface, ordered fingerprints, ambiguity-aware same-name pairing
logic and baseline change classification. These are the foundation for
[#1](https://github.com/dazewell/dw-music-sync-tool/issues/1), not a pretend sync button.

The next feature should confirm a same-name pair, choose source/destination,
preview matches and changes, protect the destination with a backup, apply the
approved plan and verify the result. Timestamps alone cannot determine direction
or conflicts. Matching tracks across platforms is separate from matching names.

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
