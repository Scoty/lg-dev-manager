import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BridgeProvider, useBridge } from './bridge/BridgeProvider';
import { FeedbackProvider } from './components/Feedback';
import { Layout } from './shell/Layout';
import { BridgePage } from './features/bridge/BridgePage';
import { DevicesPage } from './features/devices/DevicesPage';
import { AddDevicePage } from './features/devices/AddDevicePage';
import { InstalledAppsPage } from './features/apps/InstalledAppsPage';
import { RepoPage } from './features/repo/RepoPage';
import { FilesPage } from './features/files/FilesPage';
import { TerminalPage } from './features/terminal/TerminalPage';
import { SyslogPage, DmesgPage } from './features/debug/LogPages';
import { PmLogPage } from './features/debug/PmLogPage';
import { CrashesPage } from './features/debug/CrashesPage';
import { LunaMonitorPage } from './features/debug/LunaMonitorPage';
import { InfoPage } from './features/info/InfoPage';

/** A fresh wizard on every visit, including "Add a TV" clicked while already on the page. */
function AddDeviceRoute() {
  return <AddDevicePage key={useLocation().key} />;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

function Home() {
  const { status } = useBridge();
  return <Navigate to={status.state === 'unpaired' ? '/bridge' : '/apps/installed'} replace />;
}


export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BridgeProvider>
        <FeedbackProvider>
          <HashRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="bridge" element={<BridgePage />} />
                <Route path="devices" element={<DevicesPage />} />
                <Route path="devices/new" element={<AddDeviceRoute />} />
                <Route path="apps" element={<Navigate to="/apps/installed" replace />} />
                <Route path="apps/installed" element={<InstalledAppsPage />} />
                <Route path="apps/homebrew" element={<RepoPage />} />
                <Route path="files" element={<FilesPage />} />
                <Route path="terminal" element={<TerminalPage />} />
                <Route path="info" element={<InfoPage />} />
                <Route path="debug" element={<Navigate to="/debug/logs" replace />} />
                <Route path="debug/logs" element={<SyslogPage />} />
                <Route path="debug/pmlog" element={<PmLogPage />} />
                <Route path="debug/dmesg" element={<DmesgPage />} />
                <Route path="debug/crashes" element={<CrashesPage />} />
                <Route path="debug/luna" element={<LunaMonitorPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </HashRouter>
        </FeedbackProvider>
      </BridgeProvider>
    </QueryClientProvider>
  );
}
