# soundiiz-client

A typed Soundiiz API client with local playlist backups through a CLI or responsive browser interface.

## Setup

Copy `.env.example` to `.env` and set `SOUNDIIZ_API_KEY`, or enter the key when prompted/in the web UI.

```sh
npm run cli -- status
npm run cli -- list --platform youtubeMusic
npm run cli -- backup --platform youtubeMusic --format json --output ./backups --include-manifest
npm run web
```

The local UI starts at `http://localhost:3000` by default. Production builds can be run with `npm run build && npm start`.
