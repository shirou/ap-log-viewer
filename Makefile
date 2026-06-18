# ArduPilot Log Viewer — build orchestration.
#
# The Go server embeds the built frontend (internal/web/dist) via //go:embed, so every
# binary is fully self-contained: copy it to any machine of the matching OS/arch
# and run it, no Node/assets/runtime required. The server is pure Go (CGO off),
# so cross-compiling for every platform is just GOOS/GOARCH.

BINARY  := ap-log-viewer
PKG     := ./cmd/server
# DIST: frontend build output (embedded). OUT: cross-compiled binaries land here.
DIST    := dist
OUT     := build
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

# Cross-compile matrix: os/arch pairs.
PLATFORMS := \
	linux/amd64 \
	linux/arm64 \
	darwin/amd64 \
	darwin/arm64 \
	windows/amd64 \
	windows/arm64

.PHONY: all
all: build

## build: build the frontend and a server binary for the host platform
.PHONY: build
build: web
	CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(BINARY) $(PKG)

## web: install deps and produce the embedded frontend bundle (internal/web/dist)
.PHONY: web
web:
	npm ci --ignore-scripts
	npm run build

## test: run frontend parser tests
.PHONY: test
test:
	npm test

## release: cross-compile a self-contained binary for every platform into build/
.PHONY: release
release: web
	@mkdir -p $(OUT)
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; arch=$${platform#*/}; \
		ext=""; [ "$$os" = "windows" ] && ext=".exe"; \
		out="$(OUT)/$(BINARY)_$(VERSION)_$${os}_$${arch}$${ext}"; \
		echo "building $$out"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
			go build -trimpath -ldflags '$(LDFLAGS)' -o "$$out" $(PKG) || exit 1; \
	done
	@echo "done -> $(OUT)/"

## run: build and start the server on :8080
.PHONY: run
run: build
	./$(BINARY) -addr :8080

## clean: remove build artifacts
.PHONY: clean
clean:
	rm -rf $(OUT) $(BINARY) $(BINARY).exe internal/web/$(DIST)

## help: list targets
.PHONY: help
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'
