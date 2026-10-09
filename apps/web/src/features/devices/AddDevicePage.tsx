import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DeviceErrorCodes, type ScanResult } from '@lgdm/protocol';
import { PageHeader } from '../../components/PageHeader';
import { Alert } from '../../components/Alert';
import { ErrorAlert, describeError } from '../../components/ErrorAlert';
import { useFeedback } from '../../components/Feedback';
import { Icon, type IconName } from '../../shell/icons';
import { useRpc } from '../../bridge/useRpc';
import { addDevice, setActiveDeviceId } from '../../devices/store';
import { useDevices } from '../../devices/useDevices';
import { AuthFields } from './AuthFields';
import { PortCheck, SshOffHint, type PortResult } from './PortCheck';
import { ScanPanel, tvLabel } from './ScanPanel';
import { STEP_LABELS, verifyDevice, type VerifyState, type VerifyStepId } from './verify';
import { MODE_DEFAULTS, authProblems, emptyAuth, hostProblem, type AuthDraft, type AuthKind, type SetupMode } from './auth';

type Step = 'mode' | 'prepare' | 'details' | 'verify';

const MODES: { id: SetupMode; icon: IconName; title: string; text: string; badge?: string }[] = [
  {
    id: 'rooted',
    icon: 'shield',
    title: 'Rooted (Homebrew Channel)',
    text: 'For rooted TVs with Homebrew Channel’s SSH server turned on. Logs in as root on port 22 — full access, no session to renew.',
    badge: 'Recommended',
  },
  {
    id: 'devmode',
    icon: 'tv',
    title: 'Developer Mode',
    text: 'For TVs that aren’t rooted. Uses the Developer Mode app: SSH on port 9922 and the key from its key server.',
  },
  {
    id: 'manual',
    icon: 'wrench',
    title: 'Set up manually',
    text: 'Choose the port, user and login yourself — password, your own key, or a new key.',
  },
];

const AUTH_KINDS: Record<SetupMode, AuthKind[]> = {
  devmode: ['devkey'],
  rooted: ['password', 'key', 'generated'],
  manual: ['key', 'password', 'generated', 'devkey'],
};

/** Dev Mode checklist from devmode-setup.component.html. */
const PREPARE: { title: string; body: ReactNode }[] = [
  {
    title: 'Prepare an LG developer account',
    body: (
      <>
        Developer Mode needs a free LG developer account. Create one at{' '}
        <a href="https://webostv.developer.lge.com/" target="_blank" rel="noopener noreferrer">
          webostv.developer.lge.com
        </a>
        .
      </>
    ),
  },
  {
    title: 'Install the Developer Mode app',
    body: <ol><li>Open the LG Content Store on the TV</li><li>Search for “Developer Mode”</li><li>Select Install</li></ol>,
  },
  {
    title: 'Turn on Developer Mode',
    body: <ol><li>Launch the Developer Mode app</li><li>Log in with your developer account</li><li>Turn on Dev Mode Status and wait for the TV to restart</li></ol>,
  },
  {
    title: 'Get ready to connect',
    body: <ol><li>Launch the Developer Mode app again</li><li>Make sure Dev Mode Status is ON</li><li>Turn on Key Server — it hands this app the login key</li></ol>,
  },
];

/**
 * Starting login per mode. Rooted TVs get Homebrew Channel's placeholder root password (`alpine`, set by its
 * services/startup.sh until an SSH key is added) so the common case needs no typing.
 */
const ROOTED_DEFAULT_PASSWORD = 'alpine';
function initialAuth(m: SetupMode): AuthDraft {
  return m === 'rooted' ? { kind: 'password', password: ROOTED_DEFAULT_PASSWORD } : emptyAuth(AUTH_KINDS[m][0]!);
}

function Stepper({ steps, current }: { steps: { id: Step; label: string }[]; current: Step }) {
  const idx = steps.findIndex((s) => s.id === current);
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.id} className={i < idx ? 'is-done' : i === idx ? 'is-current' : undefined} aria-current={i === idx ? 'step' : undefined}>
          <span className="stepper-num">{i < idx ? <Icon name="check" strokeWidth={2.6} /> : i + 1}</span>
          <span className="stepper-label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function suggestName(existing: string[]): string {
  const base = 'LG TV';
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) if (!existing.includes(`${base} ${n}`)) return `${base} ${n}`;
}

