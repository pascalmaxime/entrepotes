import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameError } from '../src/game/errors.js';
import { hamming } from '../src/memes/jpeg.js';
import { gradient, makeJpeg, tempLibrary, waves } from './helpers.js';

test('ajout d’une image puis du même fichier : stocké une seule fois', async () => {
  const library = tempLibrary();
  const image = makeJpeg(200, 150, gradient());
  const first = await library.add(image, { uploadedBy: 'Alice' });
  assert.equal(first.duplicate, null);
  assert.equal(first.entry.uploadedBy, 'Alice');
  assert.ok(existsSync(join(library.imagesDir, `${first.entry.id}.jpg`)));

  const again = await library.add(image, { uploadedBy: 'Bob' });
  assert.equal(again.duplicate, 'exact');
  assert.equal(library.count, 1);
});

test('la même image recompressée est reconnue comme doublon', async () => {
  const library = tempLibrary();
  await library.add(makeJpeg(200, 150, gradient(), 92));
  const result = await library.add(makeJpeg(200, 150, gradient(3), 70));
  assert.equal(result.duplicate, 'similar');
  assert.equal(library.count, 1);
});

test('images différentes : stockées toutes les deux, la plus grande est proposée « à garder »', async () => {
  const library = tempLibrary();
  const small = await library.add(makeJpeg(200, 150, gradient()));
  const big = await library.add(makeJpeg(300, 200, waves));
  assert.equal(big.duplicate, null);
  assert.equal(library.count, 2);
  assert.ok(hamming(small.entry.dhash, big.entry.dhash) > 8);
  assert.equal(library.similarGroups(8).length, 0);

  const [group] = library.similarGroups(64); // seuil maximal : tout se ressemble
  assert.equal(group.images.length, 2);
  assert.equal(group.keepId, big.entry.id);
});

test('les métadonnées (ex. position GPS) sont retirées de l’image stockée', async () => {
  const library = tempLibrary();
  const image = makeJpeg(120, 90, waves);
  const payload = Buffer.from('Exif\0\0GPS-SECRET-45.43N');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  const withExif = Buffer.concat([image.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, payload, image.subarray(2)]);
  assert.ok(withExif.includes('GPS-SECRET'));

  const { entry } = await library.add(withExif);
  const stored = readFileSync(join(library.imagesDir, `${entry.id}.jpg`));
  assert.ok(!stored.includes('GPS-SECRET'));
});

test('un fichier qui n’est pas un JPEG est refusé', async () => {
  const library = tempLibrary();
  await assert.rejects(library.add(Buffer.from('<svg onload="alert(1)"></svg>')), (e) => e instanceof GameError && e.code === 'INVALID_IMAGE');
  await assert.rejects(library.add(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), (e) => e instanceof GameError);
  assert.equal(library.count, 0);
});

test('suppression, puis rechargement depuis le disque', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memes-'));
  const library = tempLibrary(dir);
  const a = await library.add(makeJpeg(200, 150, gradient()));
  const b = await library.add(makeJpeg(200, 150, waves));
  assert.equal(await library.remove(a.entry.id), true);
  assert.equal(await library.remove('inconnu'), false);
  assert.ok(!existsSync(join(library.imagesDir, `${a.entry.id}.jpg`)));

  const reloaded = tempLibrary(dir);
  assert.equal(reloaded.count, 1);
  assert.ok(reloaded.has(b.entry.id));
});
