import { useEffect, useId, useRef, useState } from 'react';
import { DeviceErrorCodes } from '@lgdm/protocol';
import { useRpc } from '../../bridge/useRpc';
import { BridgeError } from '../../bridge/client';
import { Icon } from '../../shell/icons';
import { useFeedback } from '../../components/Feedback';
import { AUTH_LABELS, authProblems, emptyAuth, type AuthDraft, type AuthKind } from './auth';

type KeyCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; type: string; fingerprint: string }
  | { state: 'needs-passphrase' }
  | { state: 'bad-passphrase' }
  | { state: 'bad-key' }
  | { state: 'offline' };

const MAX_KEY_FILE = 64 * 1024;

/** Check a pasted / chosen private key with the bridge (verifyLocalPrivateKey in device-editor.component.ts). */
function useKeyCheck(privateKey: string, passphrase: string): KeyCheck {
  const { ready, call } = useRpc();
  const [check, setCheck] = useState<KeyCheck>({ state: 'idle' });
  useEffect(() => {
    if (!privateKey.trim()) return setCheck({ state: 'idle' });
    if (!ready) return setCheck({ state: 'offline' });
    let alive = true;
    setCheck({ state: 'checking' });
    const t = setTimeout(() => {
      call('device.verifyKey', { privateKey: privateKey.trim() + '\n', passphrase: passphrase || undefined })
        .then((r) => alive && setCheck({ state: 'ok', type: r.type, fingerprint: r.fingerprint }))
        .catch((e) => {
          if (!alive) return;
          const code = e instanceof BridgeError ? e.code : '';
          if (code === DeviceErrorCodes.PassphraseRequired) setCheck({ state: 'needs-passphrase' });
          else if (code === DeviceErrorCodes.BadPassphrase) setCheck({ state: 'bad-passphrase' });
          else if (code === DeviceErrorCodes.BadKey) setCheck({ state: 'bad-key' });
          else setCheck({ state: 'offline' });
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [privateKey, passphrase, ready, call]);
  return check;
}

/** True when a key draft can be saved (verified, or the bridge couldn't be asked). */
export function keyDraftUsable(check: KeyCheck) {
  return check.state === 'ok' || check.state === 'offline';
}

export function AuthFields({
  value,
  onChange,
  kinds,
  username,
  showErrors,
  onKeyCheck,
  rootedHint,
}: {
  value: AuthDraft;
  onChange: (v: AuthDraft) => void;
  kinds: AuthKind[];
  username: string;
  showErrors: boolean;
  /** Reports whether a private key draft is usable, so the parent can block "Next". */
  onKeyCheck?: (usable: boolean) => void;
  rootedHint?: boolean;
}) {
  const id = useId();
  const problems = showErrors ? authProblems(value) : {};
  const [showPw, setShowPw] = useState(false);

  return (
    <div className="stack auth-fields">
      {kinds.length > 1 && (
        <div className="field">
          <span className="field-label" id={`${id}-kind`}>Log in with</span>
          <div className="tabs pills" role="radiogroup" aria-labelledby={`${id}-kind`}>
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={value.kind === k}
                className={`tab${value.kind === k ? ' is-active' : ''}`}
                onClick={() => value.kind !== k && onChange(emptyAuth(k))}
              >
                {AUTH_LABELS[k]}
              </button>
            ))}
          </div>
        </div>
      )}

      {value.kind === 'devkey' && (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-pp`}>
            Passphrase <span className="req">*</span>
          </label>
          <input
            id={`${id}-pp`}
            className={`input mono passphrase-input${problems.passphrase ? ' is-invalid' : ''}`}
            value={value.passphrase}
            onChange={(e) => onChange({ ...value, passphrase: e.target.value.trim() })}
            placeholder="e.g. 1A2B3C"
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
          />
          {problems.passphrase ? (
            <span className="field-error">{problems.passphrase}</span>
          ) : (
            <span className="field-help">
              Open the <b>Developer Mode</b> app on the TV, turn on <b>Key Server</b>, and type the passphrase it shows (usually 6
              characters, case-sensitive). The private key is fetched from the TV when you continue.
            </span>
          )}
        </div>
      )}

      {value.kind === 'password' && (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-pw`}>
            Password for <span className="mono">{username}</span> <span className="req">*</span>
          </label>
          <div className="input-group">
            <input
              id={`${id}-pw`}
              className={`input${problems.password ? ' is-invalid' : ''}`}
              type={showPw ? 'text' : 'password'}
              value={value.password}
              onChange={(e) => onChange({ ...value, password: e.target.value })}
              autoComplete="off"
            />
            <button type="button" className="addon addon--btn" onClick={() => setShowPw((s) => !s)}>
              {showPw ? 'Hide' : 'Show'}
            </button>
          </div>
          {problems.password ? (
            <span className="field-error">{problems.password}</span>
          ) : (
            rootedHint && (
              <span className="field-help">
                Homebrew Channel sets root’s password to <span className="mono">alpine</span> until you add an SSH key to{' '}
                <span className="mono">/home/root/.ssh/authorized_keys</span> — after that only the key works. A key is safer.
              </span>
            )
          )}
        </div>
      )}

      {value.kind === 'key' && <PrivateKeyFields value={value} onChange={onChange} problem={problems.privateKey} onKeyCheck={onKeyCheck} />}

      {value.kind === 'generated' && <GeneratedKey value={value} onChange={onChange} username={username} problem={problems.privateKey} />}
    </div>
  );
}

function PrivateKeyFields({
  value,
  onChange,
  problem,
  onKeyCheck,
}: {
  value: Extract<AuthDraft, { kind: 'key' }>;
  onChange: (v: AuthDraft) => void;
  problem?: string;
  onKeyCheck?: (usable: boolean) => void;
}) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const check = useKeyCheck(value.privateKey, value.passphrase);
  const [fileError, setFileError] = useState<string | null>(null);
  const needsPassphrase = check.state === 'needs-passphrase' || check.state === 'bad-passphrase' || !!value.passphrase;

  useEffect(() => onKeyCheck?.(keyDraftUsable(check)), [check, onKeyCheck]);

  const pick = async (f: File) => {
    setFileError(null);
    if (f.size > MAX_KEY_FILE) return setFileError('That file is too big to be a private key.');
    const text = await f.text();
    onChange({ ...value, privateKey: text, fileName: f.name });
  };

  return (
    <>
      <div className="field">
        <div className="field-label-row">
          <label className="field-label" htmlFor={`${id}-key`}>
            Private key <span className="req">*</span>
          </label>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => fileRef.current?.click()}>
            <Icon name="files" /> Choose key file…
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pick(f);
              e.target.value = '';
            }}
          />
        </div>
        <textarea
          id={`${id}-key`}
          className={`textarea mono key-textarea${problem || check.state === 'bad-key' ? ' is-invalid' : ''}`}
          value={value.privateKey}
          onChange={(e) => onChange({ ...value, privateKey: e.target.value, fileName: undefined })}
          placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
          spellCheck={false}
          autoComplete="off"
          rows={5}
        />
        {problem && <span className="field-error">{problem}</span>}
        {fileError && <span className="field-error">{fileError}</span>}
        {!problem && !fileError && (
          <span className="field-help">
            {value.fileName ? <>Loaded from <span className="mono">{value.fileName}</span>. </> : null}
            Usually <span className="mono">~/.ssh/id_ed25519</span> or <span className="mono">id_rsa</span> on your computer. It is
            saved only in this browser.
          </span>
        )}
        <KeyCheckLine check={check} />
      </div>
      {needsPassphrase && (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-kpp`}>
            Key passphrase
          </label>
          <input
            id={`${id}-kpp`}
            className={`input${check.state === 'bad-passphrase' ? ' is-invalid' : ''}`}
            type="password"
            value={value.passphrase}
            onChange={(e) => onChange({ ...value, passphrase: e.target.value })}
            autoComplete="off"
          />
        </div>
      )}
    </>
  );
}

function KeyCheckLine({ check }: { check: KeyCheck }) {
  switch (check.state) {
    case 'checking':
      return <span className="field-help"><span className="spinner sm" /> Checking key…</span>;
    case 'ok':
      return (
        <span className="field-ok">
          <Icon name="check" strokeWidth={2.4} /> {check.type} key · <span className="mono">{check.fingerprint}</span>
        </span>
      );
    case 'needs-passphrase':
      return <span className="field-error">This key is protected. Enter its passphrase below.</span>;
    case 'bad-passphrase':
      return <span className="field-error">Wrong passphrase for this key.</span>;
    case 'bad-key':
      return <span className="field-error">This doesn’t look like a private key (unsupported format).</span>;
    case 'offline':
      return <span className="field-help">Connect the bridge to check this key.</span>;
    default:
      return null;
  }
}

function GeneratedKey({
  value,
  onChange,
  username,
  problem,
}: {
  value: Extract<AuthDraft, { kind: 'generated' }>;
  onChange: (v: AuthDraft) => void;
  username: string;
  problem?: string;
}) {
  const { ready, call } = useRpc();
  const { toast } = useFeedback();
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const k = await call('device.generateKey', { comment: 'lg-dev-manager' });
      onChange({ kind: 'generated', ...k });
    } catch (e) {
      toast({ kind: 'danger', title: 'Could not make a key', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const authorizedKeys = username === 'root' ? '/home/root/.ssh/authorized_keys' : '~/.ssh/authorized_keys';
  if (!value.privateKey) {
    return (
      <div className="field">
        <span className="field-help">
          The bridge makes a new ed25519 key pair. The private key is saved only in this browser; you add the public key to the
          TV once.
        </span>
        <div>
          <button type="button" className="btn btn--soft-primary" onClick={make} disabled={!ready || busy}>
            <Icon name="key" /> {busy ? 'Making key…' : 'Make a new key'}
          </button>
        </div>
        {problem && <span className="field-error">{problem}</span>}
      </div>
    );
  }
  return (
    <div className="field">
      <span className="field-label">Public key — add this line to the TV</span>
      <div className="codeblock codeblock--wrap">{value.publicKey}</div>
      <div className="row">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() =>
            navigator.clipboard.writeText(value.publicKey).then(
              () => toast({ kind: 'success', title: 'Public key copied' }),
              () => toast({ kind: 'warning', title: 'Copy failed', text: 'Select the key and copy it by hand.' }),
            )
          }
        >
          <Icon name="copy" /> Copy
        </button>
        <span className="field-help">
          Append it to <span className="mono">{authorizedKeys}</span> on the TV (for example from an SSH session that still uses the
          password), then continue.
        </span>
      </div>
    </div>
  );
}
