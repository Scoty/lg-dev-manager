import type { DeviceAuth, DeviceTarget, ResultOf } from '@lgdm/protocol';
import type { useRpc } from '../../bridge/useRpc';
import { toDeviceAuth, type AuthDraft } from './auth';

export type VerifyStepId = 'key' | 'login' | 'info';
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface VerifyState {
  steps: Record<VerifyStepId, StepState>;
  error?: unknown;
  failedAt?: VerifyStepId;
  auth?: DeviceAuth;
  login?: ResultOf<'device.test'>;
  info?: ResultOf<'device.info'>;
}

export const STEP_LABELS: Record<VerifyStepId, string> = {
  key: 'Fetch the Dev Mode key from the TV',
  login: 'Log in over SSH',
  info: 'Read model and webOS version',
};

type Call = ReturnType<typeof useRpc>['call'];

/**
 * The wizard's last step (AddDeviceComponent.submit → DeviceEditorComponent.submit in the original):
 * fetch the key if needed, log in, read device info. Reports each step through `update`.
 */
export async function verifyDevice(
  call: Call,
  input: { host: string; port: number; username: string; auth: AuthDraft; currentAuth?: DeviceAuth },
  update: (s: VerifyState) => void,
): Promise<VerifyState> {
  const s: VerifyState = { steps: { key: 'pending', login: 'pending', info: 'pending' } };
  const emit = () => update({ ...s, steps: { ...s.steps } });
  const run = async <T>(id: VerifyStepId, fn: () => Promise<T>): Promise<T> => {
    s.steps[id] = 'running';
    emit();
    try {
      const r = await fn();
      s.steps[id] = 'done';
      emit();
      return r;
    } catch (e) {
      s.steps[id] = 'failed';
      s.error = e;
      s.failedAt = id;
      emit();
      throw e;
    }
  };

  try {
    if (input.auth.kind === 'devkey') {
      const pp = input.auth.passphrase;
      const { privateKey } = await run('key', () => call('device.fetchKey', { host: input.host, passphrase: pp }, 30_000));
      s.auth = { kind: 'key', privateKey, passphrase: pp };
    } else {
      s.steps.key = 'skipped';
      s.auth = input.auth.kind === 'keep' ? input.currentAuth : (toDeviceAuth(input.auth) ?? undefined);
      emit();
    }
    const device: DeviceTarget = { host: input.host, port: input.port, username: input.username, auth: s.auth! };
    s.login = await run('login', () => call('device.test', { device }, 40_000));
    s.info = await run('info', () => call('device.info', { device }, 40_000));
  } catch {
    /* recorded in s */
  }
  emit();
  return s;
}