export function AddDevicePage() {
  const navigate = useNavigate();
  const { ready, call } = useRpc();
  const { devices } = useDevices();
  const { toast } = useFeedback();
  const names = useMemo(() => (devices ?? []).map((d) => d.name), [devices]);

  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<SetupMode>('rooted');
  const [prepared, setPrepared] = useState<boolean[]>(PREPARE.map(() => false));
  const [openPrepare, setOpenPrepare] = useState(0);

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(MODE_DEFAULTS.rooted.port);
  const [username, setUsername] = useState(MODE_DEFAULTS.rooted.username);
  const [description, setDescription] = useState('');
  const [auth, setAuth] = useState<AuthDraft>(initialAuth('rooted'));
  const [keyUsable, setKeyUsable] = useState(true);
  const [showErrors, setShowErrors] = useState(false);

  const [ports, setPorts] = useState<PortResult | null>(null);
  const [portsFor, setPortsFor] = useState('');
  const [checking, setChecking] = useState(false);

  const [verify, setVerify] = useState<VerifyState | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const steps = useMemo(
    () => [
      { id: 'mode' as const, label: 'Connection' },
      ...(mode === 'devmode' ? [{ id: 'prepare' as const, label: 'Prepare TV' }] : []),
      { id: 'details' as const, label: 'Details' },
      { id: 'verify' as const, label: 'Verify' },
    ],
    [mode],
  );

  const chooseMode = (m: SetupMode) => {
    setMode(m);
    setPort(MODE_DEFAULTS[m].port);
    setUsername(MODE_DEFAULTS[m].username);
    setAuth(initialAuth(m));
    setPorts(null);
  };

  const onKeyCheck = useCallback((usable: boolean) => setKeyUsable(usable), []);

  /** A TV picked from the network scan: fill in its address (and name), and show its ports right away. */
  const pickTv = (tv: ScanResult) => {
    setHost(tv.host);
    if (!name.trim() && (tv.name || tv.modelName)) setName(tvLabel(tv).slice(0, 64));
    setPorts({ ssh22: tv.ports.ssh22, ssh9922: tv.ports.ssh9922, keyServer: tv.ports.keyServer, webos: tv.ports.webos });
    setPortsFor(tv.host);
  };

  const trimmedName = (name || suggestName(names)).trim();
  const nameProblem = !trimmedName
    ? 'Give the TV a name.'
    : trimmedName.length > 64
      ? 'Keep the name under 64 characters.'
      : names.includes(trimmedName)
        ? 'You already have a TV with this name.'
        : null;
  const hostErr = hostProblem(host);
  const portProblem = !Number.isInteger(port) || port < 1 || port > 65535 ? 'Port must be 1–65535.' : null;
  const userProblem = !/^[a-z_][a-z0-9_-]{0,31}$/.test(username) ? 'Not a valid user name.' : null;
  const detailsValid =
    !nameProblem && !hostErr && !portProblem && !userProblem && Object.keys(authProblems(auth)).length === 0 && (auth.kind !== 'key' || keyUsable);

  const checkPorts = async () => {
    const h = host.trim();
    if (hostProblem(h) || !ready) return;
    setChecking(true);
    setPortsFor(h);
    try {
      setPorts(await call('device.checkConnection', { host: h }, 20_000));
    } catch (e) {
      setPorts(null);
      toast({ kind: 'danger', title: 'Port check failed', text: describeError(e).message });
    } finally {
      setChecking(false);
    }
  };

  const runVerify = async () => {
    // Freeze the suggested name: once saved, the suggestion would move on to "LG TV 2".
    setName(trimmedName);
    setStep('verify');
    setVerifying(true);
    setSaved(null);
    try {
      const res = await verifyDevice(call, { host: host.trim(), port, username, auth }, setVerify);
      if (!res.error) await save(res);
      // A refused login: check the ports to tell "SSH is off" apart from "wrong address".
      else if (res.failedAt === 'login') checkPorts();
    } catch (e) {
      toast({ kind: 'danger', title: 'Could not save the TV', text: describeError(e).message });
    } finally {
      setVerifying(false);
    }
  };

  const save = async (res: VerifyState) => {
    if (!res.auth) return;
    const d = await addDevice({
      name: trimmedName,
      mode: mode === 'manual' ? (username === 'root' ? 'rooted' : 'devmode') : mode,
      host: host.trim(),
      port,
      username,
      auth: res.auth,
      ...(description.trim() ? { description: description.trim() } : {}),
    });
    setActiveDeviceId(d.id);
    setSaved(d.id);
  };

  const onDetailsSubmit = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (detailsValid) runVerify();
  };

  // Root SSH refused, but the TV itself answers on its webOS port: Homebrew Channel's SSH server is off.
  const loginUnreachable =
    verify?.failedAt === 'login' &&
    ([DeviceErrorCodes.Unreachable, DeviceErrorCodes.Timeout] as string[]).includes(describeError(verify.error).code);
  const sshOff =
    loginUnreachable && mode !== 'devmode' && port === 22 && portsFor === host.trim() && !!ports?.webos && !ports.ssh22 && !checking;

  const prev = () => {
    const i = steps.findIndex((s) => s.id === step);
    if (i > 0) setStep(steps[i - 1]!.id);
  };

  return (
    <>
      <PageHeader eyebrow="Setup" title="Add a" accent="TV" sub="Connect this browser to an LG TV in Developer Mode or a rooted TV." />
      <div className="grid">
        <section className="card col-12 wizard">
          <Stepper steps={steps} current={step} />

          {!ready && step !== 'verify' && (
            <Alert kind="warning" title="The bridge isn’t connected" action={<Link to="/bridge" className="btn btn--sm btn--ghost">Set up the bridge</Link>}>
              Adding a TV needs the bridge running on this computer: it checks the ports, fetches the key and tests the login.
            </Alert>
          )}

          {step === 'mode' && (
            <div className="wizard-body">
              <p className="muted wizard-lead">If your TV is rooted with Homebrew Channel, choose Rooted. If it isn’t rooted, or you’re not sure, choose Developer Mode.</p>
              <div className="choice-grid" role="radiogroup" aria-label="Connection type">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={mode === m.id}
                    className={`choice${mode === m.id ? ' is-selected' : ''}`}
                    onClick={() => chooseMode(m.id)}
                    onDoubleClick={() => setStep(m.id === 'devmode' ? 'prepare' : 'details')}
                  >
                    <span className="choice-icon"><Icon name={m.icon} /></span>
                    <span className="choice-title">
                      {m.title} {m.badge && <span className="badge primary">{m.badge}</span>}
                    </span>
                    <span className="choice-text">{m.text}</span>
                  </button>
                ))}
              </div>
              <div className="form-actions">
                <Link to="/devices" className="btn btn--ghost">Cancel</Link>
                <span className="spacer" />
                <button type="button" className="btn btn--primary" onClick={() => setStep(mode === 'devmode' ? 'prepare' : 'details')}>
                  Next <Icon name="chevRight" />
                </button>
              </div>
            </div>
          )}

          {step === 'prepare' && (
            <div className="wizard-body">
              <p className="muted wizard-lead">Do these on the TV first. Tick each one off — or skip if your TV is already set up.</p>
              <div className="accordion">
                {PREPARE.map((p, i) => (
                  <div key={p.title} className={`accordion-item${openPrepare === i ? ' is-open' : ''}${prepared[i] ? ' is-done' : ''}`}>
                    <div className="accordion-trigger-row">
                      <label className="check" title="Done">
                        <input
                          type="checkbox"
                          checked={prepared[i]}
                          onChange={(e) => {
                            const next = prepared.map((v, j) => (j === i ? e.target.checked : v));
                            setPrepared(next);
                            if (e.target.checked) setOpenPrepare(next.findIndex((v) => !v));
                          }}
                        />
                        <span className="box" />
                        <span className="sr-only">Mark “{p.title}” done</span>
                      </label>
                      <button type="button" className="accordion-trigger" aria-expanded={openPrepare === i} onClick={() => setOpenPrepare(openPrepare === i ? -1 : i)}>
                        <span>{i + 1}. {p.title}</span>
                        <span className="chev"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg></span>
                      </button>
                    </div>
                    <div className="accordion-body"><div className="accordion-body-inner">{p.body}</div></div>
                  </div>
                ))}
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn--ghost" onClick={prev}>Back</button>
                <span className="spacer" />
                <button type="button" className="btn btn--primary" onClick={() => setStep('details')}>
                  {prepared.every(Boolean) ? 'Next' : 'Skip'} <Icon name="chevRight" />
                </button>
              </div>
            </div>
          )}

          {step === 'details' && (
            <form className="wizard-body" onSubmit={onDetailsSubmit} noValidate>
              <ScanPanel selected={host.trim()} onPick={pickTv} />
              <div className="form-grid">
                <div className="field">
                  <label className="field-label" htmlFor="dev-name">Name <span className="req">*</span></label>
                  <input
                    id="dev-name"
                    className={`input${showErrors && nameProblem ? ' is-invalid' : ''}`}
                    value={name}
                    placeholder={suggestName(names)}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={64}
                    autoComplete="off"
                  />
                  {showErrors && nameProblem ? <span className="field-error">{nameProblem}</span> : <span className="field-help">Shown in the device switcher.</span>}
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="dev-host">IP address <span className="req">*</span></label>
                  <div className="input-row">
                    <input
                      id="dev-host"
                      className={`input mono${showErrors && hostErr ? ' is-invalid' : ''}`}
                      value={host}
                      placeholder="192.168.1.20"
                      onChange={(e) => setHost(e.target.value)}
                      onBlur={() => host.trim() !== portsFor && checkPorts()}
                      autoComplete="off"
                      spellCheck={false}
                      inputMode="url"
                    />
                    <button type="button" className="btn btn--ghost" onClick={checkPorts} disabled={!ready || !!hostErr || checking}>
                      {checking ? <span className="spinner sm" /> : <Icon name="pulse" />} Check
                    </button>
                  </div>
                  {showErrors && hostErr ? (
                    <span className="field-error">{hostErr}</span>
                  ) : (
                    <span className="field-help">On the TV: Settings → General → Network → Wi-Fi / Wired → Advanced.</span>
                  )}
                </div>
                <div className="span-2">
                  <PortCheck result={ports} checking={checking} mode={mode} port={port} />
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="dev-user">User</label>
                  <input
                    id="dev-user"
                    className={`input mono${showErrors && userProblem ? ' is-invalid' : ''}`}
                    value={username}
                    onChange={(e) => setUsername(e.target.value.trim())}
                    disabled={MODE_DEFAULTS[mode].fixed}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {showErrors && userProblem && <span className="field-error">{userProblem}</span>}
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="dev-port">SSH port</label>
                  <input
                    id="dev-port"
                    className={`input mono${showErrors && portProblem ? ' is-invalid' : ''}`}
                    type="number"
                    min={1}
                    max={65535}
                    value={Number.isNaN(port) ? '' : port}
                    onChange={(e) => setPort(e.target.valueAsNumber)}
                    disabled={MODE_DEFAULTS[mode].fixed}
                  />
                  {showErrors && portProblem && <span className="field-error">{portProblem}</span>}
                </div>

                <div className="span-2">
                  <AuthFields
                    value={auth}
                    onChange={setAuth}
                    kinds={AUTH_KINDS[mode]}
                    username={username}
                    showErrors={showErrors}
                    onKeyCheck={onKeyCheck}
                    rootedHint={mode !== 'devmode'}
                  />
                </div>

                <div className="field span-2">
                  <label className="field-label" htmlFor="dev-desc">Description</label>
                  <input
                    id="dev-desc"
                    className="input"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={200}
                    placeholder="Optional, e.g. living room, C2 55”"
                  />
                </div>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn--ghost" onClick={prev}>Back</button>
                <span className="spacer" />
                <button type="submit" className="btn btn--primary" disabled={!ready}>
                  Verify &amp; add <Icon name="chevRight" />
                </button>
              </div>
            </form>
          )}

          {step === 'verify' && verify && (
            <div className="wizard-body">
              <ul className="verify-list">
                {(Object.keys(STEP_LABELS) as VerifyStepId[])
                  .filter((id) => verify.steps[id] !== 'skipped')
                  .map((id) => (
                    <li key={id} className={`verify-step is-${verify.steps[id]}`}>
                      <span className="verify-icon">
                        {verify.steps[id] === 'running' ? (
                          <span className="spinner sm" />
                        ) : verify.steps[id] === 'done' ? (
                          <Icon name="check" strokeWidth={2.6} />
                        ) : verify.steps[id] === 'failed' ? (
                          <Icon name="x" strokeWidth={2.6} />
                        ) : (
                          <span className="verify-dot" />
                        )}
                      </span>
                      {STEP_LABELS[id]}
                    </li>
                  ))}
              </ul>

              {verify.error !== undefined && (
                <ErrorAlert
                  error={verify.error}
                  title={verify.failedAt === 'key' ? 'Couldn’t get the key from the TV' : verify.failedAt === 'login' ? 'Couldn’t log in' : 'Logged in, but couldn’t read the TV’s details'}
                  hint={sshOff ? null : <VerifyHint error={verify.error} step={verify.failedAt} mode={mode} />}
                />
              )}
              {sshOff && <SshOffHint />}

              {saved && !verify.info && (
                <Alert kind="success" title={`${trimmedName} was saved`}>Saved in this browser and set as the active TV.</Alert>
              )}

              {saved && verify.info && (
                <div className="verify-summary">
                  <div className="verify-summary-head">
                    <span className="verify-summary-icon"><Icon name="check" strokeWidth={2.6} /></span>
                    <div>
                      <div className="verify-summary-title">{trimmedName} is ready</div>
                      <div className="muted">Saved in this browser and set as the active TV.</div>
                    </div>
                  </div>
                  <dl className="kv">
                    <dt>Model</dt><dd>{verify.info.modelName ?? '—'}</dd>
                    <dt>webOS</dt><dd>{verify.info.osVersion ?? '—'}</dd>
                    <dt>Firmware</dt><dd className="mono">{verify.info.firmwareVersion ?? '—'}</dd>
                    <dt>Logged in as</dt><dd className="mono">{username}{verify.login?.root ? ' (root)' : ''}</dd>
                    <dt>Response time</dt><dd>{verify.login ? `${verify.login.latencyMs} ms` : '—'}</dd>
                  </dl>
                </div>
              )}

              <div className="form-actions">
                {!saved && (
                  <button type="button" className="btn btn--ghost" onClick={() => setStep('details')} disabled={verifying}>
                    Back to details
                  </button>
                )}
                <span className="spacer" />
                {!saved && !verifying && verify.error !== undefined && (
                  <>
                    {verify.failedAt !== 'key' && verify.auth && (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => save(verify).catch((e) => toast({ kind: 'danger', title: 'Could not save the TV', text: describeError(e).message }))}
                      >
                        Save anyway
                      </button>
                    )}
                    <button type="button" className="btn btn--primary" onClick={runVerify}>
                      <Icon name="refresh" /> Try again
                    </button>
                  </>
                )}
                {saved && (
                  <>
                    <button type="button" className="btn btn--ghost" onClick={() => navigate('/devices/new')}>
                      <Icon name="plus" /> Add another TV
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => navigate('/devices')}>Manage devices</button>
                    <button type="button" className="btn btn--primary" onClick={() => navigate('/apps/installed')}>
                      <Icon name="apps" /> Go to apps
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function VerifyHint({ error, step, mode }: { error: unknown; step?: VerifyStepId; mode: SetupMode }) {
  const { code } = describeError(error);
  if (code === DeviceErrorCodes.BadPassphrase || code === DeviceErrorCodes.PassphraseRequired) {
    return <>Check the passphrase in the Developer Mode app — it usually has 6 characters and is case-sensitive.</>;
  }
  if (code === DeviceErrorCodes.KeyServerUnreachable || code === DeviceErrorCodes.KeyNotFound) {
    return (
      <>
        Make sure <b>Key Server</b> is on in the Developer Mode app while you add the TV. If it is on and this keeps failing, try
        turning Developer Mode off and on again.
      </>
    );
  }
  if (code === DeviceErrorCodes.AuthFailed) {
    return mode === 'devmode' ? (
      <>The TV rejected the key. Turn Key Server off and on in the Developer Mode app and try again — the key changes when Developer Mode is re-enabled.</>
    ) : (
      <>
        Homebrew Channel’s root password is <span className="mono">alpine</span> — unless an SSH key has been added to{' '}
        <span className="mono">/home/root/.ssh/authorized_keys</span>, which turns password login off. Then log in with that key
        (Private key). For a new key, make sure its public key is in that file.
      </>
    );
  }
  if (code === DeviceErrorCodes.Unreachable || code === DeviceErrorCodes.Timeout) {
    return <>Check the address and that the TV is on and on the same network as this computer.</>;
  }
  if (step === 'info') return <>The login works, so you can save the TV anyway.</>;
  return null;
}
