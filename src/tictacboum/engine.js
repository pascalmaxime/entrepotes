import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError } from '../game/errors.js';

/**
 * Tic Tac Boum : une syllabe, une bombe qui passe de joueur en joueur.
 * Celui qui a la bombe doit taper un vrai mot contenant la syllabe (au début, n'importe où ou à la fin).
 * Mot juste → la bombe passe au suivant ; mot faux → elle reste. La mèche est aléatoire et SECRÈTE :
 * quand elle explose, celui qui tient la bombe perd une vie. Le dernier survivant gagne.
 *   tb-ready (3 s, on lit la syllabe) → tb-play (la mèche brûle) → tb-boom (4 s) → tb-ready… → finished
 */

export const TB_LIMITS = Object.freeze({
  lives: { min: 1, max: 5, default: 2 },
  fuses: { courte: [10, 20], moyenne: [18, 35], longue: [30, 55] }, // secondes, tirées au hasard
  difficulties: ['facile', 'moyen', 'difficile'],
  positions: ['debut', 'milieu', 'fin'],
  defaults: { lives: 2, fuse: 'moyenne', difficulty: 'moyen', positions: ['debut', 'milieu', 'fin'] },
});
// Mots acceptés en plus du dictionnaire (modifiable sans redémarrer).
export const EXTRA_FILE = fileURLToPath(new URL('../../data/tictacboum/mots-en-plus.txt', import.meta.url));
const READY_MS = 3_000;
const BOOM_MS = 4_000;
const FEED_MAX = 40;
const WORD_MAX = 40;

// Nombre de mots qui contiennent la syllabe, selon la difficulté (n'importe où / au début ou à la fin).
const THRESHOLDS = {
  milieu: { facile: [3000, Infinity], moyen: [700, 3000], difficile: [150, 700] },
  bord: { facile: [600, Infinity], moyen: [150, 600], difficile: [40, 150] },
};

// --- Dictionnaire -----------------------------------------------------------------------------------

// Sans accents, en minuscules, lettres uniquement : « Saint-Étienne » → « saintetienne ».
export function letters(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/[^a-z]/g, '');
}

let cache = null;

