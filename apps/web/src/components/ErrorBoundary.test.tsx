// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ when }: { when: boolean }): null {
  if (when) throw new Error('<b>odd data</b> from the TV');
  return null;
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a friendly card with the message as text, and recovers when the route changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, getByText, getByRole, queryByText, rerender } = render(
      <ErrorBoundary resetKey="/files">
        <Boom when />
      </ErrorBoundary>,
    );
    expect(getByText('This page hit an error')).toBeTruthy();
    expect(getByText('<b>odd data</b> from the TV')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(getByRole('button', { name: 'Reload' })).toBeTruthy();

    rerender(
      <ErrorBoundary resetKey="/apps/installed">
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(queryByText('This page hit an error')).toBeNull();
  });
});
