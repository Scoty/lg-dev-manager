import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter-tight/500.css';
import '@fontsource/inter-tight/600.css';
import '@fontsource/inter-tight/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/index.scss';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FramedNotice, isFramed } from './shell/FramedNotice';

// Inside another site's frame (flag set by public/theme-init.js): don't start the app or contact the bridge.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isFramed() ? (
      <FramedNotice />
    ) : (
      <ErrorBoundary fullPage>
        <App />
      </ErrorBoundary>
    )}
  </StrictMode>,
);
