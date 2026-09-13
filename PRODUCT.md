# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Individuals who use Soundiiz to manage playlists and want a local, inspectable backup workflow from a terminal or browser.

## Product Purpose
Provide authenticated playlist discovery, connection validation, and reliable local exports in JSON, M3U, or CSV, with visible progress and backup history.

## Operating Context
Runs locally through a Node.js CLI or an Express web server. Credentials come from environment variables, CLI input, or browser-session storage. Backup files remain on the user's machine.

## Capabilities and Constraints
The Soundiiz API is the remote source of truth. YouTube Music is the default platform. One web backup job runs at a time. The browser UI polls local server state and does not persist API keys on the server.

## Evidence on Hand
The repository contains a typed Soundiiz API client and backup engine. No customer claims, usage metrics, or brand assets are available.

## Product Principles
- Keep credentials local and explicit.
- Make backup state legible at every step.
- Prefer portable files and transparent manifests.
- Keep terminal and browser workflows consistent.
