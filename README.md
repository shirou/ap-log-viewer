# ArduPilot Log Viewer

A web app that lets you upload ArduPilot DataFlash (`.bin`) / telemetry (`.tlog`)
logs in the browser and visualize the flight path, time-series data, and parameters.
All parsing happens entirely in the browser (Web Worker). A modern-stack rebuild of
[uavlogviewer](https://github.com/ardupilot/uavlogviewer).

There are two ways to run it, and they serve the same build:

- **Hosted** — <https://ap-log-viewer.minidev.workers.dev/> — drop a log in and go.
  Nothing is uploaded; parsing runs in a Web Worker on your machine and the file
  never leaves the browser.
- **Self-contained binary** — download a single executable from
  [Releases](https://github.com/shirou/ap-log-viewer/releases) and run it offline.
  No Node, no assets, no network.

## Mission waypoints

The planned mission is drawn on the map as a layer you can switch off, taken
from the log itself:

- `.bin` — the `CMD` messages, which hold the whole uploaded mission.
- `.tlog` — `MISSION_ITEM_INT` (or the deprecated `MISSION_ITEM`).

**A tlog only contains the mission if a transfer happened while it was being
recorded** — the GCS downloading it on connect, or an upload. Flying a mission
is not enough; if that exchange was not captured, the plan is simply not in the
file, and the Layers panel says so rather than hiding the control.

For those logs, load the plan separately with **Load plan file…** in the Layers
panel. Both flight-plan formats are accepted, identified by content rather than
by file extension:

- **QGC WPL** text (`.waypoints`, `.txt`) — Mission Planner, MAVProxy
- **QGC `.plan`** JSON — QGroundControl

A loaded plan overrides the one in the log and the map moves to it. QGC survey
and corridor-scan items store their generated waypoints, so they are drawn in
full; structure scans store only the parameters they are regenerated from, so
those are reported as not shown rather than silently dropped.

## Stack

- Frontend: React + Vite + TypeScript
- Map / trajectory: MapLibre GL JS + deck.gl (no token required)
- Time-series charts: uPlot
- State management: zustand
- Log parsing: custom DataFlash parser + `mavlink-mappings` (MAVLink decoding)
- Server: Go standard library (serves the prebuilt frontend statically only)

## Directory layout

```
src/parsers/      Log parsers (source / dataflash / tlog / worker) + mission extraction
                  (mission.ts) and standalone plan files (missionFile.ts)
src/components/   UI (Map / Plot / Timeline / FieldTree / ...)
src/store/        zustand store
cmd/server/       Go static file server
internal/storage/ Storage abstraction (seam for future S3 integration, not wired up)
internal/web/      Go package that embeds the build output (internal/web/dist)
```

Design seams:

- Frontend `LogSource` (`src/parsers/source.ts`): the parser never holds a `File`/`ArrayBuffer`
  directly; it accesses bytes only through `read(range?): Promise<Uint8Array>`. Supporting
  Drive/S3 or range streaming only takes one extra implementation.
- Backend `storage.Storage` (`internal/storage`): an interface for a future log-persistence backend.

## Development

```sh
npm ci --ignore-scripts        # Install dependencies (use --ignore-scripts to security)
npm run dev                    # Vite dev server
npm test                       # Parser unit tests (vitest)
npm run build                  # Production build -> internal/web/dist
```

> Always pass `--ignore-scripts` to `npm install` (also configured in `.npmrc`).

## Server (static serving)

```sh
npm run build                  # Build the frontend first (generates internal/web/dist)
go build ./cmd/server          # Single binary with internal/web/dist embedded
./server -addr :8080           # http://localhost:8080
./server -dir internal/web/dist # Serve from disk without embedding (for development)
```

## Build (single self-contained binary)

The Go server embeds the built frontend (`internal/web/dist`) via `//go:embed`, so each binary
is fully self-contained — copy it to any machine of the matching OS/arch and run it,
with no Node, assets, or runtime needed. The server is pure Go (CGO disabled), so
cross-compiling for every platform is just `GOOS`/`GOARCH`.

```sh
make build      # frontend + a binary for the host platform -> ./ap-log-viewer
make run        # build then start on :8080
make release    # cross-compile for all platforms -> build/
make clean      # remove build artifacts
make help       # list targets
```

`make release` produces binaries under `build/` for:

| OS      | arch            |
| ------- | --------------- |
| Linux   | amd64, arm64    |
| macOS   | amd64, arm64    |
| Windows | amd64, arm64    |

Run a built binary anywhere:

```sh
./build/ap-log-viewer_<version>_linux_amd64 -addr :8080   # http://localhost:8080
ap-log-viewer_<version>_windows_amd64.exe -version        # print the build version
```

## Hosting (Cloudflare Workers)

Deployed at <https://ap-log-viewer.minidev.workers.dev/>.

The hosted build runs as an **assets-only Worker** — there is no server-side code,
because the app never talks to a backend. `wrangler.jsonc` points Cloudflare at
`internal/web/dist`, the *same* directory `//go:embed` bundles into the binary, so
both distribution channels serve identical assets and cannot drift.

Deployment is driven by Cloudflare's Git integration (Workers Builds), not by a
GitHub Actions workflow — that keeps Cloudflare credentials out of the repo's CI
entirely. The dashboard side is configured as follows (one-time setup, already done —
recorded here so it can be reproduced or audited):

1. **Workers & Pages → Create** a Worker named `ap-log-viewer`
   (must match `name` in `wrangler.jsonc`, or builds fail).
2. **Settings → Builds → Connect** to the `shirou/ap-log-viewer` GitHub repo.
3. Build settings:
   - Build command: `npm ci --ignore-scripts && npm run build`
   - Deploy command: `npx wrangler deploy` (the default)
   - Root directory: leave empty
4. Set the production branch to `main`.

Pushes to `main` deploy; other branches get a preview URL via
`npx wrangler versions upload`. Node version comes from `.nvmrc` (22) — if a build
log shows otherwise, set a `NODE_VERSION` build variable instead.

Unmatched paths serve `public/404.html` with a 404 (`not_found_handling:
"404-page"`) rather than the SPA shell. There is no client-side router, so
nothing needs an SPA fallback, and returning the shell would hand the browser
HTML for a stale hashed chunk instead of a clean 404.

`cmd/server` does the same thing, so the hosted site and the binary answer every
path identically — verified request by request, down to the byte count. If a
client-side router is ever added, both sides need the SPA fallback restored
together: `not_found_handling` in `wrangler.jsonc` and `staticHandler` in
`cmd/server/main.go`.

Check the config or preview it locally without deploying:

```sh
npm run build
npx wrangler deploy --dry-run   # validate wrangler.jsonc, upload nothing
npx wrangler dev                # http://localhost:8787 (not 8788 — that was Pages)
```

> Cloudflare now steers new projects to Workers static assets rather than Pages;
> Pages still works but is in maintenance mode.

## Releases

Pushing a `vX.Y.Z` tag runs the GitHub Actions release workflow
(`.github/workflows/release.yml`), which cross-compiles all six platforms and
opens a **draft** GitHub Release with the binaries, a `checksums.txt`, and a
build-provenance attestation. Review the draft, then publish it.

```sh
git tag v1.2.3
git push origin v1.2.3          # -> draft release with all binaries attached
```

The pipeline is hardened against CI/CD supply-chain attacks: every action is
pinned to a full commit SHA (auto-updated by Dependabot with a 7-day cooldown),
the runner's network egress is monitored by `step-security/harden-runner`, the
`GITHUB_TOKEN` is least-privilege, and workflows are linted by `zizmor`. A
one-time repo setup is recommended: **Settings → Actions → General →** set
default workflow permissions to read-only and require actions to be pinned to a
full-length commit SHA.

Verify a download before running it:

```sh
sha256sum -c checksums.txt      # integrity
gh attestation verify ap-log-viewer_v1.2.3_linux_amd64 \
  --repo shirou/ap-log-viewer   # provenance: built by this workflow from this tag
```

## Supported logs

- `.bin` / `.log`: DataFlash. Parses the self-describing format via FMT messages, so it is
  independent of the ArduPilot version.
- `.tlog`: a repetition of `[8-byte BE timestamp][MAVLink frame]`. Decoded with the
  ardupilotmega dialect.
