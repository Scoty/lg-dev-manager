import { useState } from 'react';
import { Alert } from '../components/Alert';
import { servedByLanBridge } from '../bridge/settings';

/** A phone or tablet: the browser says so (userAgentData), the user agent does, or it's an iPad posing as a Mac. */
export function isPhoneOrTablet(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { userAgentData?: { mobile?: boolean } } = navigator): boolean {
  if (nav.userAgentData?.mobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini/i.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1;
}

const KEY = 'lgdm-phone-notice-dismissed';

/**
 * Shown on phones and tablets that open lg.scoty.uk or a local page: the app needs a bridge, and a phone can't run
 * one. Not on a page a bridge on the network serves (the Docker image, 2.0) — that's how phones use the app. Can be
 * hidden for this browser session.
 */
export function PhoneNotice({ always = false }: { always?: boolean }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!isPhoneOrTablet() || servedByLanBridge() || (hidden && !always)) return null;
  const hide = () => {
    setHidden(true);
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className="phone-notice">
      <Alert
        kind="warning"
        title="Use a computer for this"
        action={
          always ? undefined : (
            <button type="button" className="btn btn--sm btn--ghost" onClick={hide}>
              Got it
            </button>
          )
        }
      >
        LG Dev Manager talks to your TV through the bridge, a small program that runs on a computer. Phones and tablets
        can’t run it, and workarounds such as a terminal app on the phone are risky: the bridge holds your TV’s keys and
        passwords and can do anything on the TV, including as root. Open this page on a desktop or laptop — or run the
        bridge on a home server with Docker and open the page it serves, which works on phones too.
      </Alert>
    </div>
  );
}
