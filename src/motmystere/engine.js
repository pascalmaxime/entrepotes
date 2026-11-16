import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError } from '../game/errors.js';
import { letters, loadDictionary } from '../tictacboum/engine.js';

/**
 * Mot Mystère (façon Motus / Wordle) : tout le monde cherche le même mot, en course.
 *   mm-play   : chacun a 6 essais ; chaque essai est colorié (bien placée / mal placée / absente)
 *   mm-reveal : le mot, les grilles de chacun (avec les lettres), les points → manche suivante → … → finished
 * Les autres voient tes couleurs en direct, jamais tes lettres. Le mot n'est envoyé qu'à la révélation.
 * Points : 10 + 2 par essai non utilisé (20 du premier coup), +5 / +3 / +1 aux trois premiers à trouver.
 */

export const MIN_PLAYERS = 2;
export const MAX_TRIES = 6;
export const MM_POINTS = Object.freeze({ found: 10, perTryLeft: 2, podium: [5, 3, 1] });
export const MM_LIMITS = Object.freeze({
  rounds: [3, 5, 8, 10],
  lengths: [0, 5, 6, 7, 8], // 0 = au hasard entre 5 et 7
  timers: [60, 90, 120, 180],
  defaults: { rounds: 5, length: 0, timer: 120, first: true },
});
const MIX = [5, 6, 7];
const GRACE_MS = 1_000;
export const WORDS_FILE = fileURLToPath(new URL('../../data/motmystere.json', import.meta.url));

// --- Couleurs d'un essai (comme Wordle : les lettres en double sont comptées) ------------------------------

export function score(guess, secret) {
  const result = Array(secret.length).fill('no');
  const left = new Map();
  for (let i = 0; i < secret.length; i += 1) {
    if (guess[i] === secret[i]) result[i] = 'ok';
    else left.set(secret[i], (left.get(secret[i]) ?? 0) + 1);
  }
  for (let i = 0; i < secret.length; i += 1) {
    if (result[i] === 'ok') continue;
    const n = left.get(guess[i]) ?? 0;
    if (n > 0) {
      result[i] = 'near';
      left.set(guess[i], n - 1);
    }
  }
  return result;
}

// --- Mots à deviner (data/motmystere.json, relu automatiquement s'il change) ------------------------------

function parseWords(raw) {
  const data = JSON.parse(raw);
  const byLength = {};
  for (const [len, list] of Object.entries(data)) {
    if (!/^\d+$/.test(len) || !Array.isArray(list)) continue;
    for (const w of list) {
      if (typeof w !== 'string') continue;
      const key = letters(w);
      if (key.length < 4 || /[\s-]/.test(w.trim())) continue;
      (byLength[key.length] ??= new Map()).set(key, w.trim());
    }
  }
  return byLength;
}

export function createSecretBank(byLength) {
  let lists = byLength;
  return {
    replace(next) {
      lists = next;
    },
    counts() {
      return Object.fromEntries(Object.entries(lists).map(([len, map]) => [len, map.size]));
    },
    // Un mot de la longueur voulue jamais tiré dans ce lobby (on recommence quand la liste est épuisée).
    pick(length, used = new Set()) {
      const map = lists[length];
      if (!map?.size) return null;
      let fresh = [...map.keys()].filter((k) => !used.has(k));
      if (fresh.length === 0) {
        for (const k of map.keys()) used.delete(k);
        fresh = [...map.keys()];
      }
      const key = fresh[randomInt(fresh.length)];
      used.add(key);
      return { key, display: map.get(key) };
    },
  };
}

export function loadSecretBank(file = WORDS_FILE) {
  let mtime = statSync(file).mtimeMs;
  const bank = createSecretBank(parseWords(readFileSync(file, 'utf8')));
  const refresh = () => {
    try {
      const current = statSync(file).mtimeMs;
      if (current === mtime) return;
      bank.replace(parseWords(readFileSync(file, 'utf8')));
      mtime = current;
      console.log('[mot-mystere] Fichier rechargé.');
    } catch (error) {
      console.warn('[mot-mystere] Rechargement impossible, on garde la version précédente :', error.message);
    }
  };
  const basePick = bank.pick;
  const baseCounts = bank.counts;
  bank.pick = (length, used) => {
    refresh();
    return basePick(length, used);
  };
  bank.counts = () => {
    refresh();
    return baseCounts();
  };
  return bank;
}

