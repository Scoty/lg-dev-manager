import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const rpc = vi.hoisted(() => ({ ready: false }));
vi.mock('../../bridge/useRpc', () => ({ useRpc: () => ({ ready: rpc.ready, call: vi.fn(), client: null }) }));
vi.mock('../../components/Feedback', () => ({ useFeedback: () => ({ toast: vi.fn(), confirm: vi.fn() }) }));

const { AuthFields } = await import('./AuthFields');

const show = () =>
  render(
    <AuthFields value={{ kind: 'generated', privateKey: '', publicKey: '' } as never} onChange={() => {}} kinds={['generated']} username="root" showErrors={false} />,
  );

describe('AuthFields: a new key made for this TV', () => {
  afterEach(cleanup);

  it('says why "Make a new key" is off while the bridge isn’t connected', () => {
    rpc.ready = false;
    show();
    const button = screen.getByRole('button', { name: /Make a new key/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('genkey-offline');
    expect(screen.getByText(/The bridge isn’t connected, and it’s what makes the key/)).toBeTruthy();
  });

  it('is on, without the note, once the bridge is connected', () => {
    rpc.ready = true;
    show();
    expect((screen.getByRole('button', { name: /Make a new key/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/The bridge isn’t connected/)).toBeNull();
  });
});
