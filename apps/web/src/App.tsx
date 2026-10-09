import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { BridgeProvider, useBridge } from './bridge/BridgeProvider';
import { Layout } from './shell/Layout';
import { BridgePage } from './features/bridge/BridgePage';
import { DevicesPage } from './features/devices/DevicesPage';
import { ComingSoon } from './features/placeholder/ComingSoon';

function Home() {
  const { status } = useBridge();
  return <Navigate to={status.state === 'unpaired' ? '/bridge' : '/apps/installed'} replace />;
}

const PAGES = [
  { path: 'apps/installed', eyebrow: 'Apps', title: 'Installed apps', icon: 'apps', milestone: 'M3',
    description: 'List, launch and remove apps on the TV, and install IPK files from your computer with progress.' },
  { path: 'apps/homebrew', eyebrow: 'Apps', title: 'Homebrew repository', icon: 'store', milestone: 'M4',
    description: 'Browse and search repo.webosbrew.org, see what has updates, and install packages in one click.' },
  { path: 'files', eyebrow: 'Device', title: 'Files', icon: 'files', milestone: 'M5',
    description: 'Browse the TV filesystem over SFTP, upload by drag & drop, download, rename and delete.' },
  { path: 'terminal', eyebrow: 'Device', title: 'Terminal', icon: 'terminal', milestone: 'M5',
    description: 'A full interactive shell on the TV, with tabs and resizing.' },
  { path: 'info', eyebrow: 'Device', title: 'Device info', icon: 'info', milestone: 'M6',
    description: 'Model, firmware and webOS version, Dev Mode session time left with one-click renew, and screenshots.' },
  { path: 'debug/logs', eyebrow: 'Debug', title: 'Log reader', icon: 'debug', milestone: 'M7', description: 'Stream system logs from the TV.' },
  { path: 'debug/pmlog', eyebrow: 'Debug', title: 'PmLog', icon: 'debug', milestone: 'M7', description: 'Turn developer logging on and set log contexts.' },
  { path: 'debug/dmesg', eyebrow: 'Debug', title: 'dmesg', icon: 'debug', milestone: 'M7', description: 'Kernel ring buffer.' },
  { path: 'debug/crashes', eyebrow: 'Debug', title: 'Crash reports', icon: 'debug', milestone: 'M7', description: 'Browse and download crash reports.' },
  { path: 'debug/luna', eyebrow: 'Debug', title: 'Luna monitor', icon: 'debug', milestone: 'M7', description: 'Watch luna-service bus traffic live.' },
] as const;

export function App() {
  return (
    <BridgeProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="bridge" element={<BridgePage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="apps" element={<Navigate to="/apps/installed" replace />} />
            <Route path="debug" element={<Navigate to="/debug/logs" replace />} />
            {PAGES.map(({ path, ...p }) => (
              <Route key={path} path={path} element={<ComingSoon {...p} />} />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </BridgeProvider>
  );
}
