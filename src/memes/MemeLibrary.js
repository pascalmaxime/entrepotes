import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { GameError } from '../game/errors.js';
import { decodeJpeg, dHash, hammingParts, hashParts, stripJpegMetadata } from './jpeg.js';

// En dessous de cet écart (sur 64 bits), deux images sont considérées comme la même :
// la nouvelle n'est pas stockée. Au-delà, c'est l'admin qui trie.
export const AUTO_DEDUPE_DISTANCE = 3;

const FILE_PATTERN = /^[a-f0-9]{24}\.jpg$/;
const publicEntry = ({ parts, ...entry }) => ({ ...entry, url: `/memes/${entry.id}.jpg` });

/**
 * Bibliothèque d'images Top Meme, stockée sur le disque :
 *   <dir>/images/<id>.jpg   les images (id = empreinte SHA-256 du fichier)
 *   <dir>/index.json        les infos (taille, auteur, date, empreinte visuelle)
 */
export class MemeLibrary {
  constructor({ dir, maxImages = 2000 }) {
    this.dir = dir;
    this.imagesDir = join(dir, 'images');
    this.indexFile = join(dir, 'index.json');
    this.maxImages = maxImages;
    this.images = new Map();
    this.writing = Promise.resolve();
    this.load();
  }

  get count() {
    return this.images.size;
  }

  has(id) {
    return this.images.has(id);
  }

  load() {
    mkdirSync(this.imagesDir, { recursive: true });
    let entries = [];
    if (existsSync(this.indexFile)) {
      try {
        entries = JSON.parse(readFileSync(this.indexFile, 'utf8')).images ?? [];
      } catch (error) {
        console.warn('[memes] index.json illisible, reconstruction depuis les fichiers :', error.message);
      }
    }
    const files = new Set(readdirSync(this.imagesDir).filter((name) => FILE_PATTERN.test(name)));
    for (const entry of entries) {
      const name = `${entry.id}.jpg`;
      if (!files.has(name)) continue; // image supprimée à la main
      this.images.set(entry.id, { ...entry, parts: hashParts(entry.dhash) });
      files.delete(name);
    }
    // Images présentes sur le disque mais absentes de l'index (copie manuelle, index perdu…).
    for (const name of files) {
      try {
        const path = join(this.imagesDir, name);
        const buffer = readFileSync(path);
        const id = name.slice(0, -4);
        const meta = { uploadedBy: 'inconnu', uploadedAt: statSync(path).mtime.toISOString() };
        this.images.set(id, this.makeEntry(id, buffer, decodeJpeg(buffer), meta));
      } catch {
        console.warn(`[memes] ${name} ignoré (image illisible).`);
      }
    }
    if (this.images.size !== entries.length) this.saveSync();
    console.log(`[memes] Bibliothèque chargée : ${this.count} image(s) dans ${this.dir}`);
  }

  makeEntry(id, buffer, image, { uploadedBy, uploadedAt }) {
    const dhash = dHash(image);
    return { id, width: image.width, height: image.height, bytes: buffer.length, dhash, uploadedBy, uploadedAt, parts: hashParts(dhash) };
  }

  serialize() {
    const images = [...this.images.values()].map(({ parts, ...entry }) => entry);
    return JSON.stringify({ version: 1, images }, null, 2);
  }

  saveSync() {
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, this.serialize());
    renameSync(tmp, this.indexFile);
  }

  // Écritures en file d'attente : deux envois simultanés ne peuvent pas abîmer l'index.
  save() {
    this.writing = this.writing
      .then(async () => {
        const tmp = `${this.indexFile}.tmp`;
        await writeFile(tmp, this.serialize());
        await rename(tmp, this.indexFile);
      })
      .catch((error) => console.error('[memes] Sauvegarde de l’index impossible :', error));
    return this.writing;
  }

  /** Renvoie { entry, duplicate } avec duplicate = null | 'exact' | 'similar'. */
  async add(raw, { uploadedBy = 'inconnu' } = {}) {
    const buffer = stripJpegMetadata(raw);
    const image = decodeJpeg(buffer);
    const id = createHash('sha256').update(buffer).digest('hex').slice(0, 24);

    const existing = this.images.get(id);
    if (existing) return { entry: publicEntry(existing), duplicate: 'exact' };

    const entry = this.makeEntry(id, buffer, image, { uploadedBy, uploadedAt: new Date().toISOString() });
    const nearest = this.nearest(entry.parts);
    if (nearest && nearest.distance <= AUTO_DEDUPE_DISTANCE) return { entry: publicEntry(nearest.entry), duplicate: 'similar' };

    if (this.count >= this.maxImages) {
      throw new GameError('LIBRARY_FULL', 'La bibliothèque est pleine : demande à l’admin de faire du tri.');
    }
    await writeFile(join(this.imagesDir, `${id}.jpg`), buffer);
    this.images.set(id, entry);
    await this.save();
    return { entry: publicEntry(entry), duplicate: null };
  }

  nearest(parts) {
    let best = null;
    for (const entry of this.images.values()) {
      const distance = hammingParts(parts, entry.parts);
      if (!best || distance < best.distance) best = { entry, distance };
    }
    return best;
  }

  async remove(id) {
    if (!this.images.has(id)) return false;
    this.images.delete(id);
    await unlink(join(this.imagesDir, `${id}.jpg`)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await this.save();
    return true;
  }

  randomId(exclude = new Set()) {
    const pool = [...this.images.keys()].filter((id) => !exclude.has(id));
    return pool.length ? pool[randomInt(pool.length)] : null;
  }

  list() {
    return [...this.images.values()].map(publicEntry).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  stats() {
    let bytes = 0;
    for (const entry of this.images.values()) bytes += entry.bytes;
    return { count: this.count, bytes, maxImages: this.maxImages };
  }

  // Regroupe les images qui se ressemblent (écart ≤ threshold). Dans chaque groupe,
  // la première est celle à garder : la meilleure résolution, puis le fichier le plus lourd.
  similarGroups(threshold = 8) {
    const entries = [...this.images.values()];
    const parent = entries.map((_, index) => index);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        if (hammingParts(entries[i].parts, entries[j].parts) <= threshold) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    entries.forEach((entry, index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(entry);
    });
    return [...groups.values()]
      .filter((group) => group.length > 1)
      .map((group) => {
        const sorted = group.sort((a, b) => b.width * b.height - a.width * a.height || b.bytes - a.bytes);
        return {
          keepId: sorted[0].id,
          images: sorted.map((entry) => ({ ...publicEntry(entry), distance: hammingParts(sorted[0].parts, entry.parts) })),
        };
      })
      .sort((a, b) => b.images.length - a.images.length);
  }
}
