// Seam: abstract the byte source so parsers/UI never hold a `File` or
// `ArrayBuffer` directly. Adding a new storage backend (Drive, S3, ...) becomes
// "implement one more LogSource" instead of rewriting the parsers' I/O boundary.
//
// `read` is async and range-aware on purpose: a multi-hundred-MB tlog can later
// be streamed via HTTP Range without changing any parser code. Writing this
// against a synchronous ArrayBuffer would force a rewrite of that boundary.

export interface ByteRange {
  start: number;
  end: number; // exclusive
}

export interface LogSource {
  readonly name: string;
  readonly size: number;
  /** Read the whole source, or a byte range if provided. */
  read(range?: ByteRange): Promise<Uint8Array>;
}

/** Phase 1 implementation: wraps a browser `File`/`Blob`. */
export class LocalFileSource implements LogSource {
  readonly name: string;
  readonly size: number;
  private readonly blob: Blob;

  constructor(file: File | Blob, name?: string) {
    this.blob = file;
    this.size = file.size;
    this.name = name ?? (file instanceof File ? file.name : 'log');
  }

  async read(range?: ByteRange): Promise<Uint8Array> {
    const slice = range ? this.blob.slice(range.start, range.end) : this.blob;
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  }
}

// Phase 2+ would add e.g.:
//   class DriveFileSource implements LogSource { read(range) -> HTTP Range req }
//   class S3Source implements LogSource { ... }
// The parsers below only ever see the LogSource interface.
