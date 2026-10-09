import { describe, expect, it } from 'vitest';
import { webosName } from './webosVersion';

describe('webosName', () => {
  it('puts the marketing name in front from webOS 22 on', () => {
    expect(webosName('7.3.0')).toBe('22 (7.3.0)');
    expect(webosName('10.3.1')).toBe('25 (10.3.1)');
    expect(webosName('11.0.2')).toBe('26 (11.0.2)');
  });
  it('leaves older and unreadable versions as they are', () => {
    expect(webosName('6.3.2')).toBe('6.3.2');
    expect(webosName('4.9.0')).toBe('4.9.0');
    expect(webosName('dev')).toBe('dev');
    expect(webosName(undefined)).toBeUndefined();
  });
});
