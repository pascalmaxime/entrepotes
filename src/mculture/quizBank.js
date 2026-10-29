import { readFileSync, statSync } from 'node:fs';
import { randomInt } from 'node:crypto';

// Les catégories de M-Culture. Chaque fichier de data/mculture/ est relu automatiquement
// s'il est modifié (pris en compte à la partie suivante, sans redémarrer le serveur).
export const CATEGORIES = Object.freeze([
  { id: 'culture', label: 'Culture G', emoji: '🧠', file: 'culture.json' },
  { id: 'drapeaux', label: 'Drapeaux', emoji: '🚩', file: 'drapeaux.json' },
  { id: 'carte', label: 'Carte', emoji: '🗺️', file: 'carte.json' },
  { id: 'rebus', label: 'Rébus', emoji: '🧩', file: 'rebus.json' },
  { id: 'musique', label: 'Musique', emoji: '🎵', file: 'musique.json' },
  { id: 'petit-bac', label: 'Petit bac', emoji: '✏️', file: 'petit-bac.json' },
]);
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

const pts = (value) => (Number.isInteger(value) && value >= 1 && value <= 3 ? value : 1);
const str = (value) => (typeof value === 'string' ? value.trim() : '');
const alts = (value) => (Array.isArray(value) ? value.map(str).filter(Boolean) : []);

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Transforme le contenu d'un fichier en questions au format commun :
// { key, cat, prompt, answer, alt, pts, + champs propres (flag, mapId, emoji, hint, song, letter) }
const PARSERS = {
  culture: (data) =>
    data.questions
      .filter((q) => str(q?.q) && str(q?.a))
      .map((q) => ({ key: `culture:${str(q.q)}`, prompt: str(q.q), answer: str(q.a), alt: alts(q.alt), pts: pts(q.pts) })),
  drapeaux: (data) =>
    data.questions
      .filter((q) => /^[a-z]{2}$/.test(q?.code) && str(q?.a))
      .map((q) => ({ key: `drapeaux:${q.code}`, prompt: 'De quel pays est ce drapeau ?', flag: q.code, answer: str(q.a), alt: alts(q.alt), pts: pts(q.pts) })),
  carte: (data) =>
    data.questions
      .filter((q) => /^\d{3}$/.test(q?.id) && str(q?.a))
      .map((q) => ({ key: `carte:${q.id}`, prompt: 'Quel est ce pays ?', mapId: q.id, answer: str(q.a), alt: alts(q.alt), pts: pts(q.pts) })),
  rebus: (data) =>
    data.questions
      .filter((q) => str(q?.emoji) && str(q?.a))
      .map((q) => ({ key: `rebus:${str(q.emoji)}`, prompt: 'Trouve le rébus', emoji: str(q.emoji), hint: str(q.hint), answer: str(q.a), alt: alts(q.alt), pts: pts(q.pts) })),
  musique: (data) =>
    data.questions
      .filter((q) => str(q?.title) && str(q?.a))
      .map((q) => ({
        key: `musique:${str(q.title)}`,
        prompt: 'Qui chante ce titre ?',
        song: { title: str(q.title), year: Number.isInteger(q.year) ? q.year : null },
        answer: str(q.a),
        alt: alts(q.alt),
        pts: pts(q.pts),
      })),
  // Petit bac : on garde catégories + lettres, la question est tirée au moment de la partie.
  'petit-bac': (data) => {
    const letters = [...new Set(str(data.letters).toUpperCase().replace(/[^A-Z]/g, ''))];
    const categories = alts(data.categories);
    if (!letters.length || !categories.length) return [];
    return [{ generator: true, letters, categories, pts: pts(data.pts) }];
  },
};

function parseFile(category, raw) {
  const data = JSON.parse(raw);
  if (category.id !== 'petit-bac' && !Array.isArray(data?.questions)) {
    throw new Error(`${category.file} doit contenir un tableau "questions".`);
  }
  const list = PARSERS[category.id](data).map((q) => ({ cat: category.id, ...q }));
  return list;
}

export function createQuizBank(byCategory) {
  const data = new Map(Object.entries(byCategory));

  const petitBacQuestions = (gen) =>
    gen.categories.flatMap((category) =>
      gen.letters.map((letter) => ({
        key: `petit-bac:${category}:${letter}`,
        cat: 'petit-bac',
        prompt: category,
        letter,
        answer: null,
        alt: [],
        pts: gen.pts,
      })),
    );

  const pool = (categoryId) => {
    const list = data.get(categoryId) ?? [];
    return list[0]?.generator ? petitBacQuestions(list[0]) : list;
  };

  return {
    data,
    // Combien de questions par catégorie (affiché dans les réglages).
    counts() {
      return Object.fromEntries(CATEGORY_IDS.map((id) => [id, id === 'petit-bac' ? (data.get(id)?.[0]?.categories.length ?? 0) : pool(id).length]));
    },
    // Tire `count` questions réparties équitablement entre les catégories choisies,
    // en évitant celles déjà posées dans ce lobby, puis mélange le tout.
    pick({ categories, count }, used = new Set()) {
      const chosen = CATEGORY_IDS.filter((id) => categories.includes(id) && pool(id).length > 0);
      if (chosen.length === 0) return [];
      const queues = new Map(
        chosen.map((id) => {
          let fresh = pool(id).filter((q) => !used.has(q.key));
          if (fresh.length === 0) {
            for (const q of pool(id)) used.delete(q.key);
            fresh = pool(id);
          }
          // Petit bac : une seule fois chaque catégorie par partie.
          if (id === 'petit-bac') {
            const seen = new Set();
            fresh = shuffle(fresh).filter((q) => !seen.has(q.prompt) && seen.add(q.prompt));
          }
          return [id, shuffle(fresh)];
        }),
      );
      const picked = [];
      let order = shuffle(chosen);
      while (picked.length < count && order.length) {
        for (const id of order) {
          if (picked.length >= count) break;
          const next = queues.get(id).shift();
          if (next) picked.push(next);
        }
        order = order.filter((id) => queues.get(id).length > 0);
      }
      for (const q of picked) used.add(q.key);
      return shuffle(picked);
    },
  };
}

export function loadQuizBank(dirUrl) {
  const files = CATEGORIES.map((category) => ({ category, url: new URL(category.file, dirUrl), mtime: null }));
  const byCategory = {};
  const bank = createQuizBank(byCategory);

  const refresh = () => {
    for (const file of files) {
      try {
        const mtime = statSync(file.url).mtimeMs;
        if (mtime === file.mtime) continue;
        const list = parseFile(file.category, readFileSync(file.url, 'utf8'));
        bank.data.set(file.category.id, list);
        if (file.mtime !== null) console.log(`[m-culture] ${file.category.file} rechargé (${list.length} entrées).`);
        file.mtime = mtime;
      } catch (error) {
        if (error.code === 'ENOENT') bank.data.set(file.category.id, []);
        else console.warn(`[m-culture] ${file.category.file} illisible, on garde la version précédente :`, error.message);
        file.mtime = file.mtime ?? -1;
      }
    }
  };
  refresh();

  const basePick = bank.pick;
  const baseCounts = bank.counts;
  bank.pick = (options, used) => {
    refresh();
    return basePick(options, used);
  };
  bank.counts = () => {
    refresh();
    return baseCounts();
  };
  return bank;
}
