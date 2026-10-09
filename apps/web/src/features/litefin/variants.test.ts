import { describe, expect, it } from 'vitest';
import { compareVersions, suggestedVariant, variantColumns, variantInfo } from './variants';

describe('Litefin variants', () => {
  it('orders columns like the release notes, unknown ones last', () => {
    const r = (variants: string[]) => ({ tag: 't', version: '1', title: 't', publishedAt: '', assets: variants.map((variant) => ({ variant, name: '', size: 0 })) });
    expect(variantColumns([r(['Normal', 'Ultra-Legacy-NoService', 'Zeta']), r(['Modern', 'Legacy', 'Ultra-Legacy', 'Alpha'])])).toEqual([
      'Modern',
      'Normal',
      'Legacy',
      'Ultra-Legacy',
      'Ultra-Legacy-NoService',
      'Alpha',
      'Zeta',
    ]);
    expect(variantInfo('Normal-Oblong').label).toBe('Normal Oblong');
  });

  it('suggests a build from the TV’s webOS version', () => {
    expect(suggestedVariant('8.0.0')).toBe('Modern'); // webOS 23
    expect(suggestedVariant('7.3.1')).toBe('Modern'); // webOS 22
    expect(suggestedVariant('6.4.0')).toBe('Normal');
    expect(suggestedVariant('5.2.0')).toBe('Normal');
    expect(suggestedVariant('4.9.7')).toBe('Legacy');
    expect(suggestedVariant('3.4.0')).toBe('Ultra-Legacy');
    expect(suggestedVariant(undefined)).toBeNull();
    expect(suggestedVariant('unknown')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.9', '1.9.0')).toBe(0);
    expect(compareVersions('0.45.1', '1.0.0')).toBeLessThan(0);
  });
});