// Charge ~336 000 mots (paquet an-array-of-french-words, licence MIT) + data/tictacboum/mots-en-plus.txt.
export function loadDictionary(extraFile = EXTRA_FILE) {
  const extraMtime = extraFile && existsSync(extraFile) ? statSync(extraFile).mtimeMs : null;
  if (cache && cache.extraMtime === extraMtime) return cache;
  const base = cache?.base ?? createRequire(import.meta.url)('an-array-of-french-words');
  const words = new Set();
  for (const w of base) {
    const l = letters(w);
    if (l.length >= 2) words.add(l);
  }
  const extra = [];
  if (extraMtime !== null) {
    for (const line of readFileSync(extraFile, 'utf8').split(/\r?\n/)) {
      const l = letters(line.replace(/#.*/, ''));
      if (l.length >= 2) {
        words.add(l);
        extra.push(l);
      }
    }
  }
  cache = { base, words, extraMtime, extraCount: extra.length, syllables: cache?.syllables ?? null };
  if (!cache.syllables) cache.syllables = buildSyllables(words);
  return cache;
}

// Index des syllabes de 2 et 3 lettres : combien de mots les contiennent / commencent / finissent par elles.
function buildSyllables(words) {
  const anywhere = new Map();
  const start = new Map();
  const end = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const w of words) {
    if (w.length < 3) continue;
    const seen = new Set();
    for (let k = 2; k <= 3; k += 1) {
      if (w.length <= k) continue;
      bump(start, w.slice(0, k));
      bump(end, w.slice(-k));
      for (let i = 0; i + k <= w.length; i += 1) seen.add(w.slice(i, i + k));
    }
    for (const s of seen) bump(anywhere, s);
  }
  const lists = {};
  for (const position of TB_LIMITS.positions) {
    const map = position === 'debut' ? start : position === 'fin' ? end : anywhere;
    const t = THRESHOLDS[position === 'milieu' ? 'milieu' : 'bord'];
    lists[position] = {};
    for (const level of TB_LIMITS.difficulties) {
      const [min, max] = t[level];
      lists[position][level] = [...map].filter(([s, n]) => n >= min && n < max && /[aeiouy]/.test(s)).map(([s]) => s);
    }
  }
  return lists;
}

export function checkWord(dict, raw, syllable, usedWords = new Set()) {
  const word = letters(raw);
  if (word.length < 2) return { ok: false, reason: 'trop court' };
  const { text, position } = syllable;
  const fits = position === 'debut' ? word.startsWith(text) : position === 'fin' ? word.endsWith(text) : word.includes(text);
  if (!fits) return { ok: false, word, reason: position === 'debut' ? `ne commence pas par ${text.toUpperCase()}` : position === 'fin' ? `ne finit pas par ${text.toUpperCase()}` : `ne contient pas ${text.toUpperCase()}` };
  if (word === text) return { ok: false, word, reason: 'c’est juste la syllabe 😏' };
  if (!dict.words.has(word)) return { ok: false, word, reason: 'pas dans le dictionnaire' };
  if (usedWords.has(word)) return { ok: false, word, reason: 'déjà utilisé' };
  return { ok: true, word };
}

// --- Partie --------------------------------------------------------------------------------------------

const tbOf = (lobby) => lobby.game.tb;
const name = (lobby, id) => lobby.players.get(id)?.name ?? 'Un joueur parti';

function setTimer(lobby, ms, fn) {
  const tb = tbOf(lobby);
  lobby.clearQuizTimer();
  const token = ++tb.token;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.tb !== tb || tb.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, ms);
  lobby.quizTimer.unref?.();
}

export function startTicTacBoum(lobby, base) {
  const dict = loadDictionary();
  const settings = lobby.settings.ticTacBoum;
  const ids = lobby.connectedPlayers.map((p) => p.id);
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: 1,
    tb: {
      dict,
      settings: { ...settings },
      seats: ids,
      alive: new Set(ids),
      lives: new Map(ids.map((id) => [id, settings.lives])),
      out: [], // ordre d'élimination
      holderId: ids[randomInt(ids.length)],
      syllable: null,
      usedWords: new Set(),
      usedSyllables: new Set(),
      feed: [],
      feedSeq: 0,
      manche: 0,
      readyEndsAt: null,
      boom: null,
      token: 0,
      words: new Map(ids.map((id) => [id, 0])), // mots trouvés par joueur
    },
  };
  newManche(lobby);
}

function pickSyllable(tb) {
  const { positions, difficulty } = tb.settings;
  const options = positions.filter((p) => tb.dict.syllables[p][difficulty].length > 0);
  const position = options[randomInt(options.length)] ?? 'milieu';
  const list = tb.dict.syllables[position][difficulty];
  let fresh = list.filter((s) => !tb.usedSyllables.has(`${position}:${s}`));
  if (fresh.length === 0) fresh = list;
  const text = fresh[randomInt(fresh.length)];
  tb.usedSyllables.add(`${position}:${text}`);
  return { text, position };
}

function newManche(lobby) {
  const tb = tbOf(lobby);
  tb.manche += 1;
  tb.syllable = pickSyllable(tb);
  tb.boom = null;
  tb.typing = '';
  if (!tb.alive.has(tb.holderId) || !lobby.players.get(tb.holderId)?.connected) tb.holderId = nextHolder(lobby, tb.holderId);
  lobby.state = 'tb-ready';
  tb.readyEndsAt = Date.now() + READY_MS;
  setTimer(lobby, READY_MS, () => light(lobby));
}

