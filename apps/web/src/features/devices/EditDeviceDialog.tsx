import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useFeedback } from '../../components/Feedback';
import { useRpc } from '../../bridge/useRpc';
import { updateDevice, type SavedDevice } from '../../devices/store';
import { useDevices } from '../../devices/useDevices';
import { AuthFields } from './AuthFields';
import { authProblems, describeLogin, hostProblem, toDeviceAuth, type AuthDraft, type AuthKind } from './auth';

/** Inline device editor (devices/inline-editor in the original): rename, change address, replace the login. */
export function EditDeviceDialog({ device, onClose }: { device: SavedDevice | null; onClose: () => void }) {
  const { call, ready } = useRpc();
  const { devices } = useDevices();
  const { toast } = useFeedback();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(0);
  const [username, setUsername] = useState('');
  const [auth, setAuth] = useState<AuthDraft>({ kind: 'keep' });
  const [keyUsable, setKeyUsable] = useState(true);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!device) return;
    setName(device.name);
    setDescription(device.description ?? '');
    setHost(device.host);
    setPort(device.port);
    setUsername(device.username);
    setAuth({ kind: 'keep' });
    setShowErrors(false);
    setError(null);
  }, [device]);

  const kinds: AuthKind[] = useMemo(
    () => ['keep', ...(device?.mode === 'devmode' ? (['devkey'] as const) : []), 'password', 'key', 'generated'],
    [device?.mode],
  );
  const onKeyCheck = useCallback((u: boolean) => setKeyUsable(u), []);

  if (!device) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;

  const nameProblem = !name.trim()
    ? 'Give the TV a name.'
    : devices?.some((d) => d.id !== device.id && d.name === name.trim())
      ? 'You already have a TV with this name.'
      : null;
  const hostErr = hostProblem(host);
  const portProblem = !Number.isInteger(port) || port < 1 || port > 65535 ? 'Port must be 1–65535.' : null;
  const userProblem = !/^[a-z_][a-z0-9_-]{0,31}$/.test(username) ? 'Not a valid user name.' : null;
  const valid = !nameProblem && !hostErr && !portProblem && !userProblem && Object.keys(authProblems(auth)).length === 0 && (auth.kind !== 'key' || keyUsable);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      let newAuth = auth.kind === 'keep' ? device.auth : toDeviceAuth(auth);
      if (auth.kind === 'devkey') {
        const { privateKey } = await call('device.fetchKey', { host: host.trim(), passphrase: auth.passphrase }, 30_000);
        newAuth = { kind: 'key', privateKey, passphrase: auth.passphrase };
      }
      // Forget the pooled connection made with the old details — only if they changed, so a rename
      // doesn't cut off an install that is still running on this TV.
      const connectionChanged =
        host.trim() !== device.host || port !== device.port || username !== device.username || auth.kind !== 'keep';
      if (ready && connectionChanged) {
        call('device.disconnect', { device: { host: device.host, port: device.port, username: device.username, auth: device.auth } }).catch(() => {});
      }
      await updateDevice(device.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        host: host.trim(),
        port,
        username,
        mode: username === 'root' ? 'rooted' : 'devmode',
        auth: newAuth!,
      });
      toast({ kind: 'success', title: `Saved ${name.trim()}` });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!busy}
      size="lg"
      title={`Edit ${device.name}`}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="edit-device" className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="edit-device" className="stack" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="ed-name">Name</label>
            <input id="ed-name" className={`input${showErrors && nameProblem ? ' is-invalid' : ''}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
            {showErrors && nameProblem && <span className="field-error">{nameProblem}</span>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ed-host">IP address</label>
            <input id="ed-host" className={`input mono${showErrors && hostErr ? ' is-invalid' : ''}`} value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
            {showErrors && hostErr && <span className="field-error">{hostErr}</span>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ed-user">User</label>
            <input id="ed-user" className={`input mono${showErrors && userProblem ? ' is-invalid' : ''}`} value={username} onChange={(e) => setUsername(e.target.value.trim())} spellCheck={false} />
            {showErrors && userProblem && <span className="field-error">{userProblem}</span>}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ed-port">SSH port</label>
            <input id="ed-port" className={`input mono${showErrors && portProblem ? ' is-invalid' : ''}`} type="number" value={Number.isNaN(port) ? '' : port} onChange={(e) => setPort(e.target.valueAsNumber)} />
            {showErrors && portProblem && <span className="field-error">{portProblem}</span>}
          </div>
          <div className="field span-2">
            <label className="field-label" htmlFor="ed-desc">Description</label>
            <input id="ed-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </div>
          <div className="span-2">
            <AuthFields value={auth} onChange={setAuth} kinds={kinds} username={username} showErrors={showErrors} onKeyCheck={onKeyCheck} rootedHint={device.mode === 'rooted'} />
            {auth.kind === 'keep' && <p className="field-help" style={{ margin: '8px 0 0' }}>Currently: {describeLogin(device.auth)}.</p>}
          </div>
        </div>
        {error !== null && <ErrorAlert error={error} title="Couldn’t save" />}
      </form>
    </Modal>
  );
}

