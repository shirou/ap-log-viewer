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
panel:

- **QGC WPL** text (`.waypoints`, `.txt`) — Mission Planner, MAVProxy
- **QGC `.plan`** JSON — QGroundControl

Which of the two it is comes from the content, not the extension — Mission
Planner writes the text format under either name, so the file picker's filter is
only a convenience.

A loaded plan overrides the one in the log, and the map moves to it (and back to
the flight when it is removed). QGC surveys and corridor scans store their
generated waypoints, so they are drawn in full. Structure scans and landing
patterns instead store the geometry QGC regenerates them from, and so cannot be.
Anything the file holds no usable waypoints for is counted and reported on the
map panel rather than silently dropped.

## MAVLink sources

A `.tlog` is not one vehicle's log — it is everything that crossed the telemetry
link. The autopilot, every ground station, and any sensor feeding the flight
controller all write into the same file, and they are told apart only by the
SYSID/COMPID pair on each frame. A real one-hour recording here holds four:

| SYSID/COMPID | Frames | What it is |
|---|---|---|
| `1/1` | 351,256 | The vehicle (an ArduRover boat) |
| `255/1` | 36,720 | An external GPS injecting `GPS_INPUT` |
| `255/190` | 15,643 | Mission Planner |
| `254/1` | 1,560 | A second ground station |

Read as one stream, they interfere. All four send `HEARTBEAT`, and a ground
station's `customMode` is always 0, so the mode history of that flight came out
as **7,049 entries** alternating between two values. Split by source it is
**four**: `MANUAL → AUTO → MANUAL → AUTO`.

The selector in the header picks which one everything else shows — plot, map,
parameters, messages, timeline and analysis. **All sources** puts them back
together if you want to see the link as it was recorded.

A SYSID is one aircraft, though, and the COMPIDs under it are the boxes bolted
to it — the autopilot, a gimbal, a companion computer. So the selector offers
two grains side by side: the system, and each component indented beneath it.

```
All sources · 36 types
1/1 · Surface boat · Autopilot1 · 30 types · 351,256 rec
sys 255 · Gcs · 2 comp · 8 types · 52,363 rec
　　255/1 · Gcs · Autopilot1 · 2 types · 36,720 rec
　　255/190 · Gcs · Missionplanner · 7 types · 15,643 rec
254/1 · Gcs · Autopilot1 · 2 types · 1,560 rec
```

A system with a single component gets no row of its own — merging one source is
the identity, and two rows that cannot differ by a byte are one row too many.
The viewer opens on the aircraft's system, picked by its `HEARTBEAT`'s MAV_TYPE
rather than by frame count, so a chatty sensor cannot be mistaken for the
aircraft.

Choosing a system merges its components: their messages interleave in time, and
their text, commands and mission progress are pooled. Its **mode history is the
vehicle's alone** — every component sends `HEARTBEAT` and a peripheral's
`customMode` is always 0, so a plain union would open the aircraft's history
with a mode it never entered. Where no component names a vehicle (two ground
stations sharing a SYSID) there is nothing to prefer and all of them are kept.

The merge is the price of seeing an aircraft whole: a type more than one
component sends comes out interleaved, so reading `HEARTBEAT.customMode` off a
system's plot shows both components' values and the analysis tab reads the
combined rate. Pick the component's own row to see it unmixed.

Two things deliberately cross the boundary. Commands (`COMMAND_LONG` /
`COMMAND_INT`) are filed under the vehicle they were aimed at as well as the
station that sent them — every command on that log comes from the GCS, so
filtering by sender alone would leave the vehicle with none. Mission transfers
are filed under both ends too, since an upload runs GCS→vehicle and a download
runs the other way.

Knowing the vehicle also names its modes: `customMode` 10 is `AUTO` on a Rover
and `AUTOTUNE` on a Copter, and the viewer now says which. A `.bin` gets the same
treatment from its firmware banner (`ArduRover V4.6.3`), so both formats read
alike. A `.bin` has no sources to choose between, so it shows no selector.

## Downloading the displayed window

Drag across the time series to zoom into a stretch of the flight, then use
`⤓ Download window` in the header to take just that stretch away. The control
stays inert until you have actually zoomed — a window nobody narrowed is the
whole log, and handing that back under a new name helps nobody — and its tooltip
says which of the two is stopping it.

Two formats:

- **Original `.tlog` / `.bin` bytes.** A copy of the file you opened, cut on
  record boundaries, so it opens in Mission Planner, MAVExplorer or here. The
  parts a cut would otherwise lose come across with it: a `.bin`'s format table
  (without which nothing reads back at all), the unit tables, the flight plan,
  the mode in force, and each parameter at the value it held when the window
  opened. Those carried-in records are restamped to the window start, so the
  slice reads as a recording of that window rather than of the whole session
  with a gap in it.
- **JSON, one array per field.** Every message type the window holds — including
  ones you are not plotting and ones you dropped from memory — as columns that
  read straight into pandas or `jq`. Only what was recorded *inside* the window,
  so parameters and the flight plan can come out empty. Optionally gzipped.

  A `.tlog` is written per source (format 2): keys in `messages` read
  `"1/1:ATTITUDE"`, a `sources` array lists who was on the link, `params` and
  `mission` nest under the same source key, and each mode, message and command
  carries the address it came from — for a command, the sender, with the
  recipient alongside it. A `.bin` has no addresses and keeps the flat shape it
  has always had; `source.kind` tells you which of the two you are reading.

**Both formats always cover every MAVLink source**, whichever one the header is
showing. A slice is a cut of the file rather than of the view, and dropping a
source would leave acknowledgements without their commands.

Every slice is reframed and checked against what the scan planned before you get
it: byte-for-byte record counts per message type, no unaccounted bytes, and every
timestamp inside the window. A cut that does not check out is refused rather than
downloaded, and so is one that would come to more than 256 MB — assembling a
slice costs a multiple of its own size, and running the tab out of memory would
take the loaded log with it. A window worth cutting is nowhere near that: a
23-second window of a 65 MB log comes to 1.4 MB.

The cut happens in your browser. Nothing is uploaded.

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
                  (mission.ts), standalone plan files (missionFile.ts), and
                  project.ts, which picks one MAVLink source out of a parse
src/export/       Cutting the displayed window back out as a file (slicer / JSON / download)
src/lib/          Pure helpers over the columnar model (series, signal, stats, formatting)
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
- `ParsedLog` -> `LogData` (`src/parsers/project.ts`): parsers return every MAVLink source
  separately; every view still reads the single `LogData` it always has. Choosing a source
  hands back the arrays the parser built rather than copying them, so the split costs no
  memory — `src/parsers/project.test.ts` pins that by identity.

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
