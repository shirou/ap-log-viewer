import { useEffect, useRef, useState } from 'react';
import { useLogStore } from './store/logStore.ts';
import FileDropzone from './components/FileDropzone.tsx';
import MapView from './components/MapView.tsx';
import PlotPanel from './components/PlotPanel.tsx';
import Timeline from './components/Timeline.tsx';
import FieldTree from './components/FieldTree.tsx';
import ParamsTable from './components/ParamsTable.tsx';
import MessagesLog from './components/MessagesLog.tsx';
import AnalysisModal from './components/AnalysisModal.tsx';

type Tab = 'fields' | 'params' | 'messages';

export default function App() {
  const status = useLogStore((s) => s.status);
  const fileName = useLogStore((s) => s.fileName);
  const log = useLogStore((s) => s.log);
  const reset = useLogStore((s) => s.reset);
  const theme = useLogStore((s) => s.theme);
  const toggleTheme = useLogStore((s) => s.toggleTheme);
  const [tab, setTab] = useState<Tab>('fields');
  const [analysisOpen, setAnalysisOpen] = useState(false);
  // Don't let the modal outlive its log: a reset or a new parse closes it, so it
  // can't reappear unbidden over the next log.
  useEffect(() => {
    if (status !== 'ready') setAnalysisOpen(false);
  }, [status]);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 768,
  );

  // Draggable split between the map (top) and the time-series plot below it.
  // null = use the default fr ratio; a number pins the map to that pixel height.
  const mainRef = useRef<HTMLElement>(null);
  const [mapHeight, setMapHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    // The map is the handle's previous sibling — measure it directly rather
    // than relying on the child order of `.main`.
    const mapEl = e.currentTarget.previousElementSibling as HTMLElement | null;
    if (!mapEl) return;
    dragRef.current = { startY: e.clientY, startH: mapEl.getBoundingClientRect().height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const main = mainRef.current;
    // Bail on hover moves (no button held) so a lost/canceled pointer can't
    // leave the divider resizing while the mouse merely passes over it.
    if (!d || !main || e.buttons === 0) return;
    const mainH = main.getBoundingClientRect().height;
    // Keep at least ~140px of map and ~220px for the plot + timeline below.
    const next = Math.max(140, Math.min(d.startH + (e.clientY - d.startY), mainH - 220));
    setMapHeight(next);
  };
  const onResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const ready = status === 'ready' && log;

  return (
    <div className="app">
      <header className="header">
        {ready && (
          <button
            className="sidebar-toggle"
            aria-label="Toggle sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>
        )}
        <h1>ArduPilot Log Viewer</h1>
        {fileName && <span className="file">{fileName}</span>}
        <div className="spacer" />
        {ready && (
          <span className="file">
            {log.source.toUpperCase()} · {Object.keys(log.messages).length} msg types
          </span>
        )}
        <button
          className="theme-toggle"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        {ready && <button onClick={() => setAnalysisOpen(true)}>Analysis</button>}
        {ready && <button onClick={reset}>Open another log</button>}
      </header>

      {ready && analysisOpen && <AnalysisModal onClose={() => setAnalysisOpen(false)} />}

      {!ready ? (
        <FileDropzone />
      ) : (
        <div className={`layout${sidebarOpen ? '' : ' collapsed'}`}>
          {sidebarOpen && (
            <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
          )}
          <aside className="sidebar">
            <div className="tabs">
              <button className={tab === 'fields' ? 'active' : ''} onClick={() => setTab('fields')}>
                Fields
              </button>
              <button className={tab === 'params' ? 'active' : ''} onClick={() => setTab('params')}>
                Params
              </button>
              <button className={tab === 'messages' ? 'active' : ''} onClick={() => setTab('messages')}>
                Messages
              </button>
            </div>
            <div className="sidebar-body">
              {tab === 'fields' && <FieldTree />}
              {tab === 'params' && <ParamsTable />}
              {tab === 'messages' && <MessagesLog />}
            </div>
          </aside>

          <main
            className="main"
            ref={mainRef}
            style={{
              gridTemplateRows: `${mapHeight != null ? `${mapHeight}px` : '1.2fr'} 8px 1fr auto`,
            }}
          >
            <MapView />
            <div
              className="row-resizer"
              role="separator"
              aria-orientation="horizontal"
              title="Drag to resize · double-click to reset"
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              onDoubleClick={() => setMapHeight(null)}
            />
            <PlotPanel />
            <Timeline />
          </main>
        </div>
      )}
    </div>
  );
}
