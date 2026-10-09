// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SafeHtml } from './SafeHtml';

const html = (s: string) => render(<SafeHtml html={s} />).container.innerHTML;

describe('SafeHtml', () => {
  it('keeps simple formatting and safe links', () => {
    expect(html('<h2>About</h2><p>A <b>bold</b> <a href="https://example.com/x">link</a></p>')).toBe(
      '<div><h4>About</h4><p>A <strong>bold</strong> <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">link</a></p></div>',
    );
  });

  it('drops scripts, handlers, styles and dangerous URLs', () => {
    const out = html(
      '<script>alert(1)</script><style>p{}</style><p onclick="x()" style="color:red">hi</p>' +
        '<a href="javascript:alert(1)">bad</a><img src="x" onerror="alert(1)"><img src="http://example.com/a.png">' +
        '<iframe src="https://evil.example"></iframe><div class="x"><span>text</span></div>',
    );
    expect(out).toBe('<div><p>hi</p><span>bad</span>text</div>');
  });

  it('hands images to the renderer, resolving relative URLs, and leaves them out without one', () => {
    const seen: string[] = [];
    const out = render(
      <SafeHtml
        html={'<img src="shot.png" alt="A"><img src="javascript:x"><a href="../more">more</a>'}
        baseUrl="https://repo.example/api/apps/x/full_description.html"
        renderImage={(src, alt, key) => {
          seen.push(`${src}|${alt}`);
          return <i key={key}>{alt}</i>;
        }}
      />,
    ).container.innerHTML;
    expect(seen).toEqual(['https://repo.example/api/apps/x/shot.png|A']);
    expect(out).toBe('<div><i>A</i><a href="https://repo.example/api/apps/more" target="_blank" rel="noopener noreferrer">more</a></div>');
    expect(html('<p>a<img src="https://example.com/a.png">b</p>')).toBe('<div><p>ab</p></div>');
  });

  it('treats tag names that are Object.prototype keys as unknown tags', () => {
    // Used to look up KEEP["constructor"] → Object, rendered as a component, and crash the page.
    // (Tag names are lower-cased, so "constructor" is the one that matters.)
    expect(html('<constructor>a</constructor><p><constructor>b</constructor></p><toString>c</toString>')).toBe('<div>a<p>b</p>c</div>');
  });
});
