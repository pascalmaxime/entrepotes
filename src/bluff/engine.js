import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError } from '../game/errors.js';

/**
 * Bluff (façon Fibbage) : une anecdote vraie avec un trou à compléter.
 *   bl-write  : chacun invente une fausse réponse crédible (chrono)
 *   bl-vote   : vraie réponse + mensonges mélangés, chacun vote pour celle qu'il croit vraie (chrono)
 *   bl-reveal : on dévoile qui a piégé qui, puis la vérité → question suivante → … → finished
 * Points : +2 si tu trouves la vérité, +1 par joueur piégé par ton mensonge (x2 à la dernière question si l'hôte l'a choisi).
 * La vraie réponse n'est JAMAIS envoyée aux navigateurs avant la révélation.
 */

export const BL_CATEGORIES = Object.freeze([
  { id: 'animaux', label: 'Animaux', emoji: '🐾' },
  { id: 'histoire', label: 'Histoire', emoji: '📜' },
  { id: 'marques', label: 'Inventions', emoji: '💡' },
  { id: 'sciences', label: 'Sciences', emoji: '🔬' },
  { id: 'mots', label: 'Mots', emoji: '🔤' },
  { id: 'monde', label: 'Monde', emoji: '🌍' },
  { id: 'sport', label: 'Sport', emoji: '🏅' },
  { id: 'bouffe', label: 'Bouffe', emoji: '🍔' },
]);
export const BL_CATEGORY_IDS = BL_CATEGORIES.map((c) => c.id);
export const BL_POINTS = Object.freeze({ truth: 2, fooled: 1 });
export const MIN_PLAYERS = 3;
export const BL_LIMITS = Object.freeze({
  write: [45, 60, 90, 120], // secondes pour écrire son mensonge
  vote: [20, 30, 45, 60], // secondes pour voter
  defaults: { write: 60, vote: 30, double: true },
});
const MIN_CHOICES = 4; // en dessous, le jeu ajoute ses propres leurres
const LIE_MAX = 60;
const GRACE_MS = 1_000;
export const BLUFF_FILE = fileURLToPath(new URL('../../data/bluff.json', import.meta.url));

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// --- Comparaison de textes : « Des lapins » = « lapin » = « LAPINS ! » ------------------------------------

const STOP = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'a', 'au', 'aux', 'en', 'et', 'sa', 'son', 'ses', 'leur', 'leurs', 'ce', 'cet', 'cette']);

