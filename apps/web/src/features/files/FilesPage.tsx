import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { TvName } from '../../components/TvName';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_UPLOAD_BYTES, type FileItem } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { NeedsDevice } from '../../components/NeedsDevice';
import { useFeedback } from '../../components/Feedback';
import { Icon, type IconName } from '../../shell/icons';
import { newOpId, onOpProgress, uploadToBridge, useRpc } from '../../bridge/useRpc';
import { BridgeError } from '../../bridge/client';
import { useDevices } from '../../devices/useDevices';
import { toTarget, type SavedDevice } from '../../devices/store';
import { NameDialog, PreviewDialog, ProgressDialog, type Preview, type Progress } from './dialogs';
import {
  crumbsOf,
  fmtBytes,
  fmtTime,
  imageType,
  isDirLike,
  isFileLike,
  isProbablyText,
  joinPath,
  normalizePath,
  parentOf,
  sortItems,
  type SortKey,
} from './paths';
import { readRemoteFile, saveBlob } from './transfer';

const PREVIEW_TEXT_BYTES = 512 * 1024;
const PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024;
const LARGE_DOWNLOAD = 500 * 1024 * 1024;

/** The Files page (FilesComponent in the original), remounted per TV so history and selection start fresh. */
export function FilesPage() {
  const { active } = useDevices();
  return (
    <>
      <PageHeader
        eyebrow="Device"
        title="Files"
        sub={active ? <>Browse <TvName device={active} /> over SFTP. Drop files on this page to upload them to the folder you’re in.</> : 'Browse your TV’s files.'}
      />
      <div className="grid">
        <NeedsDevice device={active}>{active && <FileBrowser key={`${active.id}:${active.updatedAt}`} device={active} />}</NeedsDevice>
      </div>
    </>
  );
}

function typeIcon(f: FileItem): IconName {
  if (isDirLike(f)) return 'folder';
  if (f.type === 'l') return 'link';
  if (f.type === '-') return imageType(f.name) ? 'image' : 'file';
  return 'cog';
}

