import { describe, expect, it } from 'vitest';
import { imageType, looksLikeText } from './paths';

describe('file previews by name', () => {
  it('previews raster images', () => {
    expect(imageType('shot.png')).toBe('image/png');
    expect(imageType('Photo.JPG')).toBe('image/jpeg');
    expect(imageType('icon.ico')).toBe('image/x-icon');
  });

  it('never previews SVG as an image (it would be a same-origin document); it is text instead', () => {
    expect(imageType('logo.svg')).toBeUndefined();
    expect(imageType('logo.SVG')).toBeUndefined();
    expect(looksLikeText('logo.svg')).toBe(true);
  });

  it('ignores names that are Object.prototype keys or have no extension', () => {
    for (const name of ['x.constructor', 'x.__proto__', 'x.toString', 'x.hasOwnProperty', 'constructor', 'png']) {
      expect(imageType(name)).toBeUndefined();
    }
  });
});
