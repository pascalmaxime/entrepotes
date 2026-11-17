import { randomInt } from 'node:crypto';
import { GameError } from '../game/errors.js';
import { clashes, getBank as getWordBank, norm } from '../nomdecode/engine.js';
import { textKey } from '../bluff/engine.js';

/**
 * Un seul indice (façon Just One), coopératif : tout le monde fait deviner un mot à un devineur.
 *   uj-clue   : tout le monde sauf le devineur voit le mot et écrit UN indice d'un seul mot
 *   uj-check  : les indices identiques (ou de la même famille) sont barrés automatiquement ;
 *               n'importe quel joueur (sauf le devineur) peut en barrer d'autres, puis valide
 *   uj-guess  : le devineur voit les indices restants et a UN essai (ou passe)
 *   uj-reveal : le mot, l'essai, les points → manche suivante → … → finished
 * Points si le mot est trouvé : +3 au devineur, +1 à chaque auteur d'un indice gardé.
 * Le score d'équipe (mots trouvés) s'affiche à la fin.
 */

export const MIN_PLAYERS = 3;
export const UJ_POINTS = Object.freeze({ guesser: 3, clue: 1 });
export const UJ_LIMITS = Object.freeze({
  turns: [1, 2, 3], // chacun devine N fois
  clue: [30, 45, 60],
  guess: [30, 45, 60],
  defaults: { turns: 2, clue: 45, guess: 45 },
});
const TEXT_MAX = 24;
const GRACE_MS = 1_000;

const clean = (raw) => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/’/g, "'").replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX) : '');

