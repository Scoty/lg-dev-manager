import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BridgeClient, BridgeError } from './client';
import { bridgeUrlProblem, loadSettings, saveSettings, type BridgeSettings } from './settings';

export type BridgeStatus =
  | { state: 'unpaired' }
  | { state: 'connecting' }
  | { state: 'connected'; bridgeVersion: string; platform: string; distribution?: 'app' | 'npm' | 'source' }
  | { state: 'error'; code: string; message: string };

interface BridgeContextValue {
  status: BridgeStatus;
  settings: BridgeSettings | null;
  client: BridgeClient | null;
  /** Save new settings and (re)connect. Resolves when paired, rejects with BridgeError. */
  pair: (s: BridgeSettings) => Promise<void>;
  reconnect: () => void;
  forget: () => void;
}

const BridgeContext = createContext<BridgeContextValue | null>(null);

const RETRY_MS = [1000, 2000, 5000, 10000];

export function BridgeProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<BridgeSettings | null>(() => loadSettings());
  const [status, setStatus] = useState<BridgeStatus>(settings ? { state: 'connecting' } : { state: 'unpaired' });
  const [client, setClient] = useState<BridgeClient | null>(null);
  const attempt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const generation = useRef(0);

  const connect = useCallback(async (s: BridgeSettings) => {
    const gen = ++generation.current;
    clearTimeout(retryTimer.current);
    setStatus({ state: 'connecting' });
    const c = new BridgeClient(s.url, s.token);
    try {
      const hello = await c.connect();
      if (gen !== generation.current) return c.close();
      attempt.current = 0;
      setClient(c);
      setStatus({ state: 'connected', bridgeVersion: hello.bridgeVersion, platform: hello.platform, distribution: hello.distribution });
      c.onClose = (reason) => {
        if (gen !== generation.current) return;
        setClient(null);
        if (reason === 'unauthorized') {
          setStatus({ state: 'error', code: 'unauthorized', message: 'The bridge rejected the pairing token.' });
          return;
        }
        setStatus({ state: 'error', code: 'disconnected', message: 'Lost connection to the bridge. Retrying…' });
        scheduleRetry(s, gen);
      };
    } catch (e) {
      c.close();
      if (gen !== generation.current) return;
      const err = e instanceof BridgeError ? e : new BridgeError('unknown', String(e));
      setClient(null);
      setStatus({ state: 'error', code: err.code, message: err.message });
      if (err.code !== 'unauthorized' && err.code !== 'protocol_mismatch') scheduleRetry(s, gen);
      throw err;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleRetry = useCallback(
    (s: BridgeSettings, gen: number) => {
      const delay = RETRY_MS[Math.min(attempt.current++, RETRY_MS.length - 1)]!;
      retryTimer.current = setTimeout(() => {
        if (gen === generation.current) connect(s).catch(() => {});
      }, delay);
    },
    [connect],
  );

  useEffect(() => {
    if (settings) connect(settings).catch(() => {});
    return () => {
      generation.current++;
      clearTimeout(retryTimer.current);
    };
    // Only on mount; later changes go through pair()/forget().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<BridgeContextValue>(
    () => ({
      status,
      settings,
      client,
      pair: async (s) => {
        // Checked before anything is saved or sent: the token (and later TV logins) only ever go to this computer.
        const problem = bridgeUrlProblem(s.url);
        if (problem) throw new BridgeError('bad_url', problem);
        client?.close();
        saveSettings(s);
        setSettings(s);
        await connect(s);
      },
      reconnect: () => {
        attempt.current = 0;
        if (settings) connect(settings).catch(() => {});
      },
      forget: () => {
        generation.current++;
        clearTimeout(retryTimer.current);
        client?.close();
        saveSettings(null);
        setSettings(null);
        setClient(null);
        setStatus({ state: 'unpaired' });
      },
    }),
    [status, settings, client, connect],
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridge(): BridgeContextValue {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error('useBridge must be used inside <BridgeProvider>');
  return ctx;
}
