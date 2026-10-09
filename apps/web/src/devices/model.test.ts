import { describe, expect, it } from 'vitest';
import { modelLabel, modelLine, modelSeries } from './model';

describe('LG model names', () => {
  it.each([
    ['OLED55C46LA', 'C4'],
    ['OLED65C4PUA', 'C4'],
    ['OLED77G45LW', 'G4'],
    ['OLED65CXPUA', 'CX'],
    ['OLED55B9PLA.AEU', 'B9'],
    ['OLED97M49LA', 'M4'],
    ['65QNED86T6A', 'QNED86'],
    ['55NANO816PA', 'NANO81'],
    ['43UT80006LA', 'UT80'],
    ['55UQ80006LB', 'UQ80'],
    ['49SK8500PLA', 'SK85'],
    ['27ART10AKPL', 'StanbyME'],
  ])('%s is the %s', (model, series) => {
    expect(modelSeries(model)).toBe(series);
  });

  it('falls back to the raw model', () => {
    expect(modelSeries('WEBOS_EMULATOR')).toBeUndefined();
    expect(modelLabel('WEBOS_EMULATOR')).toBe('WEBOS_EMULATOR');
    expect(modelLine('WEBOS_EMULATOR')).toBe('WEBOS_EMULATOR');
    expect(modelLine(undefined)).toBeUndefined();
    expect(modelLabel('  ')).toBeUndefined();
  });

  it('formats the label and line', () => {
    expect(modelLabel('OLED55C46LA')).toBe('LG C4');
    expect(modelLine('OLED55C46LA')).toBe('LG C4 · OLED55C46LA');
  });
});