export function words(text) {
  const all = String(text ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const meaningful = all.filter((w) => !STOP.has(w));
  // « dé », « Y »… : si tout est « petit mot », on garde tout.
  return (meaningful.length ? meaningful : all).map((w) => (w.length > 3 ? w.replace(/[sx]$/, '') : w));
}

export const textKey = (text) => words(text).join(' ');

const NUMBER_WORDS = new Set(['deux', 'deu', 'troi', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'quinze', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'cent', 'mille', 'million', 'milliard', 'demi']);
const numbers = (list) => list.filter((w) => /^\d/.test(w) || NUMBER_WORDS.has(w)).sort().join(' ');

// Une seule faute de frappe tolérée (« lapain »), jamais sur les nombres ni les mots courts.
function oneTypo(a, b) {
  if (a === b) return true;
  if (/\d/.test(a + b) || Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  const rest = (x, y) => x.slice(i + y);
  return rest(a, 1) === rest(b, 1) || rest(a, 1) === rest(b, 0) || rest(a, 0) === rest(b, 1);
}

// Le mensonge est-il (presque) la vraie réponse ?
export function isTruth(lie, question) {
  const lieWords = words(lie);
  if (lieWords.length === 0) return false;
  const lieSet = new Set(lieWords);
  const lieNumbers = numbers(lieWords);
  for (const answer of [question.answer, ...question.alt]) {
    const answerWords = words(answer);
    if (answerWords.length === 0) continue;
    // « 12 minutes » n'est pas « 38 minutes », « deux tiers » n'est pas « un tiers »
    if (lieNumbers && lieNumbers !== numbers(answerWords)) continue;
    if (oneTypo(lieWords.join(''), answerWords.join(''))) return true;
    // « Il a été attaqué par des lapins géants » contient tous les mots de « lapins »
    if (answerWords.every((w) => lieSet.has(w))) return true;
  }
  return false;
}

export function cleanLie(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIE_MAX);
}

// --- Banque de questions (data/bluff.json, relu automatiquement s'il change) ---------------------------------

function parseBank(raw) {
  const data = JSON.parse(raw);
  const list = (Array.isArray(data.questions) ? data.questions : [])
    .filter((q) => BL_CATEGORY_IDS.includes(q?.cat) && typeof q.q === 'string' && q.q.includes('_____') && typeof q.a === 'string' && q.a.trim())
    .map((q) => ({
      key: `${q.cat}:${q.q}`,
      cat: q.cat,
      prompt: q.q.trim(),
      answer: q.a.trim(),
      alt: (Array.isArray(q.alt) ? q.alt : []).filter((s) => typeof s === 'string' && s.trim()),
      fake: (Array.isArray(q.fake) ? q.fake : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => cleanLie(s)),
    }));
  if (list.length === 0) throw new Error('Aucune question valide.');
  return list;
}

export function createBluffBank(questions) {
  let list = [...questions];
  return {
    get size() {
      return list.length;
    },
    replace(next) {
      list = [...next];
    },
    counts() {
      return Object.fromEntries(BL_CATEGORY_IDS.map((id) => [id, list.filter((q) => q.cat === id).length]));
    },
    // Questions réparties entre les catégories choisies, sans répéter celles déjà jouées dans le lobby.
    pick({ categories, count }, used = new Set()) {
      const chosen = BL_CATEGORY_IDS.filter((id) => categories.includes(id) && list.some((q) => q.cat === id));
      if (chosen.length === 0) return [];
      const queues = new Map(
        chosen.map((id) => {
          const all = list.filter((q) => q.cat === id);
          let fresh = all.filter((q) => !used.has(q.key));
          if (fresh.length === 0) {
            for (const q of all) used.delete(q.key);
            fresh = all;
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

export function loadBluffBank(file = BLUFF_FILE) {
  let mtime = statSync(file).mtimeMs;
  const bank = createBluffBank(parseBank(readFileSync(file, 'utf8')));
  const refresh = () => {
    try {
      const current = statSync(file).mtimeMs;
      if (current === mtime) return;
      bank.replace(parseBank(readFileSync(file, 'utf8')));
      mtime = current;
      console.log(`[bluff] Fichier rechargé (${bank.size} questions).`);
    } catch (error) {
      console.warn('[bluff] Rechargement impossible, on garde la version précédente :', error.message);
    }
  };
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

let sharedBank = null;
export function getBank() {
  if (!sharedBank) sharedBank = loadBluffBank();
  return sharedBank;
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const blOf = (lobby) => lobby.game.bluff;
const current = (bl) => bl.questions[bl.index];
const isLast = (bl) => bl.index + 1 >= bl.questions.length;
const multiplier = (bl) => (bl.settings.double && isLast(bl) && bl.questions.length > 1 ? 2 : 1);

function setTimer(lobby, seconds, fn) {
  const bl = blOf(lobby);
  lobby.clearQuizTimer();
  const token = ++bl.token;
  bl.deadline = Date.now() + seconds * 1000;
  bl.timer = seconds;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.bluff !== bl || bl.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, seconds * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

export function startBluff(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  const settings = { ...lobby.settings.bluff };
  lobby.bluffBank ??= getBank();
  lobby.usedBluff ??= new Set();
  const questions = lobby.bluffBank.pick({ categories: settings.categories, count: lobby.settings.rounds }, lobby.usedBluff);
  if (questions.length === 0) throw new GameError('NO_QUESTIONS', 'Aucune question disponible dans les catégories choisies.');
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: questions.length,
    bluff: { settings, questions, index: 0, token: 0, deadline: null, timer: 0, lies: new Map(), choices: [], votes: new Map(), suggested: new Map(), bestLies: [] },
  };
  openWrite(lobby);
}

function openWrite(lobby) {
  const bl = blOf(lobby);
  bl.lies = new Map(); // joueur → texte du mensonge
  bl.suggested = new Map(); // joueur → leurres déjà proposés (bouton « Mentir pour moi »)
  bl.choices = [];
  bl.votes = new Map();
  lobby.game.result = null;
  lobby.state = 'bl-write';
  setTimer(lobby, bl.settings.write, () => openVote(lobby));
}

export function submitLie(lobby, playerId, { index, text } = {}) {
  if (lobby.game?.kind !== 'bluff' || lobby.state !== 'bl-write') throw new GameError('NOT_NOW', 'Ce n’est plus le moment d’écrire.');
  const bl = blOf(lobby);
  if (index !== bl.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la suite !');
  const lie = cleanLie(text);
  if (!lie || words(lie).length === 0) throw new GameError('EMPTY', 'Écris un mensonge crédible 😉');
  if (isTruth(lie, current(bl))) {
    throw new GameError('IS_TRUTH', 'Tu as trouvé la vraie réponse ! 🤫 Garde-la pour le vote et invente un autre mensonge.');
  }
  bl.lies.set(playerId, lie);
  checkAllWritten(lobby);
}

// « Mentir pour moi » : un leurre du jeu, différent à chaque clic si possible.
export function suggestLie(lobby, playerId) {
  if (lobby.game?.kind !== 'bluff' || lobby.state !== 'bl-write') throw new GameError('NOT_NOW', 'Ce n’est plus le moment d’écrire.');
  const bl = blOf(lobby);
  const already = bl.suggested.get(playerId) ?? [];
  const takenKeys = new Set([...bl.lies.values()].map(textKey));
  const pool = current(bl).fake.filter((f) => !takenKeys.has(textKey(f)));
  const fresh = pool.filter((f) => !already.includes(f));
  const list = fresh.length ? fresh : pool;
  if (list.length === 0) throw new GameError('NO_IDEA', 'Plus d’idée en stock… à toi d’inventer ! 😅');
  const idea = list[randomInt(list.length)];
  bl.suggested.set(playerId, [...already, idea]);
  return idea;
}

function checkAllWritten(lobby) {
  if (lobby.state !== 'bl-write') return false;
  const bl = blOf(lobby);
  const players = lobby.connectedPlayers;
  if (players.length === 0 || !players.every((p) => bl.lies.has(p.id))) return false;
  openVote(lobby);
  return true;
}

// Les réponses proposées : la vérité, les mensonges (identiques = fusionnés), et des leurres si on est peu.
function buildChoices(lobby) {
  const bl = blOf(lobby);
  const question = current(bl);
  const byKey = new Map();
  for (const [playerId, text] of bl.lies) {
    if (!lobby.players.has(playerId)) continue;
    const key = textKey(text);
    if (byKey.has(key)) byKey.get(key).authors.push(playerId);
    else byKey.set(key, { id: randomUUID().slice(0, 8), text, authors: [playerId], truth: false, house: false });
  }
  const choices = [{ id: randomUUID().slice(0, 8), text: question.answer, authors: [], truth: true, house: false }, ...byKey.values()];
  for (const fake of shuffle(question.fake)) {
    if (choices.length >= MIN_CHOICES) break;
    if (byKey.has(textKey(fake))) continue;
    choices.push({ id: randomUUID().slice(0, 8), text: fake, authors: [], truth: false, house: true });
  }
  return shuffle(choices);
}

function openVote(lobby) {
  const bl = blOf(lobby);
  bl.choices = buildChoices(lobby);
  bl.votes = new Map();
  lobby.state = 'bl-vote';
  setTimer(lobby, bl.settings.vote, () => reveal(lobby));
}

export function submitVote(lobby, playerId, { index, choiceId } = {}) {
  if (lobby.game?.kind !== 'bluff' || lobby.state !== 'bl-vote') throw new GameError('NOT_NOW', 'Le vote est terminé.');
  const bl = blOf(lobby);
  if (index !== bl.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la suite !');
  const choice = bl.choices.find((c) => c.id === choiceId);
  if (!choice) throw new GameError('INVALID_VOTE', 'Réponse inconnue.');
  if (choice.authors.includes(playerId)) throw new GameError('OWN_LIE', 'Tu ne peux pas voter pour ton propre mensonge 😏');
  bl.votes.set(playerId, choiceId);
  checkAllVoted(lobby);
}

function checkAllVoted(lobby) {
  if (lobby.state !== 'bl-vote') return false;
  const bl = blOf(lobby);
  const players = lobby.connectedPlayers;
  if (players.length === 0 || !players.every((p) => bl.votes.has(p.id))) return false;
  reveal(lobby);
  return true;
}

export function reveal(lobby) {
  const bl = blOf(lobby);
  const { game } = lobby;
  lobby.clearQuizTimer();
  bl.deadline = null;
  const question = current(bl);
  const mult = multiplier(bl);
  const gains = {};
  const add = (id, n) => {
    if (n > 0 && lobby.players.has(id)) gains[id] = (gains[id] ?? 0) + n;
  };
  const voters = new Map(bl.choices.map((c) => [c.id, []]));
  for (const [playerId, choiceId] of bl.votes) {
    if (lobby.players.has(playerId)) voters.get(choiceId)?.push(playerId);
  }
  for (const choice of bl.choices) {
    const fooled = voters.get(choice.id);
    if (choice.truth) fooled.forEach((id) => add(id, BL_POINTS.truth * mult));
    else for (const author of choice.authors) add(author, fooled.length * BL_POINTS.fooled * mult);
  }
  for (const [id, n] of Object.entries(gains)) game.totals[id] = (game.totals[id] ?? 0) + n;

  // Ordre de révélation : les leurres sans victime d'abord, puis les mensonges qui ont piégé du monde, la vérité en dernier.
  const choices = bl.choices
    .map((c) => ({ id: c.id, text: c.text, authors: c.authors.filter((id) => lobby.players.has(id)), truth: c.truth, house: c.house, voters: voters.get(c.id) }))
    .sort((a, b) => Number(a.truth) - Number(b.truth) || a.voters.length - b.voters.length);
  const finders = voters.get(bl.choices.find((c) => c.truth).id);
  for (const c of choices) {
    if (!c.truth && !c.house && c.voters.length) bl.bestLies.push({ text: c.text, authors: c.authors, fooled: c.voters.length });
  }
  game.history.push({ question: question.prompt.replace(/_____\s*[.!?]?$/, '…').replace('_____', '…'), answer: question.answer, topPlayerIds: [...finders] });
  game.result = {
    type: 'bluff',
    question: { cat: question.cat, prompt: question.prompt },
    answer: question.answer,
    choices,
    mult,
    gains,
    noVote: lobby.playerIds.filter((id) => !bl.votes.has(id)),
    scores: { ...game.totals },
  };
  lobby.state = 'bl-reveal';
}

export function next(lobby) {
  const bl = blOf(lobby);
  if (isLast(bl)) {
    lobby.game.index = lobby.game.totalRounds;
    finishGame(lobby);
    return 'finish';
  }
  bl.index += 1;
  lobby.game.index = bl.index;
  openWrite(lobby);
  return 'next';
}

function finishGame(lobby) {
  const bl = blOf(lobby);
  lobby.finish();
  const best = [...bl.bestLies].sort((a, b) => b.fooled - a.fooled)[0] ?? null;
  lobby.game.final.bluff = { bestLie: best };
}

// L'hôte passe à la suite sans attendre les retardataires.
export function hostSkip(lobby) {
  if (lobby.state === 'bl-write') return openVote(lobby);
  if (lobby.state === 'bl-vote') return reveal(lobby);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

export function progress(lobby) {
  if (lobby.state === 'bl-write') return checkAllWritten(lobby);
  if (lobby.state === 'bl-vote') return checkAllVoted(lobby);
  return false;
}

export function playerGone(lobby, playerId) {
  const bl = lobby.game.bluff;
  bl.lies.delete(playerId);
  bl.votes.delete(playerId);
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function bluffPublic(lobby, viewerId) {
  const bl = lobby.game?.bluff;
  if (!bl || !lobby.state.startsWith('bl-')) return null;
  const question = current(bl);
  const live = (ids) => [...ids].filter((id) => lobby.players.has(id));
  const base = {
    phase: lobby.state,
    index: bl.index,
    total: bl.questions.length,
    mult: multiplier(bl),
    question: { cat: question.cat, prompt: question.prompt },
    deadline: bl.deadline,
    timer: bl.timer,
    serverNow: Date.now(),
  };
  if (lobby.state === 'bl-write') {
    return { ...base, doneIds: live(bl.lies.keys()), myLie: bl.lies.get(viewerId) ?? null };
  }
  if (lobby.state === 'bl-vote') {
    return {
      ...base,
      doneIds: live(bl.votes.keys()),
      // Jamais l'auteur ni la vérité : juste les textes, et lequel est le sien.
      choices: bl.choices.map((c) => ({ id: c.id, text: c.text, mine: c.authors.includes(viewerId) })),
      myVote: bl.votes.get(viewerId) ?? null,
    };
  }
  return base;
}

export function bluffLimits(lobby) {
  const bank = lobby.bluffBank ?? getBank();
  const counts = bank.counts();
  return {
    minPlayers: MIN_PLAYERS,
    write: [...BL_LIMITS.write],
    vote: [...BL_LIMITS.vote],
    points: { ...BL_POINTS },
    categories: BL_CATEGORIES.map(({ id, label, emoji }) => ({ id, label, emoji, count: counts[id] ?? 0 })),
  };
}

export function defaultSettings() {
  return { categories: [...BL_CATEGORY_IDS], ...BL_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { blCategories, blWrite, blVote, blDouble }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (blCategories !== undefined) {
    if (!Array.isArray(blCategories)) throw new GameError('INVALID_SETTINGS', 'Catégories invalides.');
    next.categories = BL_CATEGORY_IDS.filter((id) => blCategories.includes(id));
    if (next.categories.length === 0) throw new GameError('INVALID_SETTINGS', 'Garde au moins une catégorie.');
  }
  if (blWrite !== undefined) next.write = pickFrom(BL_LIMITS.write, blWrite, 'Temps pour mentir');
  if (blVote !== undefined) next.vote = pickFrom(BL_LIMITS.vote, blVote, 'Temps pour voter');
  if (blDouble !== undefined) next.double = Boolean(blDouble);
  return next;
}
