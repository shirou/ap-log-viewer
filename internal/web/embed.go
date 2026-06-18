// Package web embeds the built frontend (dist/, produced by `npm run build`) so
// the server can ship as a single binary. A placeholder index.html keeps this
// buildable before the first frontend build.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embedded embed.FS

// Dist returns the embedded frontend build rooted at dist/.
func Dist() (fs.FS, error) {
	return fs.Sub(embedded, "dist")
}
