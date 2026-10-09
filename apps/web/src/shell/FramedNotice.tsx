import { Card } from '../components/Card';

/** Set by public/theme-init.js (before any app code) when the page is inside another page's frame. */
export const isFramed = () => document.documentElement.hasAttribute('data-framed');

/** What a framed copy shows instead of the app: it can't be clickjacked, and it never talks to the bridge. */
export function FramedNotice() {
  const href = window.location.href;
  return (
    <div className="standalone-notice">
      <Card eyebrow="LG Dev Manager" title="Open LG Dev Manager in its own tab">
        <div className="stack">
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            For your TVs’ safety, LG Dev Manager doesn’t run inside another website.
          </p>
          <div className="row">
            <a className="btn btn--primary" href={href} target="_top">
              Open LG Dev Manager
            </a>
          </div>
        </div>
      </Card>
    </div>
  );
}
