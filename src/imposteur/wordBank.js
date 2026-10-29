import { readFileSync, statSync } from 'node:fs';
import { randomInt } from 'node:crypto';

// Paires de mots de L'Imposteur (data/imposteur.json), relues automatiquement si le fichier change.
function parsePairs(raw) {
  const data = JSON.parse(raw);
  const groups = Array.isArray(data?.pairs) ? { Divers: data.pairs } : data?.categories;
  if (!groups || typeof groups !== 'object') throw new Error('Le fichier doit contenir "categories".');
  const pairs = [];
  const seen = new Set();
  for (const list of Object.values(groups)) {
    if (!Array.isArray(list)) continue;
    for (const pair of list) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [a, b] = pair.map((w) => (typeof w === 'string' ? w.trim() : ''));
      if (!a || !b || a.toLowerCase() === b.toLowerCase()) continue;
      const key = [a, b].map((w) => w.toLowerCase()).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ key, words: [a, b] });
    }
  }
  if (pairs.length === 0) throw new Error('Aucune paire de mots valide.');
  return pairs;
}

export function createWordBank(pairs) {
  let list = pairs.map((words) => ({ key: words.map((w) => w.toLowerCase()).sort().join('|'), words }));
  return {
    get size() {
      return list.length;
    },
    replace(next) {
      list = next;
    },
    // Tire une paire pas encore jouée dans ce lobby ; l'un des deux mots (au hasard) va aux civils.
    pick(used = new Set()) {
      let pool = list.filter((p) => !used.has(p.key));
      if (pool.length === 0) {
        used.clear();
        pool = list;
      }
      const pair = pool[randomInt(pool.length)];
      used.add(pair.key);
      const flip = randomInt(2) === 1;
      return { civil: pair.words[flip ? 1 : 0], impostor: pair.words[flip ? 0 : 1] };
    },
  };
}

export function loadWordBank(fileUrl) {
  let mtime = statSync(fileUrl).mtimeMs;
  const bank = createWordBank([]);
  bank.replace(parsePairs(readFileSync(fileUrl, 'utf8')));
  const basePick = bank.pick;
  bank.pick = (used) => {
    try {
      const current = statSync(fileUrl).mtimeMs;
      if (current !== mtime) {
        bank.replace(parsePairs(readFileSync(fileUrl, 'utf8')));
        mtime = current;
        console.log(`[imposteur] Mots rechargés (${bank.size} paires).`);
      }
    } catch (error) {
      console.warn('[imposteur] Rechargement impossible, on garde la version précédente :', error.message);
    }
    return basePick(used);
  };
  return bank;
}
