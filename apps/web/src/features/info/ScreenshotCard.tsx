import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Card } from '../../components/Card';
import { Alert } from '../../components/Alert';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { useFeedback } from '../../components/Feedback';
import { Icon } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { toTarget, type SavedDevice } from '../../devices/store';
import { saveBlob } from '../files/transfer';
import { addShot, deleteShots, fmtBytes, shotFileName, useObjectUrls, useShots, type Shot } from './shots';
import { zip } from './zip';

const METHODS = [
  { id: 'DISPLAY', label: 'Everything' },
  { id: 'VIDEO', label: 'Video only' },
  { id: 'GRAPHIC', label: 'UI only' },
] as const;
const methodLabel = (m: Shot['method']) => METHODS.find((x) => x.id === m)?.label ?? m;

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

/**
 * Take screenshots and browse the ones taken of this TV: older ones to the left, newer to the right. They are kept
 * in this browser only (the TV's copy is deleted as soon as it is read), and can be downloaded or deleted here.
 */
export function ScreenshotCard({ device, className }: { device: SavedDevice; className: string }) {
  const { ready, call } = useRpc();
  const { confirm, toast } = useFeedback();
  const [method, setMethod] = useState<Shot['method']>('DISPLAY');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { shots, error: loadError } = useShots(device.id);
  const urls = useObjectUrls(shots);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const strip = useRef<HTMLOListElement>(null);
  const root = device.username === 'root';

  const list = shots ?? [];
  const found = currentId ? list.findIndex((s) => s.id === currentId) : -1;
  const index = found >= 0 ? found : list.length - 1; // newest by default
  const current = list[index];
  const chosen = list.filter((s) => selected.has(s.id));
  const total = list.reduce((n, s) => n + s.blob.size, 0);

  // Keep the current thumbnail in view inside the strip (without scrolling the page).
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('.shot-thumb.is-current');
    const box = strip.current;
    if (!el || !box) return;
    if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft - 8;
    else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth + 8;
  }, [current?.id, list.length]);

  const take = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('device.screenshot', { device: toTarget(device), method }, 60_000);
      const bin = atob(r.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const shot = await addShot(device.id, new Blob([bytes], { type: r.mime }), method);
      setCurrentId(shot.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const go = (to: number) => {
    const s = list[Math.max(0, Math.min(list.length - 1, to))];
    if (s) setCurrentId(s.id);
  };
  const onViewerKey = (e: KeyboardEvent) => {
    const to = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: list.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    go(to);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChosen = list.length > 0 && chosen.length === list.length;

  const download = async (items: readonly Shot[]) => {
    if (!items.length) return;
    if (items.length === 1) {
      saveBlob(items[0]!.blob, shotFileName(device.name, items[0]!));
      return;
    }
    try {
      const used = new Map<string, number>();
      const entries = await Promise.all(
        items.map(async (s) => {
          let name = shotFileName(device.name, s);
          const n = (used.get(name) ?? 0) + 1;
          used.set(name, n);
          if (n > 1) name = name.replace(/\.png$/, `-${n}.png`);
          return { name, data: new Uint8Array(await s.blob.arrayBuffer()), date: new Date(s.at) };
        }),
      );
      const stamp = shotFileName(device.name, { at: Date.now() }).replace(/\.png$/, '');
      saveBlob(zip(entries), `${stamp}-screenshots.zip`);
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t make the zip file', text: describeError(e).message });
    }
  };

  const remove = async (items: readonly Shot[]) => {
    if (!items.length) return;
    const ok = await confirm({
      title: items.length === 1 ? 'Delete this screenshot?' : items.length === list.length ? `Delete all ${items.length} screenshots?` : `Delete ${items.length} screenshots?`,
      message: <p>They are removed from this browser. Download any you want to keep first. Nothing on the TV is affected.</p>,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const gone = new Set(items.map((s) => s.id));
    if (current && gone.has(current.id)) {
      // Move to the nearest one that stays: the next newer, else the next older.
      const after = list.slice(index + 1).find((s) => !gone.has(s.id));
      const before = list.slice(0, index).reverse().find((s) => !gone.has(s.id));
      setCurrentId((after ?? before)?.id ?? null);
    }
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    try {
      await deleteShots([...gone]);
    } catch (e) {
      toast({ kind: 'danger', title: 'Couldn’t delete the screenshots', text: describeError(e).message });
    }
  };

  return (
    <Card eyebrow="Screen" title="Screenshots" className={className}>
      <div className="stack">
        {!root ? (
          <Alert kind="info" title="Needs a rooted TV">
            Screenshots use the TV’s capture service, which only root can call. Developer Mode logins can’t take them.
          </Alert>
        ) : (
          <div className="row">
            <div className="tabs pills" role="group" aria-label="What to capture">
              {METHODS.map((m) => (
                <button key={m.id} type="button" aria-pressed={method === m.id} className={`tab${method === m.id ? ' is-active' : ''}`} onClick={() => setMethod(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--primary" onClick={take} disabled={busy || !ready}>
              {busy ? <span className="spinner sm" /> : <Icon name="image" />} Take screenshot
            </button>
          </div>
        )}
        {error !== null && <ErrorAlert error={error} title="Couldn’t take a screenshot" />}
        {loadError !== null && <ErrorAlert error={loadError} title="Couldn’t read the saved screenshots" />}

        {current ? (
          <>
            <div className="shots-viewer" tabIndex={0} role="group" aria-label="Screenshot viewer — use the arrow keys for older and newer" onKeyDown={onViewerKey}>
              {urls.get(current.id) ? (
                <img src={urls.get(current.id)} alt={`Screenshot of ${device.name}, ${when(current.at)}`} />
              ) : (
                <div className="shots-viewer-blank" />
              )}
              <button type="button" className="shots-nav prev" onClick={() => go(index - 1)} disabled={index <= 0} aria-label="Older screenshot" title="Older (←)">
                <Icon name="left" />
              </button>
              <button type="button" className="shots-nav next" onClick={() => go(index + 1)} disabled={index >= list.length - 1} aria-label="Newer screenshot" title="Newer (→)">
                <Icon name="right" />
              </button>
            </div>
            <div className="shots-meta">
              <span className="badge">
                {index + 1} of {list.length}
              </span>
              <span className="muted">
                {when(current.at)} · {methodLabel(current.method)} · {fmtBytes(current.blob.size)}
              </span>
              <span className="spacer" />
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => download([current])}>
                <Icon name="download" /> Download
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove([current])} aria-label="Delete this screenshot">
                <Icon name="trash" /> Delete
              </button>
            </div>

            {list.length > 1 && (
              <ol className="shots-strip" ref={strip} aria-label="All screenshots, oldest first">
                {list.map((s, i) => {
                  const isCurrent = s.id === current.id;
                  const isSel = selected.has(s.id);
                  return (
                    <li key={s.id} className={`shot-thumb${isCurrent ? ' is-current' : ''}${isSel ? ' is-selected' : ''}`}>
                      <button type="button" className="shot-thumb-btn" onClick={() => setCurrentId(s.id)} aria-current={isCurrent || undefined} aria-label={`Show screenshot ${i + 1}, ${when(s.at)}`}>
                        {urls.get(s.id) && <img src={urls.get(s.id)} alt="" />}
                      </button>
                      <label className="check shot-thumb-check">
                        <input type="checkbox" checked={isSel} onChange={() => toggle(s.id)} aria-label={`Select screenshot ${i + 1}`} />
                        <span className="box" />
                      </label>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="shots-bar">
              <label className="check">
                <input
                  type="checkbox"
                  checked={allChosen}
                  ref={(el) => {
                    if (el) el.indeterminate = chosen.length > 0 && !allChosen;
                  }}
                  onChange={() => setSelected(allChosen ? new Set() : new Set(list.map((s) => s.id)))}
                  aria-label="Select all screenshots"
                />
                <span className="box" />
                <span>{chosen.length ? `${chosen.length} selected` : 'Select all'}</span>
              </label>
              <span className="muted">
                {list.length} {list.length === 1 ? 'screenshot' : 'screenshots'} · {fmtBytes(total)}, kept in this browser
              </span>
              <span className="spacer" />
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => download(chosen.length ? chosen : list)}>
                <Icon name="download" /> {chosen.length ? `Download ${chosen.length}` : 'Download all'}
                {(chosen.length || list.length) > 1 ? ' (.zip)' : ''}
              </button>
              <button type="button" className="btn btn--sm btn--ghost btn--danger-ghost" onClick={() => remove(chosen.length ? chosen : list)}>
                <Icon name="trash" /> {chosen.length ? `Delete ${chosen.length}` : 'Delete all'}…
              </button>
            </div>
          </>
        ) : (
          root &&
          shots !== null && (
            <div className="screenshot screenshot--empty">
              <Icon name="image" />
              <span>
                “Everything” is what’s on screen; “Video only” and “UI only” capture one layer. Screenshots are kept in this browser, not on the TV.
              </span>
            </div>
          )
        )}
      </div>
    </Card>
  );
}
