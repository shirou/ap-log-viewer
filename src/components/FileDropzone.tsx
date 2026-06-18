import { useCallback, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore.ts';

export default function FileDropzone() {
  const parseFile = useLogStore((s) => s.parseFile);
  const status = useLogStore((s) => s.status);
  const progress = useLogStore((s) => s.progress);
  const error = useLogStore((s) => s.error);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const file = e.dataTransfer.files[0];
      if (file) parseFile(file);
    },
    [parseFile],
  );

  return (
    <div className="dropzone">
      <div
        className={`box${drag ? ' drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <h2>ArduPilot Log Viewer</h2>
        {status === 'parsing' ? (
          <>
            <p>Parsing… {Math.round(progress * 100)}%</p>
            <div className="progress" style={{ width: `${progress * 100}%` }} />
          </>
        ) : (
          <>
            <p>
              Drag &amp; drop a <code>.bin</code> (DataFlash) or <code>.tlog</code> (telemetry) file,
              <br />
              or click to select
            </p>
            {error && <p style={{ color: 'var(--accent-2)' }}>Error: {error}</p>}
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".bin,.tlog,.log"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) parseFile(f);
          }}
        />
      </div>
    </div>
  );
}
