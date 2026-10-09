import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Card } from './Card';
import { Alert } from './Alert';

interface Props {
  children: ReactNode;
  /** When this changes (e.g. the route), a crashed page gets another try. */
  resetKey?: unknown;
  /** Outside the shell (main.tsx): centre the card on an otherwise empty page. */
  fullPage?: boolean;
}

interface State {
  error: Error | null;
  key: unknown;
}

/**
 * Catches a page that throws while rendering, so one bad response (e.g. odd data from a TV or the repository)
 * doesn't blank the whole app. Inside the Layout the sidebar and top bar keep working around it.
 * The message is shown as text — never as HTML.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { error: null, key: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Page error', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const card = (
      <Card eyebrow="Something went wrong" title="This page hit an error" className="col-12 page-error">
        <div className="stack">
          <Alert kind="danger" title="Error">
            <span className="mono">{error.message.slice(0, 500) || error.name}</span>
          </Alert>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Your saved TVs are safe. Reload the page to try again, or pick another page from the menu.
          </p>
          <div className="row">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </Card>
    );
    return this.props.fullPage ? <div className="standalone-notice">{card}</div> : <div className="grid">{card}</div>;
  }
}
