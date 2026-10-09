import { describe, expect, it } from 'vitest';
import { distinctModel } from './TvName';

const tv = (name: string, modelName?: string) => ({ name, info: modelName ? { modelName, from: 'x', at: 0 } : undefined });

describe('distinctModel', () => {
  it('shows the model unless the TV is named after it', () => {
    expect(distinctModel(tv('Living Room', 'OLED55C46LA'))).toBe('LG C4');
    expect(distinctModel(tv('LG C4', 'OLED55C46LA'))).toBeUndefined();
    expect(distinctModel(tv('lg c4 ', 'OLED55C46LA'))).toBeUndefined();
    expect(distinctModel(tv('Bedroom'))).toBeUndefined();
  });
});
