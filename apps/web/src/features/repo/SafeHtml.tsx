import { createElement, type ReactNode } from 'react';

/**
 * Renders an app's description (HTML from the Homebrew repository) without ever handing it to innerHTML: it is
 * parsed into an inert document and rebuilt as React elements from an allow-list. Scripts, styles, frames,
 * event handlers and non-http(s) links are dropped; unknown tags keep only their text. Relative links resolve
 * against `baseUrl`. Images are drawn by `renderImage` (the repository page loads them through the bridge);
 * without it they are left out. Headings are shifted down so they fit inside the details dialog.
 */
const KEEP: Record<string, string> = {
  p: 'p',
  br: 'br',
  hr: 'hr',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  code: 'code',
  pre: 'pre',
  blockquote: 'blockquote',
  h1: 'h3',
  h2: 'h4',
  h3: 'h5',
  h4: 'h6',
  h5: 'h6',
  h6: 'h6',
  table: 'table',
  thead: 'thead',
  tbody: 'tbody',
  tr: 'tr',
  th: 'th',
  td: 'td',
  a: 'a',
  img: 'img',
};
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base', 'head', 'title']);
const VOID = new Set(['br', 'hr', 'img']);
const MAX_NODES = 5000;

function safeUrl(href: string | null, protocols: string[], base?: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return protocols.includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

export type ImageRenderer = (src: string, alt: string, key: number) => ReactNode;

export function sanitizeToReact(html: string, opts: { baseUrl?: string; renderImage?: ImageRenderer } = {}): ReactNode[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let budget = MAX_NODES;
  let key = 0;

  const walk = (node: Node): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const child of Array.from(node.childNodes)) {
      if (--budget < 0) break;
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) out.push(child.textContent);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) continue;
      const as = KEEP[tag];
      if (!as) {
        out.push(...walk(el));
        continue;
      }
      if (as === 'img') {
        const src = safeUrl(el.getAttribute('src'), ['https:', 'http:'], opts.baseUrl);
        if (src && opts.renderImage) out.push(opts.renderImage(src, el.getAttribute('alt') ?? '', key++));
        continue;
      }
      if (VOID.has(as)) {
        out.push(createElement(as, { key: key++ }));
        continue;
      }
      const kids = walk(el);
      if (as === 'a') {
        const href = safeUrl(el.getAttribute('href'), ['https:', 'http:'], opts.baseUrl);
        out.push(href ? createElement('a', { key: key++, href, target: '_blank', rel: 'noopener noreferrer' }, ...kids) : createElement('span', { key: key++ }, ...kids));
        continue;
      }
      out.push(createElement(as, { key: key++ }, ...kids));
    }
    return out;
  };
  return walk(doc.body);
}

export function SafeHtml({ html, className, baseUrl, renderImage }: { html: string; className?: string; baseUrl?: string; renderImage?: ImageRenderer }) {
  return <div className={className}>{sanitizeToReact(html, { baseUrl, renderImage })}</div>;
}