let sharedBank = null;
export function getBank() {
  if (!sharedBank) sharedBank = loadSecretBank();
  return sharedBank;
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const mmOf = (lobby) => lobby.game.mm;
const isDone = (entry) => entry.found || entry.rows.length >= MAX_TRIES;

function setTimer(lobby, seconds, fn) {
  const mm = mmOf(lobby);
  lobby.clearQuizTimer();
  const token = ++mm.token;
  mm.deadline = Date.now() + seconds * 1000;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.mm !== mm || mm.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, seconds * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

export function startMotMystere(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  lobby.mmBank ??= getBank();
  lobby.mmDict ??= loadDictionary();
  lobby.usedMmWords ??= new Set();
  const settings = { ...lobby.settings.motMystere };
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: settings.rounds,
    mm: { settings, index: 0, token: 0, deadline: null, secret: null, boards: new Map(), finishers: [] },
  };
  openRound(lobby);
}

function openRound(lobby) {
  const mm = mmOf(lobby);
  const length = mm.settings.length || MIX[randomInt(MIX.length)];
  const secret = lobby.mmBank.pick(length, lobby.usedMmWords) ?? lobby.mmBank.pick(6, lobby.usedMmWords);
  if (!secret) throw new GameError('NO_WORDS', 'Aucun mot disponible.');
  mm.secret = secret;
  mm.boards = new Map(); // joueur → { rows: [{ word, colors }], found, at }
  mm.finishers = []; // ceux qui ont trouvé, dans l'ordre
  lobby.game.index = mm.index;
  lobby.game.result = null;
  lobby.state = 'mm-play';
  setTimer(lobby, mm.settings.timer, () => reveal(lobby));
}

const boardOf = (mm, playerId) => {
  if (!mm.boards.has(playerId)) mm.boards.set(playerId, { rows: [], found: false, at: null });
  return mm.boards.get(playerId);
};

// Un essai : renvoie les couleurs (le joueur les voit tout de suite, même avant l'état complet).
export function submitGuess(lobby, playerId, { index, word } = {}) {
  if (lobby.game?.kind !== 'mot-mystere' || lobby.state !== 'mm-play') throw new GameError('NOT_NOW', 'La manche est terminée.');
  const mm = mmOf(lobby);
  if (index !== mm.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la suite !');
  const board = boardOf(mm, playerId);
  if (isDone(board)) throw new GameError('DONE', board.found ? 'Tu as déjà trouvé 😎' : 'Plus d’essai pour cette manche.');
  const guess = letters(word);
  const secret = mm.secret.key;
  if (guess.length !== secret.length) throw new GameError('BAD_LENGTH', `Il faut un mot de ${secret.length} lettres.`);
  if (mm.settings.first && guess[0] !== secret[0]) throw new GameError('BAD_FIRST', `Le mot commence par ${secret[0].toUpperCase()}.`);
  if (guess !== secret && !lobby.mmDict.words.has(guess)) throw new GameError('NOT_A_WORD', `« ${guess.toUpperCase()} » n’est pas dans le dictionnaire.`);
  if (board.rows.some((r) => r.word === guess)) throw new GameError('ALREADY_TRIED', 'Tu as déjà essayé ce mot.');
  const colors = score(guess, secret);
  board.rows.push({ word: guess, colors });
  if (guess === secret) {
    board.found = true;
    board.at = Date.now();
    mm.finishers.push(playerId);
  }
  checkAllDone(lobby);
  return { colors, found: board.found };
}

function checkAllDone(lobby) {
  if (lobby.state !== 'mm-play') return false;
  const mm = mmOf(lobby);
  const players = lobby.connectedPlayers;
  if (players.length === 0 || !players.every((p) => mm.boards.has(p.id) && isDone(mm.boards.get(p.id)))) return false;
  reveal(lobby);
  return true;
}

export function reveal(lobby) {
  const mm = mmOf(lobby);
  const { game } = lobby;
  lobby.clearQuizTimer();
  mm.token += 1;
  mm.deadline = null;
  const gains = {};
  const finishers = mm.finishers.filter((id) => lobby.players.has(id));
  finishers.forEach((id, rank) => {
    const tries = mm.boards.get(id).rows.length;
    gains[id] = MM_POINTS.found + MM_POINTS.perTryLeft * (MAX_TRIES - tries) + (MM_POINTS.podium[rank] ?? 0);
    game.totals[id] = (game.totals[id] ?? 0) + gains[id];
  });
  const boards = lobby.playerIds.map((id) => {
    const b = mm.boards.get(id) ?? { rows: [], found: false };
    return { playerId: id, rows: b.rows, found: b.found, rank: b.found ? finishers.indexOf(id) + 1 : null };
  });
  game.history.push({ question: `Manche ${mm.index + 1} · ${mm.secret.display.toUpperCase()}`, answer: mm.secret.display, topPlayerIds: finishers });
  game.result = { type: 'mot-mystere', word: mm.secret.display, key: mm.secret.key, boards, gains, scores: { ...game.totals } };
  lobby.state = 'mm-reveal';
}

export function next(lobby) {
  const mm = mmOf(lobby);
  if (mm.index + 1 >= lobby.game.totalRounds) {
    lobby.game.index = lobby.game.totalRounds;
    lobby.finish();
    return 'finish';
  }
  mm.index += 1;
  openRound(lobby);
  return 'next';
}

export function hostSkip(lobby) {
  if (lobby.state === 'mm-play') return reveal(lobby);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

export function progress(lobby) {
  if (lobby.state === 'mm-play') return checkAllDone(lobby);
  return false;
}

export function playerGone(lobby, playerId) {
  const mm = lobby.game.mm;
  mm.boards.delete(playerId);
  mm.finishers = mm.finishers.filter((id) => id !== playerId);
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function mmPublic(lobby, viewerId) {
  const mm = lobby.game?.mm;
  if (!mm || !lobby.state.startsWith('mm-')) return null;
  const secret = mm.secret.key;
  const mine = mm.boards.get(viewerId) ?? { rows: [], found: false };
  return {
    phase: lobby.state,
    index: mm.index,
    total: lobby.game.totalRounds,
    length: secret.length,
    first: mm.settings.first ? secret[0] : null,
    maxTries: MAX_TRIES,
    deadline: mm.deadline,
    timer: mm.settings.timer,
    serverNow: Date.now(),
    // Mes essais avec les lettres ; ceux des autres en couleurs seulement.
    myRows: mine.rows,
    myFound: mine.found,
    myDone: isDone(mine),
    others: lobby.playerIds.map((id) => {
      const b = mm.boards.get(id) ?? { rows: [], found: false };
      return { playerId: id, colors: b.rows.map((r) => r.colors), found: b.found, done: isDone(b), rank: b.found ? mm.finishers.indexOf(id) + 1 : null };
    }),
  };
}

export function mmLimits(lobby) {
  const bank = lobby.mmBank ?? getBank();
  return {
    minPlayers: MIN_PLAYERS,
    rounds: [...MM_LIMITS.rounds],
    lengths: [...MM_LIMITS.lengths],
    timers: [...MM_LIMITS.timers],
    maxTries: MAX_TRIES,
    points: { ...MM_POINTS, podium: [...MM_POINTS.podium] },
    words: bank.counts(),
  };
}

export function defaultSettings() {
  return { ...MM_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { mmRounds, mmLength, mmTimer, mmFirst }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (mmRounds !== undefined) next.rounds = pickFrom(MM_LIMITS.rounds, mmRounds, 'Nombre de manches');
  if (mmLength !== undefined) next.length = pickFrom(MM_LIMITS.lengths, mmLength, 'Longueur des mots');
  if (mmTimer !== undefined) next.timer = pickFrom(MM_LIMITS.timers, mmTimer, 'Chrono');
  if (mmFirst !== undefined) next.first = Boolean(mmFirst);
  return next;
}
