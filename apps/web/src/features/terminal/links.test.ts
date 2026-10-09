import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTerminalLink, safeLinkUrl } from './links';

describe('terminal links', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows only http(s) URLs', () => {
    expect(safeLinkUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
    expect(safeLinkUrl('http://192.0.2.10:3000/')).toBe('http://192.0.2.10:3000/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd', 'blob:https://lg.scoty.uk/x', 'vbscript:x', 'not a url', '']) {
      expect(safeLinkUrl(bad)).toBeNull();
    }
  });

  it('opens allowed links without opener or referrer, and ignores the rest', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    openTerminalLink('javascript:alert(1)');
    expect(open).not.toHaveBeenCalled();
    openTerminalLink('https://example.com/');
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  });
});