// La mèche : durée aléatoire, jamais envoyée aux joueurs.
function light(lobby) {
  const tb = tbOf(lobby);
  const [min, max] = TB_LIMITS.fuses[tb.settings.fuse];
  const ms = (min + Math.random() * (max - min)) * 1000;
  lobby.state = 'tb-play';
  tb.readyEndsAt = null;
  setTimer(lobby, ms, () => explode(lobby));
}

// Joueur suivant autour de la table (vivant et connecté).
function nextHolder(lobby, fromId) {
  const tb = tbOf(lobby);
  const n = tb.seats.length;
  const start = Math.max(0, tb.seats.indexOf(fromId));
  for (let step = 1; step <= n; step += 1) {
    const id = tb.seats[(start + step) % n];
    if (tb.alive.has(id) && lobby.players.get(id)?.connected) return id;
  }
  return [...tb.alive][0] ?? fromId;
}

function addFeed(tb, entry) {
  tb.feed.push({ id: ++tb.feedSeq, at: Date.now(), ...entry });
  if (tb.feed.length > FEED_MAX) tb.feed.splice(0, tb.feed.length - FEED_MAX);
}

export function submitWord(lobby, playerId, raw) {
  if (lobby.game?.kind !== 'tic-tac-boum') throw new GameError('NOT_PLAYING', 'Pas de partie de Tic Tac Boum en cours.');
  const tb = tbOf(lobby);
  if (lobby.state !== 'tb-play') throw new GameError('NOT_NOW', lobby.state === 'tb-ready' ? 'Attends le top départ !' : 'Trop tard !');
  if (tb.holderId !== playerId) throw new GameError('NOT_YOUR_TURN', 'Ce n’est pas toi qui as la bombe.');
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, WORD_MAX) : '';
  if (!text) throw new GameError('EMPTY', 'Tape un mot.');
  const result = checkWord(tb.dict, text, tb.syllable, tb.usedWords);
  tb.typing = '';
  if (!result.ok) {
    addFeed(tb, { playerId, text, ok: false, reason: result.reason });
    return result;
  }
  tb.usedWords.add(result.word);
  tb.words.set(playerId, (tb.words.get(playerId) ?? 0) + 1);
  addFeed(tb, { playerId, text, ok: true });
  tb.holderId = nextHolder(lobby, playerId);
  return result;
}

// Frappe en direct (relayée aux autres sans renvoyer tout l'état).
export function typing(lobby, playerId, raw) {
  const tb = lobby.game?.tb;
  if (!tb || lobby.state !== 'tb-play' || tb.holderId !== playerId) return null;
  tb.typing = typeof raw === 'string' ? raw.slice(0, WORD_MAX) : '';
  return tb.typing;
}

function explode(lobby) {
  const tb = tbOf(lobby);
  const id = tb.holderId;
  const lives = Math.max(0, (tb.lives.get(id) ?? 1) - 1);
  tb.lives.set(id, lives);
  const eliminated = lives === 0;
  if (eliminated) {
    tb.alive.delete(id);
    tb.out.push(id);
  }
  tb.boom = { playerId: id, eliminated, syllable: tb.syllable };
  addFeed(tb, { playerId: id, boom: true, eliminated });
  lobby.state = 'tb-boom';
  setTimer(lobby, BOOM_MS, () => afterBoom(lobby));
}

function afterBoom(lobby) {
  const tb = tbOf(lobby);
  if (tb.alive.size <= 1) {
    endGame(lobby);
    return;
  }
  newManche(lobby); // celui qui a explosé repart avec la bombe (ou son voisin s'il est éliminé)
}

function endGame(lobby) {
  const tb = tbOf(lobby);
  lobby.clearQuizTimer();
  // Classement : le survivant d'abord, puis l'ordre inverse d'élimination.
  const order = [...tb.alive, ...[...tb.out].reverse()];
  order.forEach((id, i) => {
    lobby.game.totals[id] = order.length - i - 1;
  });
  const winner = order[0];
  lobby.game.history = [];
  lobby.finish();
  lobby.game.final.tb = {
    winner,
    manches: tb.manche,
    words: Object.fromEntries(tb.words),
    best: [...tb.words].sort((a, b) => b[1] - a[1])[0] ?? null,
  };
}

