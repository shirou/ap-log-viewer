// Package storage defines the abstraction for persisting and retrieving uploaded
// logs. It is intentionally backend-agnostic so a future implementation (local
// filesystem, S3, GCS, ...) can be added without touching the HTTP layer.
//
// This is a seam only: no implementation is wired into the server yet. It mirrors
// the frontend's LogSource abstraction (src/parsers/source.ts) on the backend.
package storage

import (
	"context"
	"io"
	"time"
)

// Object is the metadata for a stored log.
type Object struct {
	Key       string
	Size      int64
	UpdatedAt time.Time
}

// Storage persists log blobs under string keys. Implementations should be safe
// for concurrent use.
type Storage interface {
	// Put stores the contents of r under key and returns the stored object.
	Put(ctx context.Context, key string, r io.Reader) (Object, error)
	// Get opens the object stored under key for reading.
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// List returns objects whose key begins with prefix.
	List(ctx context.Context, prefix string) ([]Object, error)
	// Delete removes the object stored under key.
	Delete(ctx context.Context, key string) error
}
