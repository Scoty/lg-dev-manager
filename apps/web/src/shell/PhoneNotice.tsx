import { useState } from 'react';
import { Alert } from '../components/Alert';

/** A phone or tablet: the browser says so (userAgentData), the user agent does, or it's an iPad posing as a Mac. */
export function isPhoneOrTablet(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { userAgentData?: { mobile?: boolean } } = navigator): boolean {
  if (nav.userAgentData?.mobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini/i.test(nav.userAgent)) return true;
  return /Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1;
}

const KEY = 'lgdm-phone-notice-dismissed';

/**
 * Shown on phones and tablets: the app needs the bridge on the same computer, and the ways around that (a terminal app
 * on the phone, or a bridge opened up to the network) are risky. Can be hidden for this browser session.
 */
export function PhoneNotice({ always = false }: { always?: boolean }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!isPhoneOrTablet() || (hidden && !always)) return null;
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
        LG Dev Manager talks to your TV through the bridge, a small program that has to run on the same computer as this
        browser. Phones and tablets can’t run it, and the workarounds — running it in a terminal app on the phone, or
        opening a bridge to your Wi-Fi — are risky: the bridge holds your TV’s keys and passwords and can do anything on
        the TV, including as root. Please open this page on a desktop or laptop instead.
      </Alert>
    </div>
  );
}
