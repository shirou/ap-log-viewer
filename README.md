# ArduPilot Log Viewer

A web app that lets you upload ArduPilot DataFlash (`.bin`) / telemetry (`.tlog`)
logs in the browser and visualize the flight path, time-series data, and parameters.
All parsing happens entirely in the browser (Web Worker). A modern-stack rebuild of
[uavlogviewer](https://github.com/ardupilot/uavlogviewer).

## Stack

- Frontend: React + Vite + TypeScript
- Map / trajectory: MapLibre GL JS + deck.gl (no token required)
- Time-series charts: uPlot
- State management: zustand
- Log parsing: custom DataFlash parser + `mavlink-mappings` (MAVLink decoding)
- Server: Go standard library (serves the prebuilt frontend statically only)

## Directory layout

```
src/parsers/      Log parsers (source / dataflash / tlog / worker)
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

## Supported logs

- `.bin` / `.log`: DataFlash. Parses the self-describing format via FMT messages, so it is
  independent of the ArduPilot version.
- `.tlog`: a repetition of `[8-byte BE timestamp][MAVLink frame]`. Decoded with the
  ardupilotmega dialect.
