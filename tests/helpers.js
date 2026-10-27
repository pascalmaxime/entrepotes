import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { MemeLibrary } from '../src/memes/MemeLibrary.js';

// Fabrique une image JPEG de test à partir d'une fonction (x, y) → [r, g, b].
export function makeJpeg(width, height, pixel, quality = 90) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, quality).data;
}

export const gradient = (shift = 0) => (x, y) => [Math.min(255, x + shift), Math.min(255, y + shift), 128];

export const waves = (x, y) => {
  const v = Math.round(127 + 127 * Math.sin(x / 7) * Math.cos(y / 11));
  return [v, 255 - v, v];
};

// Bibliothèque dans un dossier temporaire (jamais dans data/memes du projet).
export const tempLibrary = (dir = mkdtempSync(join(tmpdir(), 'memes-'))) => new MemeLibrary({ dir });
