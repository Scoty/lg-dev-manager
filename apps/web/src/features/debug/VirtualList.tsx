import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../shell/icons';

/** First index whose key is >= `key` (items are sorted by increasing key). */
function lowerBound<T>(items: readonly T[], keyOf: (item: T) => number, key: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyOf(items[mid]!) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A fixed-row-height scrolling list that only renders the rows in view, so a log with 10 000 lines stays fast.
 * "Following" keeps it pinned to the newest row; scrolling up stops that, keeps the rows being read in place while
 * old ones are dropped or the filter changes, and offers a button to jump back to the latest.
 *
 * `keyOf` must return a number that increases with each newer item (a sequence number).
 */
export function VirtualList<T>({
  items,
  rowHeight,
  render,
  keyOf,
  label,
  className = '',
  header,
  empty,
}: {
  items: readonly T[];
  rowHeight: number;
  render: (item: T, index: number) => ReactNode;
  keyOf: (item: T) => number;
  label: string;
  className?: string;
  header?: ReactNode;
  empty?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [follow, setFollow] = useState(true);
  /** Key of the newest item when following stopped: anything newer is "new". */
  const [seenUpTo, setSeenUpTo] = useState<number | null>(null);
  const prev = useRef(items);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const toBottom = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, []);

  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = items;
    const el = box.current;
    if (!el || before === items) return;
    if (follow) {
      toBottom();
      return;
    }
    // Keep the row at the top of the view where it is, though rows before it came or went.
    const topIndex = Math.min(before.length - 1, Math.floor(el.scrollTop / rowHeight));
    const anchor = before[topIndex];
    if (anchor === undefined) return;
    const offset = el.scrollTop - topIndex * rowHeight;
    const now = lowerBound(items, keyOf, keyOf(anchor));
    if (now !== topIndex) {
      el.scrollTop = now * rowHeight + offset;
      setScrollTop(el.scrollTop);
    }
  }, [items, follow, toBottom, rowHeight, keyOf]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight * 1.5;
    if (atBottom !== follow) {
      setFollow(atBottom);
      const last = items[items.length - 1];
      setSeenUpTo(atBottom || last === undefined ? null : keyOf(last));
    }
  };

  const unseen = !follow && seenUpTo !== null ? items.length - lowerBound(items, keyOf, seenUpTo + 1) : 0;
  const total = items.length * rowHeight;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 10);
  const last = Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + 10);
  const slice = items.slice(first, last);

  return (
    <div className={`vlist ${className}`}>
      {header}
      <div className="vlist-scroll" ref={box} onScroll={onScroll} role="log" aria-label={label} aria-live="off" tabIndex={0}>
        {items.length === 0 ? (
          empty
        ) : (
          <div style={{ height: total, position: 'relative' }}>
            <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>
              {slice.map((item, i) => (
                <div key={keyOf(item)} className="vlist-row" style={{ height: rowHeight }}>
                  {render(item, first + i)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {!follow && items.length > 0 && (
        <button
          type="button"
          className="btn btn--sm btn--primary vlist-jump"
          onClick={() => {
            setFollow(true);
            setSeenUpTo(null);
            toBottom();
          }}
        >
          <Icon name="updown" /> {unseen > 0 ? `${unseen.toLocaleString()} new — jump to latest` : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}
