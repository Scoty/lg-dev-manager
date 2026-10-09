import { describe, expect, it } from 'vitest';
import { isPhoneOrTablet } from './PhoneNotice';

const nav = (userAgent: string, maxTouchPoints = 0, mobile?: boolean) => ({ userAgent, maxTouchPoints, ...(mobile !== undefined ? { userAgentData: { mobile } } : {}) });

describe('isPhoneOrTablet', () => {
  it('spots phones and tablets', () => {
    expect(isPhoneOrTablet(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'))).toBe(true);
    expect(isPhoneOrTablet(nav('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36'))).toBe(true);
    expect(isPhoneOrTablet(nav('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'))).toBe(true);
    // iPadOS asks for desktop sites and says "Macintosh", but has a touch screen.
    expect(isPhoneOrTablet(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5))).toBe(true);
    expect(isPhoneOrTablet(nav('anything', 0, true))).toBe(true);
  });

  it('leaves computers alone', () => {
    expect(isPhoneOrTablet(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0))).toBe(false);
    expect(isPhoneOrTablet(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36', 10, false))).toBe(false);
    expect(isPhoneOrTablet(nav('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'))).toBe(false);
  });
});