export function hostSkip(lobby) {
  const tb = tbOf(lobby);
  if (lobby.state === 'tb-ready') return light(lobby);
  if (lobby.state === 'tb-boom') return afterBoom(lobby);
  if (lobby.state === 'tb-play') {
    // Le porteur ne répond plus : la bombe passe au suivant, sans pénalité.
    tb.holderId = nextHolder(lobby, tb.holderId);
    return null;
  }
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

// Déconnexion : si le porteur de la bombe n'est plus là, elle passe au suivant.
export function progress(lobby) {
  const tb = lobby.game?.tb;
  if (!tb || !['tb-play', 'tb-ready'].includes(lobby.state)) return false;
  if (!lobby.players.get(tb.holderId)?.connected) {
    tb.holderId = nextHolder(lobby, tb.holderId);
    return true;
  }
  return false;
}

export function playerGone(lobby, playerId) {
  const tb = lobby.game?.tb;
  if (!tb || lobby.state === 'finished' || !tb.alive.has(playerId)) return;
  tb.alive.delete(playerId);
  tb.out.push(playerId);
  if (tb.alive.size <= 1) {
    endGame(lobby);
    return;
  }
  if (tb.holderId === playerId) tb.holderId = nextHolder(lobby, playerId);
}

export function tbPublic(lobby) {
  const tb = lobby.game?.tb;
  if (!tb) return null;
  return {
    phase: lobby.state,
    seats: tb.seats,
    alive: [...tb.alive],
    lives: Object.fromEntries(tb.lives),
    maxLives: tb.settings.lives,
    out: tb.out,
    holderId: tb.holderId,
    syllable: tb.syllable,
    typing: lobby.state === 'tb-play' ? tb.typing : '',
    feed: tb.feed,
    manche: tb.manche,
    usedCount: tb.usedWords.size,
    readyEndsAt: tb.readyEndsAt,
    serverNow: Date.now(),
    boom: tb.boom,
    words: Object.fromEntries(tb.words),
  };
}

export function tbLimits() {
  return {
    lives: { ...TB_LIMITS.lives },
    fuses: Object.keys(TB_LIMITS.fuses),
    difficulties: [...TB_LIMITS.difficulties],
    positions: [...TB_LIMITS.positions],
  };
}

// Validation des réglages de l'hôte.
export function sanitizeSettings(current, { tbLives, tbFuse, tbDifficulty, tbPositions }) {
  const next = { ...current };
  if (tbLives !== undefined) {
    const value = Number.parseInt(tbLives, 10);
    if (!Number.isFinite(value)) throw new GameError('INVALID_SETTINGS', 'Nombre de vies invalide.');
    next.lives = Math.min(TB_LIMITS.lives.max, Math.max(TB_LIMITS.lives.min, value));
  }
  if (tbFuse !== undefined) {
    if (!TB_LIMITS.fuses[tbFuse]) throw new GameError('INVALID_SETTINGS', 'Durée de mèche invalide.');
    next.fuse = tbFuse;
  }
  if (tbDifficulty !== undefined) {
    if (!TB_LIMITS.difficulties.includes(tbDifficulty)) throw new GameError('INVALID_SETTINGS', 'Difficulté invalide.');
    next.difficulty = tbDifficulty;
  }
  if (tbPositions !== undefined) {
    if (!Array.isArray(tbPositions)) throw new GameError('INVALID_SETTINGS', 'Positions invalides.');
    next.positions = TB_LIMITS.positions.filter((p) => tbPositions.includes(p));
    if (next.positions.length === 0) throw new GameError('INVALID_SETTINGS', 'Garde au moins une position.');
  }
  return next;
}