// Une faute de frappe tolérée sur l'essai du devineur (« elephan » = « éléphant »).
function closeEnough(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

// Pluriels pardonnés : « chevaux » = « cheval », « bateaux » = « bateau ».
const singular = (k) => (k.length > 4 ? k.replace(/(eaux|aux|s|x)$/, (m) => (m === 'aux' ? 'al' : m === 'eaux' ? 'eau' : '')) : k);

// Essai du devineur : articles, accents, pluriel et une faute de frappe pardonnés (« les éléphans » = « Éléphant »).
export function isFound(guess, word) {
  const g = singular(norm(textKey(guess) || guess));
  const w = singular(norm(word));
  return Boolean(g) && closeEnough(g, w);
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const ujOf = (lobby) => lobby.game.uj;
const isConnected = (lobby, id) => Boolean(lobby.players.get(id)?.connected);
const writers = (lobby) => lobby.connectedPlayers.map((p) => p.id).filter((id) => id !== ujOf(lobby).guesser);

function setTimer(lobby, seconds, fn) {
  const uj = ujOf(lobby);
  lobby.clearQuizTimer();
  const token = ++uj.token;
  uj.timer = seconds;
  uj.deadline = Date.now() + seconds * 1000;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.uj !== uj || uj.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, seconds * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

function stopTimer(lobby) {
  const uj = ujOf(lobby);
  lobby.clearQuizTimer();
  uj.token += 1;
  uj.deadline = null;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function startUnSeulIndice(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  lobby.ujBank ??= getWordBank();
  lobby.usedUjWords ??= new Set();
  const settings = { ...lobby.settings.unSeulIndice };
  const order = shuffle(lobby.connectedPlayers.map((p) => p.id));
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: order.length * settings.turns,
    uj: { settings, order, index: 0, token: 0, deadline: null, timer: 0, guesser: null, word: null, clues: new Map(), cancelled: new Set(), auto: new Set(), guess: null, found: 0, played: 0 },
  };
  openRound(lobby);
}

function openRound(lobby) {
  const uj = ujOf(lobby);
  const { game } = lobby;
  while (uj.index < game.totalRounds && !isConnected(lobby, uj.order[uj.index % uj.order.length])) uj.index += 1;
  if (uj.index >= game.totalRounds || lobby.connectedPlayers.length < MIN_PLAYERS) {
    stopTimer(lobby);
    game.index = game.totalRounds;
    lobby.finish();
    lobby.game.final.uj = { found: uj.found, played: uj.played };
    return;
  }
  uj.guesser = uj.order[uj.index % uj.order.length];
  [uj.word] = lobby.ujBank.pick(1, lobby.usedUjWords);
  uj.clues = new Map(); // auteur → indice
  uj.cancelled = new Set(); // auteurs dont l'indice est barré
  uj.auto = new Set(); // … barré automatiquement (doublon)
  uj.guess = null;
  game.index = uj.index;
  game.result = null;
  lobby.state = 'uj-clue';
  setTimer(lobby, uj.settings.clue, () => openCheck(lobby));
}

export function submitClue(lobby, playerId, { index, text } = {}) {
  if (lobby.game?.kind !== 'un-seul-indice' || lobby.state !== 'uj-clue') throw new GameError('NOT_NOW', 'Ce n’est plus le moment d’écrire un indice.');
  const uj = ujOf(lobby);
  if (index !== uj.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la suite !');
  if (playerId === uj.guesser) throw new GameError('GUESSER', 'C’est toi qui devines 😉');
  const clue = clean(text);
  if (!clue) throw new GameError('EMPTY', 'Écris un indice 😉');
  if (/\s/.test(clue)) throw new GameError('ONE_WORD', 'Un seul mot (sans espace) !');
  if (!/\p{L}/u.test(clue)) throw new GameError('INVALID', 'L’indice doit contenir des lettres.');
  if (clashes(clue, uj.word)) throw new GameError('TOO_CLOSE', 'Interdit : c’est (presque) le mot à faire deviner !');
  uj.clues.set(playerId, clue);
  checkAllClues(lobby);
}

function checkAllClues(lobby) {
  if (lobby.state !== 'uj-clue') return false;
  const uj = ujOf(lobby);
  const list = writers(lobby);
  if (list.length === 0 || !list.every((id) => uj.clues.has(id))) return false;
  openCheck(lobby);
  return true;
}

// Les doublons (« Mer » / « mers » / « marin » ≠ ; « chevaux » / « cheval » =) sont barrés automatiquement.
function openCheck(lobby) {
  const uj = ujOf(lobby);
  stopTimer(lobby);
  const entries = [...uj.clues].filter(([id]) => lobby.players.has(id));
  uj.auto = new Set();
  for (const [a, ca] of entries) {
    for (const [b, cb] of entries) if (a !== b && clashes(ca, cb)) uj.auto.add(a);
  }
  uj.cancelled = new Set(uj.auto);
  lobby.state = 'uj-check';
}

// Barrer / rétablir un indice à la main (tout le monde sauf le devineur).
export function toggleClue(lobby, playerId, { author } = {}) {
  if (lobby.game?.kind !== 'un-seul-indice' || lobby.state !== 'uj-check') throw new GameError('NOT_NOW', 'Ce n’est pas le moment.');
  const uj = ujOf(lobby);
  if (playerId === uj.guesser) throw new GameError('GUESSER', 'Pas touche, c’est toi qui devines 🙈');
  if (!uj.clues.has(author)) throw new GameError('INVALID', 'Indice inconnu.');
  if (uj.cancelled.has(author)) uj.cancelled.delete(author);
  else uj.cancelled.add(author);
}

export function confirmClues(lobby, playerId) {
  if (lobby.game?.kind !== 'un-seul-indice' || lobby.state !== 'uj-check') throw new GameError('NOT_NOW', 'Ce n’est pas le moment.');
  const uj = ujOf(lobby);
  if (playerId === uj.guesser) throw new GameError('GUESSER', 'Pas touche, c’est toi qui devines 🙈');
  openGuess(lobby);
}

function openGuess(lobby) {
  const uj = ujOf(lobby);
  lobby.state = 'uj-guess';
  setTimer(lobby, uj.settings.guess, () => reveal(lobby, null));
}

export function submitGuess(lobby, playerId, { index, text, pass = false } = {}) {
  if (lobby.game?.kind !== 'un-seul-indice' || lobby.state !== 'uj-guess') throw new GameError('NOT_NOW', 'Ce n’est pas le moment de deviner.');
  const uj = ujOf(lobby);
  if (index !== uj.index) throw new GameError('TOO_LATE', 'Trop tard !');
  if (playerId !== uj.guesser) throw new GameError('NOT_GUESSER', 'C’est le devineur qui répond.');
  if (pass) return reveal(lobby, null);
  const guess = clean(text);
  if (!guess) throw new GameError('EMPTY', 'Écris ta réponse (ou passe) 😉');
  reveal(lobby, guess);
}

function scoreRound(lobby, found) {
  const uj = ujOf(lobby);
  const gains = {};
  if (found) {
    if (lobby.players.has(uj.guesser)) gains[uj.guesser] = UJ_POINTS.guesser;
    for (const id of uj.clues.keys()) if (!uj.cancelled.has(id) && lobby.players.has(id)) gains[id] = UJ_POINTS.clue;
  }
  return gains;
}

function applyResult(lobby, found, { override = false } = {}) {
  const uj = ujOf(lobby);
  const { game } = lobby;
  const gains = scoreRound(lobby, found);
  for (const [id, n] of Object.entries(gains)) game.totals[id] = (game.totals[id] ?? 0) + n;
  if (found) uj.found += 1;
  const entry = { question: `Manche ${uj.index + 1} · ${uj.word.toUpperCase()} ${found ? '✅' : '❌'}`, topPlayerIds: found ? Object.keys(gains) : [] };
  if (override) game.history[game.history.length - 1] = entry;
  else game.history.push(entry);
  game.result = {
    type: 'un-seul-indice',
    word: uj.word,
    guesser: uj.guesser,
    guess: uj.guess,
    found,
    accepted: override,
    clues: [...uj.clues].filter(([id]) => lobby.players.has(id)).map(([playerId, text]) => ({ playerId, text, cancelled: uj.cancelled.has(playerId), auto: uj.auto.has(playerId) })),
    gains,
    team: { found: uj.found, played: uj.played },
    scores: { ...game.totals },
  };
}

export function reveal(lobby, guess) {
  const uj = ujOf(lobby);
  stopTimer(lobby);
  uj.guess = guess;
  uj.played += 1;
  applyResult(lobby, Boolean(guess) && isFound(guess, uj.word));
  lobby.state = 'uj-reveal';
}

// L'hôte accepte une réponse jugée juste (synonyme, orthographe…) que le jeu a refusée.
export function accept(lobby) {
  if (lobby.game?.kind !== 'un-seul-indice' || lobby.state !== 'uj-reveal') throw new GameError('NOT_NOW', 'Ce n’est pas le moment.');
  const r = lobby.game.result;
  if (r.found || !r.guess) throw new GameError('INVALID', 'Rien à accepter.');
  applyResult(lobby, true, { override: true });
}

export function next(lobby) {
  const uj = ujOf(lobby);
  uj.index += 1;
  openRound(lobby);
  return lobby.state === 'finished' ? 'finish' : 'next';
}

export function hostSkip(lobby) {
  if (lobby.state === 'uj-clue') return openCheck(lobby);
  if (lobby.state === 'uj-check') return openGuess(lobby);
  if (lobby.state === 'uj-guess') return reveal(lobby, null);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

export function progress(lobby) {
  const uj = ujOf(lobby);
  if (['uj-clue', 'uj-check', 'uj-guess'].includes(lobby.state) && !isConnected(lobby, uj.guesser)) {
    // Le devineur est parti : manche annulée, on passe à la suivante.
    stopTimer(lobby);
    lobby.game.history.push({ question: `Manche ${uj.index + 1} · ${uj.word.toUpperCase()} (devineur parti)`, topPlayerIds: [] });
    uj.index += 1;
    openRound(lobby);
    return true;
  }
  if (lobby.state === 'uj-clue') return checkAllClues(lobby);
  return false;
}

export function playerGone(lobby, playerId) {
  const uj = lobby.game.uj;
  if (lobby.state === 'uj-clue') uj.clues.delete(playerId);
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function ujPublic(lobby, viewerId) {
  const uj = lobby.game?.uj;
  if (!uj || !lobby.state.startsWith('uj-')) return null;
  const isGuesser = viewerId !== null && viewerId === uj.guesser;
  const live = [...uj.clues].filter(([id]) => lobby.players.has(id));
  let clues = [];
  if (lobby.state === 'uj-check' && !isGuesser) clues = live.map(([playerId, text]) => ({ playerId, text, cancelled: uj.cancelled.has(playerId), auto: uj.auto.has(playerId) }));
  if (lobby.state === 'uj-guess') clues = live.filter(([id]) => isGuesser ? !uj.cancelled.has(id) : true).map(([playerId, text]) => ({ playerId, text, cancelled: uj.cancelled.has(playerId) }));
  return {
    phase: lobby.state,
    index: uj.index,
    total: lobby.game.totalRounds,
    guesser: uj.guesser,
    isGuesser,
    // Le mot : jamais pour le devineur avant la révélation.
    word: isGuesser && lobby.state !== 'uj-reveal' ? null : uj.word,
    myClue: uj.clues.get(viewerId) ?? null,
    doneIds: lobby.state === 'uj-clue' ? live.map(([id]) => id) : [],
    clueCount: live.length,
    keptCount: live.filter(([id]) => !uj.cancelled.has(id)).length,
    clues,
    team: { found: uj.found, played: uj.played },
    deadline: uj.deadline,
    timer: uj.timer,
    serverNow: Date.now(),
  };
}

export function ujLimits(lobby) {
  const n = lobby.connectedPlayers.length;
  return { minPlayers: MIN_PLAYERS, turns: [...UJ_LIMITS.turns], clue: [...UJ_LIMITS.clue], guess: [...UJ_LIMITS.guess], points: { ...UJ_POINTS }, players: n, words: (lobby.ujBank ?? getWordBank()).size };
}

export function defaultSettings() {
  return { ...UJ_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { ujTurns, ujClue, ujGuess }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (ujTurns !== undefined) next.turns = pickFrom(UJ_LIMITS.turns, ujTurns, 'Nombre de tours');
  if (ujClue !== undefined) next.clue = pickFrom(UJ_LIMITS.clue, ujClue, 'Temps pour l’indice');
  if (ujGuess !== undefined) next.guess = pickFrom(UJ_LIMITS.guess, ujGuess, 'Temps pour deviner');
  return next;
}
