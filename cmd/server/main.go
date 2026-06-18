// Command server is a small static httpd for the ArduPilot Log Viewer frontend.
//
// Today it only serves the built single-page app (with SPA fallback). It is the
// seam for future backend work (S3-backed log storage, upload API, auth); those
// will plug in alongside the static handler. See internal/storage for the
// storage abstraction that a future backend will implement.
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
	mux.Handle("/", spaHandler(content))

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

// spaHandler serves static files and falls back to index.html for unknown
// client-side routes. A path that resolves to a missing asset (anything with a
// file extension) or a real directory returns 404 rather than the SPA shell, so
// a stale hashed bundle fails cleanly instead of being served HTML, and the
// embedded build's directory structure is never listed.
func spaHandler(content fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(content))
	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		r = r.Clone(r.Context())
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			serveIndex(w, r)
			return
		}
		info, err := fs.Stat(content, name)
		if err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Missing asset or a directory: don't mask it as the SPA shell.
		if path.Ext(name) != "" || (err == nil && info.IsDir()) {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r)
	})
}
