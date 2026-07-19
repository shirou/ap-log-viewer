// Command server is a small static httpd for the ArduPilot Log Viewer frontend.
//
// Today it only serves the built frontend, matching how the hosted build is
// served from Cloudflare (see wrangler.jsonc). It is the seam for future backend
// work (S3-backed log storage, upload API, auth); those will plug in alongside
// the static handler. See internal/storage for the storage abstraction that a
// future backend will implement.
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/shirou/ap-log-viewer/internal/web"
)

// version is set at build time via -ldflags "-X main.version=...". See Makefile.
var version = "dev"

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dir := flag.String("dir", "", "serve frontend from this directory instead of the embedded build")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	var content fs.FS
	if *dir != "" {
		content = os.DirFS(*dir)
		log.Printf("serving frontend from %s", *dir)
	} else {
		sub, err := web.Dist()
		if err != nil {
			log.Fatalf("embed sub: %v", err)
		}
		content = sub
		log.Printf("serving embedded frontend")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/", staticHandler(content))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("ap-log-viewer %s listening on %s", version, *addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// staticHandler serves the built frontend. Anything that does not resolve to a
// real file -- a missing asset, a directory, an unknown path -- gets 404.html
// with a 404 status, and the embedded build's directory structure is never
// listed.
//
// Nothing falls back to index.html. There is no client-side router (src/App.tsx
// is useState tabs), so no path needs an SPA shell, and serving it would hand
// the browser HTML to parse as JavaScript whenever a stale hashed chunk is
// requested -- the app lazy-loads maplibre and the parser worker, so a tab left
// open across an upgrade does exactly that.
//
// This is deliberately identical to what the hosted build does via
// not_found_handling: "404-page" (see wrangler.jsonc), so the binary and
// https://ap-log-viewer.minidev.workers.dev cannot drift. If a router is ever
// added, both sides need the SPA fallback restored together.
func staticHandler(content fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(content))
	// Falls back to the stdlib plain-text 404 when the page is missing, so
	// `-dir` pointed at a tree built before 404.html existed still works.
	notFound := func(w http.ResponseWriter, r *http.Request) {
		page, err := fs.ReadFile(content, "404.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write(page) // net/http discards this for HEAD
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		if info, err := fs.Stat(content, name); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		notFound(w, r)
	})
}
