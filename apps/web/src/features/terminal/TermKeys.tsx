import { useMedia } from '../../lib/useMedia';
import { isPhoneOrTablet } from '../../shell/PhoneNotice';
import { terminals, type Tab } from './store';

/** Keys a phone's or tablet's keyboard doesn't have, with what they send to the shell. */
const KEYS: { label: string; title: string; send: string }[] = [
  { label: 'Esc', title: 'Escape', send: '\x1b' },
  { label: 'Tab', title: 'Tab (completes names)', send: '\t' },
  { label: '^C', title: 'Ctrl+C: stop the running command', send: '\x03' },
  { label: '^D', title: 'Ctrl+D: end input / log out', send: '\x04' },
  { label: '^Z', title: 'Ctrl+Z: pause the running command', send: '\x1a' },
  { label: '^L', title: 'Ctrl+L: clear the screen', send: '\x0c' },
  { label: '^R', title: 'Ctrl+R: search earlier commands', send: '\x12' },
  { label: '←', title: 'Left', send: '\x1b[D' },
  { label: '↑', title: 'Up: previous command', send: '\x1b[A' },
  { label: '↓', title: 'Down: next command', send: '\x1b[B' },
  { label: '→', title: 'Right', send: '\x1b[C' },
  { label: '|', title: 'Pipe', send: '|' },
  { label: '~', title: 'Tilde', send: '~' },
  { label: '/', title: 'Slash', send: '/' },
  { label: '-', title: 'Dash', send: '-' },
];

/**
 * On touch screens (a phone or tablet using a bridge on the network): a row of the keys their on-screen keyboards
 * lack. Pressing one doesn't take the focus from the terminal, so the keyboard stays up.
 */
export function TermKeys({ tab }: { tab: Tab }) {
  const touch = useMedia('(pointer: coarse)') || isPhoneOrTablet();
  if (!touch || !tab.pty || tab.state !== 'open') return null;
  return (
    <div className="term-keys" role="toolbar" aria-label="Extra keys">
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          className="term-key"
          title={k.title}
          aria-label={k.title}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            terminals.write(tab, k.send);
            tab.term?.focus();
          }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