function FileBrowser({ device }: { device: SavedDevice }) {
  const { ready, call, client } = useRpc();
  const { confirm, toast } = useFeedback();
  const qc = useQueryClient();
  const target = useMemo(() => toTarget(device), [device]);

  const [history, setHistory] = useState<{ stack: string[]; i: number } | null>(null);
  const cwd = history ? history.stack[history.i]! : null;
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [nameDialog, setNameDialog] = useState<{ kind: 'mkdir' } | { kind: 'rename'; item: FileItem } | null>(null);
  const [preview, setPreview] = useState<(Preview & { path: string }) | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const home = useQuery({
    queryKey: ['files-home', device.id, device.updatedAt],
    queryFn: async () => (await call('files.home', { device: target }, 30_000)).path,
    enabled: ready,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    if (!history && home.data) setHistory({ stack: [home.data], i: 0 });
  }, [home.data, history]);

  const listKey = ['files', device.id, device.updatedAt, cwd] as const;
  const listing = useQuery({
    queryKey: listKey,
    queryFn: () => call('files.list', { device: target, path: cwd! }, 60_000),
    enabled: ready && !!cwd,
    staleTime: 10_000,
    retry: false,
  });
  const storage = useQuery({
    queryKey: ['storage', device.id, device.updatedAt, cwd],
    queryFn: () => call('device.storage', { device: target, path: cwd! }, 30_000),
    enabled: ready && !!cwd,
    staleTime: 30_000,
    retry: false,
  });

  const items = useMemo(() => sortItems(listing.data?.items ?? [], sort.key, sort.dir), [listing.data, sort]);
  const names = useMemo(() => items.map((i) => i.name), [items]);
  const chosen = items.filter((i) => selected.has(i.name));
  const busy = !!progress && progress.error === undefined;

  const refresh = () => qc.invalidateQueries({ queryKey: ['files', device.id] });

  const go = (path: string) => {
    setSelected(new Set());
    setEditingPath(false);
    setHistory((h) => {
      if (!h) return { stack: [path], i: 0 };
      if (h.stack[h.i] === path) return h;
      // Keep the last 20 places, like HistoryStack (which keeps 10).
      const stack = [...h.stack.slice(0, h.i + 1), path].slice(-20);
      return { stack, i: stack.length - 1 };
    });
  };
  const step = (delta: number) => {
    setSelected(new Set());
    setHistory((h) => (h ? { ...h, i: Math.max(0, Math.min(h.stack.length - 1, h.i + delta)) } : h));
  };

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const allChecked = items.length > 0 && selected.size === items.length;

  const sortBy = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  const ariaSort = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

  // ---------- open / preview / download ----------

  const open = (f: FileItem) => {
    if (!cwd) return;
    if (isDirLike(f)) return go(joinPath(cwd, f.name));
    if (f.type === 'l' && f.link?.broken) {
      toast({ kind: 'warning', title: `${f.name} is a broken link`, text: f.link.target ? `It points to ${f.link.target}, which doesn’t exist.` : undefined });
      return;
    }
    if (isFileLike(f)) void showPreview(f);
  };

  const showPreview = async (f: FileItem) => {
    const path = joinPath(cwd!, f.name);
    const size = f.type === 'l' ? (await call('files.stat', { device: target, path }).catch(() => f)).size : f.size;
    const ac = new AbortController();
    abort.current = ac;
    setPreview({ kind: 'loading', name: f.name, size, got: 0, path });
    const update = (p: Preview) => !ac.signal.aborted && setPreview({ ...p, path });
    try {
      const mime = imageType(f.name);
      if (mime && size <= PREVIEW_IMAGE_BYTES) {
        const r = await readRemoteFile(client!, target, path, { onProgress: (got) => update({ kind: 'loading', name: f.name, size, got }), signal: ac.signal });
        update({ kind: 'image', name: f.name, size, url: URL.createObjectURL(new Blob(r.parts, { type: mime })) });
        return;
      }
      const r = await readRemoteFile(client!, target, path, { limit: PREVIEW_TEXT_BYTES, signal: ac.signal });
      const bytes = new Uint8Array(await new Blob(r.parts).arrayBuffer()).subarray(0, PREVIEW_TEXT_BYTES);
      if (!isProbablyText(bytes)) return update({ kind: 'binary', name: f.name, size });
      update({ kind: 'text', name: f.name, size, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated: r.truncated || size > PREVIEW_TEXT_BYTES });
    } catch (e) {
      if (!(e instanceof BridgeError && e.code === 'cancelled')) update({ kind: 'error', name: f.name, size, error: e });
    }
  };

  const closePreview = () => {
    abort.current?.abort();
    if (preview?.kind === 'image') URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  /**
   * After a failure: Retry / Skip / Stop (the original's message dialog for get / put / rm). A single item gets
   * Retry and Stop only.
   */
  const afterError = (p: Omit<Progress, 'error' | 'errorTitle' | 'choose'>, error: unknown, errorTitle: string, canSkip: boolean) =>
    new Promise<'retry' | 'skip' | 'abort'>((resolve) =>
      setProgress({
        ...p,
        canCancel: false,
        canSkip,
        error,
        errorTitle,
        choose: (c) => {
          setProgress(null);
          resolve(c);
        },
      }),
    );

  const download = async (files: { name: string; path: string; size: number }[]) => {
    if (!client || !files.length) return;
    // Downloads are held in this browser's memory until saved; ask before very large ones.
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > LARGE_DOWNLOAD) {
      const ok = await confirm({
        title: `Download ${fmtBytes(total)}?`,
        message: <>The browser keeps the whole download in memory until it is saved, which can slow this computer down or fail for very large files.</>,
        confirmText: 'Download',
      });
      if (!ok) return;
    }
    const ac = new AbortController();
    abort.current = ac;
    let done = 0;
    for (const [i, f] of files.entries()) {
      const base = { title: files.length > 1 ? 'Downloading files' : `Downloading ${f.name}`, step: files.length > 1 ? `${i + 1} of ${files.length}: ${f.name}` : undefined, canCancel: true };
      for (;;) {
        setProgress({ ...base, text: 'Reading from the TV…', percent: f.size ? 0 : undefined });
        try {
          const r = await readRemoteFile(client, target, f.path, {
            signal: ac.signal,
            onProgress: (got) =>
              setProgress({ ...base, text: `${fmtBytes(got)} of ${fmtBytes(f.size)}`, percent: f.size ? Math.min(100, Math.round((got / f.size) * 100)) : undefined }),
          });
          saveBlob(new Blob(r.parts), f.name);
          done++;
          break;
        } catch (e) {
          if (e instanceof BridgeError && e.code === 'cancelled') return setProgress(null);
          const c = await afterError({ ...base, text: '' }, e, `Couldn’t download ${f.name}`, files.length > 1);
          if (c === 'abort') return;
          if (c === 'skip') break;
        }
      }
    }
    setProgress(null);
    if (done > 1) toast({ kind: 'success', title: `Downloaded ${done} files` });
  };

  const downloadSelected = () =>
    download(chosen.filter(isFileLike).map((f) => ({ name: f.name, path: joinPath(cwd!, f.name), size: f.type === '-' ? f.size : 0 })));

  // ---------- upload ----------

  const upload = async (list: File[]) => {
    if (!client || !cwd || !list.length || busy) return;
    const dir = cwd;
    const here = new Map(items.map((i) => [i.name, i]));
    const ac = new AbortController();
    abort.current = ac;
    let uploaded = 0;
    const finish = () => {
      refresh();
      storage.refetch();
      if (uploaded) toast({ kind: 'success', title: uploaded === 1 && list.length === 1 ? `Uploaded ${list[0]!.name}` : `Uploaded ${uploaded} ${uploaded === 1 ? 'file' : 'files'}`, text: `To ${dir}.` });
    };
    for (const [i, file] of list.entries()) {
      const title = list.length > 1 ? `Uploading ${list.length} files` : `Uploading ${file.name}`;
      const stepText = list.length > 1 ? `${i + 1} of ${list.length}: ${file.name}` : undefined;
      const base = { title, step: stepText, canCancel: true };
      const existing = here.get(file.name);
      const problem =
        file.size > MAX_UPLOAD_BYTES
          ? new Error(`It is larger than the bridge accepts (${fmtBytes(MAX_UPLOAD_BYTES)}).`)
          : existing && isDirLike(existing)
            ? new Error(`There is a folder called ${file.name} in ${dir}. Rename one of them first.`)
            : null;
      if (problem) {
        const c = await afterError({ ...base, text: '' }, problem, `Can’t upload ${file.name}`, list.length > 1);
        if (c === 'abort') return finish();
        continue;
      }
      if (existing) {
        setProgress(null);
        const replace = await confirm({
          title: `Replace ${file.name}?`,
          message: <>A file called <b>{file.name}</b> is already in <span className="mono">{dir}</span>. Replace it with the one from this computer?</>,
          confirmText: 'Replace',
          danger: true,
        });
        if (!replace) continue;
      }
      for (;;) {
        const opId = newOpId();
        setProgress({ ...base, text: 'Sending to the bridge…', percent: 0 });
        const off = onOpProgress(client, opId, (p) => setProgress({ ...base, canCancel: false, text: p.text ?? 'Copying to the TV…', percent: p.percent }));
        try {
          const uploadId = await uploadToBridge(
            client,
            file,
            (sent, total) => setProgress({ ...base, text: `Sending to the bridge… ${fmtBytes(sent)} of ${fmtBytes(total)}`, percent: Math.round((sent / Math.max(1, total)) * 100) }),
            ac.signal,
          );
          setProgress({ ...base, canCancel: false, text: 'Copying to the TV…', percent: 0 });
          await client.call('files.write', { device: target, path: joinPath(dir, file.name), uploadId, opId, overwrite: !!existing }, 30 * 60_000);
          uploaded++;
          break;
        } catch (e) {
          if (e instanceof BridgeError && e.code === 'cancelled') {
            setProgress(null);
            return finish();
          }
          const c = await afterError({ ...base, text: '' }, e, `Couldn’t upload ${file.name}`, list.length > 1);
          if (c === 'abort') return finish();
          if (c === 'skip') break;
        } finally {
          off();
        }
      }
    }
    setProgress(null);
    finish();
  };

  // ---------- delete / mkdir / rename ----------

  const remove = async () => {
    if (!cwd || !chosen.length) return;
    const shown = chosen.slice(0, 6);
    const ok = await confirm({
      title: chosen.length === 1 ? `Delete ${chosen[0]!.name}?` : `Delete ${chosen.length} items?`,
      message: (
        <>
          <ul className="plain-list mono">
            {shown.map((f) => (
              <li key={f.name}>
                {f.name}
                {f.type === 'd' ? '/ (and everything in it)' : ''}
              </li>
            ))}
            {chosen.length > shown.length && <li>…and {chosen.length - shown.length} more</li>}
          </ul>
          <p>This can’t be undone. Deleting files you don’t know may break your TV.</p>
        </>
      ),
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const dir = cwd;
    const targets = chosen;
    let deleted = 0;
    const finish = () => {
      setSelected(new Set());
      refresh();
      storage.refetch();
      if (deleted) toast({ kind: 'success', title: deleted === 1 && targets.length === 1 ? `Deleted ${targets[0]!.name}` : `Deleted ${deleted} ${deleted === 1 ? 'item' : 'items'}` });
    };
    for (const [i, f] of targets.entries()) {
      const base = { title: 'Deleting', step: targets.length > 1 ? `${i + 1} of ${targets.length}` : undefined, canCancel: false };
      for (;;) {
        setProgress({ ...base, text: f.name });
        try {
          await call('files.remove', { device: target, path: joinPath(dir, f.name) }, 130_000);
          deleted++;
          break;
        } catch (e) {
          const c = await afterError({ ...base, text: '' }, e, `Couldn’t delete ${f.name}`, targets.length > 1);
          if (c === 'abort') return finish();
          if (c === 'skip') break;
        }
      }
    }
    setProgress(null);
    finish();
  };


  const mkdir = async (name: string) => {
    await call('files.mkdir', { device: target, parent: cwd!, name });
    refresh();
    toast({ kind: 'success', title: `Created ${name}` });
  };
  const rename = async (item: FileItem, to: string) => {
    await call('files.rename', { device: target, parent: cwd!, from: item.name, to });
    setSelected(new Set([to]));
    refresh();
  };

  // ---------- path box ----------

  const submitPath = () => {
    const p = normalizePath(pathDraft, cwd ?? '/');
    if (!p) return toast({ kind: 'warning', title: 'That isn’t a path on the TV', text: 'Use an absolute path like /media/developer.' });
    go(p);
  };
  const onPathKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submitPath();
    if (e.key === 'Escape') setEditingPath(false);
  };

  // ---------- drag & drop ----------

  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      dragDepth.current++;
      setDragging(true);
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDragOver: (e: DragEvent) => {
      if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void upload([...e.dataTransfer.files]);
    },
  };

  const listError = listing.error ?? home.error;
  const canGoUp = !!cwd && cwd !== '/';
  const pct = storage.data ? Math.round((storage.data.used / Math.max(1, storage.data.total)) * 100) : 0;

  return (
    <section className="card col-12 files-card" {...dropHandlers}>
      <div className="files-nav">
        <div className="btn-group-tight">
          <button type="button" className="btn btn--icon btn--ghost" onClick={() => step(-1)} disabled={!history || history.i === 0} aria-label="Back" title="Back">
            <Icon name="chevLeft" />
          </button>
          <button type="button" className="btn btn--icon btn--ghost" onClick={() => step(1)} disabled={!history || history.i >= history.stack.length - 1} aria-label="Forward" title="Forward">
            <Icon name="chevRight" />
          </button>
          <button type="button" className="btn btn--icon btn--ghost" onClick={() => cwd && go(parentOf(cwd)!)} disabled={!canGoUp} aria-label="Up one folder" title="Up one folder">
            <Icon name="arrowUp" />
          </button>
          <button type="button" className="btn btn--icon btn--ghost" onClick={() => home.data && go(home.data)} disabled={!home.data} aria-label="Home folder" title={home.data ? `Home (${home.data})` : 'Home'}>
            <Icon name="home" />
          </button>
        </div>
        {editingPath ? (
          <input
            className="input mono files-path-input"
            aria-label="Path"
            value={pathDraft}
            autoFocus
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={onPathKey}
            onBlur={() => setEditingPath(false)}
            spellCheck={false}
          />
        ) : (
          <nav className="files-crumbs" aria-label="Folder path">
            {cwd ? (
              crumbsOf(cwd).map((c, i, all) => (
                <span key={c.path} className="files-crumb">
                  {i > 1 && <span className="files-crumb-sep">/</span>}
                  <button type="button" className={i === all.length - 1 ? 'is-current' : undefined} onClick={() => go(c.path)} aria-current={i === all.length - 1 ? 'page' : undefined}>
                    {i === 0 ? <Icon name="disk" /> : c.name}
                  </button>
                </span>
              ))
            ) : (
              <span className="muted">{home.error ? 'Couldn’t connect' : `Connecting to ${device.name}…`}</span>
            )}
            <button
              type="button"
              className="files-path-edit"
              onClick={() => {
                setPathDraft(cwd ?? '/');
                setEditingPath(true);
              }}
              aria-label="Type a path"
              title="Type a path"
            >
              <Icon name="edit" />
            </button>
          </nav>
        )}
        <div className="btn-group-tight">
          <button type="button" className="btn btn--icon btn--ghost" onClick={() => refresh()} disabled={!cwd || listing.isFetching} aria-label="Refresh" title="Refresh">
            <Icon name="refresh" className={listing.isFetching ? 'spin' : undefined} />
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNameDialog({ kind: 'mkdir' })} disabled={!listing.data || busy}>
            <Icon name="folderPlus" /> <span className="hide-sm">New folder</span>
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => fileInput.current?.click()} disabled={!listing.data || busy}>
            <Icon name="upload" /> <span className="hide-sm">Upload</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void upload([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {chosen.length > 0 && (
        <div className="files-selbar" role="toolbar" aria-label="Selected items">
          <span className="files-selbar-count">{chosen.length} selected</span>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={downloadSelected}
            disabled={busy || !chosen.some(isFileLike)}
            title={chosen.every(isFileLike) ? undefined : 'Folders are skipped — only files can be downloaded'}
          >
            <Icon name="download" /> Download
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNameDialog({ kind: 'rename', item: chosen[0]! })} disabled={busy || chosen.length !== 1}>
            <Icon name="edit" /> Rename
          </button>
          <button type="button" className="btn btn--sm btn--soft-danger" onClick={remove} disabled={busy}>
            <Icon name="trash" /> Delete
          </button>
          <button type="button" className="btn btn--sm btn--ghost files-selbar-clear" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {listError ? (
        <ErrorAlert
          error={listError}
          title={describeError(listError).code === 'no_sftp' ? 'The file browser needs SFTP' : `Couldn’t open ${cwd ?? 'the home folder'}`}
          action={
            <div className="row">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => (home.error ? home.refetch() : listing.refetch())}>
                Retry
              </button>
              {cwd && home.data && cwd !== home.data && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => go(home.data!)}>
                  Home
                </button>
              )}
            </div>
          }
        />
      ) : !listing.data ? (
        <div className="empty-state"><span className="spinner" /><p>{cwd ? `Opening ${cwd}…` : `Connecting to ${device.name}…`}</p></div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="folder" /></div>
          <h3>This folder is empty</h3>
          <p>Drop files here or use Upload to put something in it.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table files-table">
            <thead>
              <tr>
                <th className="files-check">
                  <label className="check" title={allChecked ? 'Select none' : 'Select all'}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      aria-label="Select all"
                      ref={(el) => {
                        if (el) el.indeterminate = selected.size > 0 && !allChecked;
                      }}
                      onChange={() => setSelected(allChecked ? new Set() : new Set(names))}
                    />
                    <span className="box" />
                  </label>
                </th>
                {(
                  [
                    ['name', 'Name', ''],
                    ['size', 'Size', 'files-num'],
                    ['mtime', 'Modified', 'hide-sm'],
                  ] as const
                ).map(([key, label, cls]) => (
                  <th key={key} className={`${cls} ${sort.key === key ? `sorted-${sort.dir}` : ''}`} aria-sort={ariaSort(key)}>
                    <button type="button" className="th-sort" onClick={() => sortBy(key)}>
                      {label}
                      <span className="sort"><Icon name="chevDown" /></span>
                    </button>
                  </th>
                ))}
                <th className="hide-sm">Permissions</th>
                <th className="hide-md">Owner</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => {
                const sel = selected.has(f.name);
                const readOnly = f.access && !f.access.write;
                return (
                  <tr key={f.name} className={sel ? 'is-selected' : undefined} onDoubleClick={() => open(f)}>
                    <td className="files-check">
                      <label className="check">
                        <input type="checkbox" checked={sel} onChange={() => toggle(f.name)} aria-label={`Select ${f.name}`} />
                        <span className="box" />
                      </label>
                    </td>
                    <td>
                      <div className="files-name">
                        <span className={`files-ico files-ico--${isDirLike(f) ? 'dir' : f.type === 'l' ? 'link' : 'file'}`}>
                          <Icon name={typeIcon(f)} />
                        </span>
                        {isDirLike(f) || isFileLike(f) || f.type === 'l' ? (
                          <button type="button" className="files-open" onClick={() => open(f)} title={isDirLike(f) ? `Open ${f.name}` : `Preview ${f.name}`}>
                            {f.name}
                          </button>
                        ) : (
                          <span className="files-open is-plain">{f.name}</span>
                        )}
                        {f.link && (
                          <span className={`files-link${f.link.broken ? ' is-broken' : ''}`} title={f.link.broken ? 'Broken link' : undefined}>
                            → {f.link.target ?? '?'}
                          </span>
                        )}
                        {readOnly && (
                          <span className="files-lock" title="Read-only for this login">
                            <Icon name="lock" />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="files-num mono">{isFileLike(f) && f.type === '-' ? fmtBytes(f.size) : '—'}</td>
                    <td className="hide-sm files-time">{fmtTime(f.mtime)}</td>
                    <td className="hide-sm mono files-mode">{f.type === '-' ? '-' : f.type}{f.mode}</td>
                    <td className="hide-md files-owner">
                      {f.user ?? '—'}
                      {f.group && f.group !== f.user ? <span className="muted"> · {f.group}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="data-foot files-foot">
        <span className="muted">
          {listing.data ? `${items.length} ${items.length === 1 ? 'item' : 'items'}` : ''}
          {chosen.length > 0 ? ` · ${chosen.length} selected` : ''}
        </span>
        {storage.data && (
          <div className="storage-bar" title={`Free space where ${cwd} lives`}>
            <Icon name="disk" />
            <span>
              <b>{fmtBytes(storage.data.available * 1024)}</b> free of {fmtBytes(storage.data.total * 1024)}
            </span>
            <div className="progress thin">
              <div className={`progress-fill${pct > 90 ? ' danger' : pct > 75 ? ' warning' : ''}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </div>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <Icon name="upload" />
            <div>Drop to upload to {cwd}</div>
          </div>
        </div>
      )}

      <NameDialog
        open={nameDialog?.kind === 'mkdir'}
        title="New folder"
        label={`Name of the new folder in ${cwd}`}
        confirmText="Create"
        taken={names}
        onSubmit={mkdir}
        onClose={() => setNameDialog(null)}
      />
      <NameDialog
        open={nameDialog?.kind === 'rename'}
        title={nameDialog?.kind === 'rename' ? `Rename ${nameDialog.item.name}` : 'Rename'}
        label="New name"
        initial={nameDialog?.kind === 'rename' ? nameDialog.item.name : ''}
        confirmText="Rename"
        taken={names}
        onSubmit={(to) => (nameDialog?.kind === 'rename' ? rename(nameDialog.item, to) : Promise.resolve())}
        onClose={() => setNameDialog(null)}
      />
      <PreviewDialog
        preview={preview}
        onClose={closePreview}
        onDownload={() => {
          if (!preview) return;
          const p = preview;
          closePreview();
          void download([{ name: p.name, path: p.path, size: p.size }]);
        }}
      />
      <ProgressDialog progress={progress} onCancel={() => abort.current?.abort()} onClose={() => setProgress(null)} />
    </section>
  );
}
