import jpeg from 'jpeg-js';
import { GameError } from '../game/errors.js';

// Le navigateur redimensionne à 1280 px avant l'envoi ; on tolère un peu plus.
export const MAX_SIDE = 1600;

const invalid = () => new GameError('INVALID_IMAGE', 'Image illisible ou format non supporté.');

// Retire les métadonnées (EXIF avec la position GPS, XMP, commentaires…) sans recompresser l'image.
export function stripJpegMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw invalid();
  const parts = [buffer.subarray(0, 2)];
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) throw invalid();
    while (buffer[i + 1] === 0xff) i += 1; // octets de remplissage
    const marker = buffer[i + 1];
    if (marker === undefined) throw invalid();
    if (marker === 0xd9) {
      parts.push(buffer.subarray(i, i + 2));
      return Buffer.concat(parts);
    }
    if (marker === 0xda) {
      // Début des données de l'image : on garde tout le reste tel quel.
      parts.push(buffer.subarray(i));
      return Buffer.concat(parts);
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(buffer.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buffer.length) throw invalid();
    const end = i + 2 + buffer.readUInt16BE(i + 2);
    if (end > buffer.length) throw invalid();
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe; // APP1..APP15 + commentaires
    if (!isMetadata) parts.push(buffer.subarray(i, end));
    i = end;
  }
  throw invalid();
}

export function decodeJpeg(buffer) {
  try {
    const image = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 128 });
    if (image.width > MAX_SIDE || image.height > MAX_SIDE) {
      throw new GameError('IMAGE_TOO_BIG', `Image trop grande (${MAX_SIDE} px maximum par côté).`);
    }
    return image;
  } catch (error) {
    if (error instanceof GameError) throw error;
    throw invalid();
  }
}

// "dHash" : empreinte visuelle de 64 bits. Deux images qui se ressemblent (même photo
// recompressée, redimensionnée, légèrement retouchée) ont des empreintes très proches.
export function dHash({ width, height, data }) {
  const cols = 9;
  const rows = 8;
  const gray = new Float64Array(cols * rows);
  for (let gy = 0; gy < rows; gy += 1) {
    const y0 = Math.floor((gy * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / rows));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 16));
    for (let gx = 0; gx < cols; gx += 1) {
      const x0 = Math.floor((gx * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / cols));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 16));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const p = (y * width + x) * 4;
          sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
          count += 1;
        }
      }
      gray[gy * cols + gx] = sum / count;
    }
  }
  let hex = '';
  for (let row = 0; row < rows; row += 1) {
    let byte = 0;
    for (let x = 0; x < 8; x += 1) byte = (byte << 1) | (gray[row * cols + x] < gray[row * cols + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const popcount32 = (value) => {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

export const hashParts = (hex) => [Number.parseInt(hex.slice(0, 8), 16) >>> 0, Number.parseInt(hex.slice(8, 16), 16) >>> 0];
export const hammingParts = (a, b) => popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
// Nombre de bits différents entre deux empreintes (0 = identiques, 64 = opposées).
export const hamming = (a, b) => hammingParts(hashParts(a), hashParts(b));
