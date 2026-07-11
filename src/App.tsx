import { useState } from 'react';
import { useLogStore } from './store/logStore.ts';
import FileDropzone from './components/FileDropzone.tsx';
import MapView from './components/MapView.tsx';
import PlotPanel from './components/PlotPanel.tsx';
import Timeline from './components/Timeline.tsx';
import FieldTree from './components/FieldTree.tsx';
import ParamsTable from './components/ParamsTable.tsx';
import MessagesLog from './components/MessagesLog.tsx';

type Tab = 'fields' | 'params' | 'messages';

export default function App() {
  const status = useLogStore((s) => s.status);
  const fileName = useLogStore((s) => s.fileName);
  const log = useLogStore((s) => s.log);
  const reset = useLogStore((s) => s.reset);
  const theme = useLogStore((s) => s.theme);
  const toggleTheme = useLogStore((s) => s.toggleTheme);
  const [tab, setTab] = useState<Tab>('fields');
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 768,
  );

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
        {ready && <button onClick={reset}>Open another log</button>}
      </header>

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

          <main className="main">
            <MapView />
            <PlotPanel />
            <Timeline />
          </main>
        </div>
      )}
    </div>
  );
}
