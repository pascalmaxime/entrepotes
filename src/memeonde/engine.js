import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError } from '../game/errors.js';

/**
 * Sur la même onde (façon Wavelength) : une échelle entre deux extrêmes (« Froid ↔ Chaud »), une cible cachée.
 *   om-clue   : le médium (chacun son tour) voit la cible et donne un indice (« une raclette »)
 *   om-guess  : les autres placent leur curseur sur l'échelle (chrono)
 *   om-reveal : la cible, les curseurs de chacun, les points → tour suivant → … → finished
 * Points : 4 en plein dans le mille (±4), 3 tout près (±10), 2 pas loin (±17), 0 sinon.
 * Le médium gagne la moyenne des points des autres : il a intérêt à donner un bon indice.
 * La cible n'est envoyée qu'au médium, jusqu'à la révélation.
 */

export const MIN_PLAYERS = 3;
export const OM_ZONES = Object.freeze([
  { within: 4, points: 4 },
  { within: 10, points: 3 },
  { within: 17, points: 2 },
]);
export const OM_LIMITS = Object.freeze({
  turns: [1, 2, 3], // chaque joueur est médium N fois
  clue: [30, 60, 90],
  guess: [20, 30, 45, 60],
  defaults: { turns: 1, clue: 60, guess: 30 },
});
const CLUE_MAX = 40;
const GRACE_MS = 1_000;
export const SCALES_FILE = fileURLToPath(new URL('../../data/memeonde.json', import.meta.url));

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function pointsFor(position, target) {
  const d = Math.abs(position - target);
  return OM_ZONES.find((z) => d <= z.within)?.points ?? 0;
}

export function cleanClue(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CLUE_MAX);
}

// --- Échelles (data/memeonde.json, relu automatiquement s'il change) ----------------------------------------

function parseScales(raw) {
  const data = JSON.parse(raw);
  const list = (Array.isArray(data.echelles) ? data.echelles : [])
    .filter((s) => Array.isArray(s) && s.length === 2 && s.every((x) => typeof x === 'string' && x.trim()))
    .map(([left, right]) => ({ key: `${left.trim()}|${right.trim()}`, left: left.trim(), right: right.trim() }));
  if (list.length === 0) throw new Error('Aucune échelle valide.');
  return list;
}

export function createScaleBank(scales) {
  let list = [...scales];
  return {
    get size() {
      return list.length;
    },
    replace(next) {
      list = [...next];
    },
    pick(used = new Set()) {
      let fresh = list.filter((s) => !used.has(s.key));
      if (fresh.length === 0) {
        for (const s of list) used.delete(s.key);
        fresh = list;
      }
      const scale = fresh[randomInt(fresh.length)];
      used.add(scale.key);
      return scale;
    },
  };
}

export function loadScaleBank(file = SCALES_FILE) {
  let mtime = statSync(file).mtimeMs;
  const bank = createScaleBank(parseScales(readFileSync(file, 'utf8')));
  const basePick = bank.pick;
  bank.pick = (used) => {
    try {
      const current = statSync(file).mtimeMs;
      if (current !== mtime) {
        bank.replace(parseScales(readFileSync(file, 'utf8')));
        mtime = current;
        console.log(`[meme-onde] Fichier rechargé (${bank.size} échelles).`);
      }
    } catch (error) {
      console.warn('[meme-onde] Rechargement impossible, on garde la version précédente :', error.message);
    }
    return basePick(used);
  };
  return bank;
}

let sharedBank = null;
export function getBank() {
  if (!sharedBank) sharedBank = loadScaleBank();
  return sharedBank;
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const omOf = (lobby) => lobby.game.om;
const isConnected = (lobby, id) => Boolean(lobby.players.get(id)?.connected);
const guessers = (lobby) => lobby.connectedPlayers.filter((p) => p.id !== omOf(lobby).medium).map((p) => p.id);

function setTimer(lobby, seconds, fn) {
  const om = omOf(lobby);
  lobby.clearQuizTimer();
  const token = ++om.token;
  om.deadline = Date.now() + seconds * 1000;
  om.timer = seconds;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.om !== om || om.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, seconds * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

export function startMemeOnde(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  lobby.omBank ??= getBank();
  lobby.usedOmScales ??= new Set();
  const settings = { ...lobby.settings.memeOnde };
  const order = shuffle(lobby.connectedPlayers.map((p) => p.id));
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: order.length * settings.turns,
    om: { settings, order, index: 0, token: 0, deadline: null, timer: 0, medium: null, scale: null, target: null, clue: null, guesses: new Map(), bestShot: null },
  };
  openRound(lobby);
}

function openRound(lobby) {
  const om = omOf(lobby);
  const { game } = lobby;
  // Le médium de ce tour ; s'il n'est plus là, on passe au tour suivant.
  while (om.index < game.totalRounds && !isConnected(lobby, om.order[om.index % om.order.length])) om.index += 1;
  if (om.index >= game.totalRounds) {
    game.index = game.totalRounds;
    lobby.finish();
    lobby.game.final.om = { bestShot: om.bestShot };
    return;
  }
  om.medium = om.order[om.index % om.order.length];
  om.scale = lobby.omBank.pick(lobby.usedOmScales);
  om.target = 3 + randomInt(95); // 3 à 97 : la cible n'est jamais collée au bord
  om.clue = null;
  om.guesses = new Map();
  game.index = om.index;
  game.result = null;
  lobby.state = 'om-clue';
  setTimer(lobby, om.settings.clue, () => skipRound(lobby));
}

// Le médium n'a rien donné (absent, chrono) : on passe au tour suivant sans points.
function skipRound(lobby) {
  const om = omOf(lobby);
  lobby.game.history.push({ question: `Tour ${om.index + 1} · ${om.scale.left} ↔ ${om.scale.right} : pas d’indice`, topPlayerIds: [] });
  om.index += 1;
  openRound(lobby);
}

export function submitClue(lobby, playerId, { text } = {}) {
  if (lobby.game?.kind !== 'meme-onde' || lobby.state !== 'om-clue') throw new GameError('NOT_NOW', 'Ce n’est pas le moment de donner un indice.');
  const om = omOf(lobby);
  if (playerId !== om.medium) throw new GameError('NOT_MEDIUM', 'C’est le médium qui donne l’indice.');
  const clue = cleanClue(text);
  if (!clue) throw new GameError('EMPTY', 'Écris un indice 😉');
  om.clue = clue;
  lobby.state = 'om-guess';
  setTimer(lobby, om.settings.guess, () => reveal(lobby));
}

// Un joueur place (ou déplace) son curseur, jusqu'à la révélation.
export function submitGuess(lobby, playerId, { index, position } = {}) {
  if (lobby.game?.kind !== 'meme-onde' || lobby.state !== 'om-guess') throw new GameError('NOT_NOW', 'Ce n’est plus le moment de jouer.');
  const om = omOf(lobby);
  if (index !== om.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la suite !');
  if (playerId === om.medium) throw new GameError('MEDIUM', 'Tu connais la réponse, toi 😏');
  const value = Number(position);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new GameError('INVALID', 'Position invalide.');
  om.guesses.set(playerId, Math.round(value));
  checkAllGuessed(lobby);
}

function checkAllGuessed(lobby) {
  if (lobby.state !== 'om-guess') return false;
  const om = omOf(lobby);
  const list = guessers(lobby);
  if (list.length === 0 || !list.every((id) => om.guesses.has(id))) return false;
  reveal(lobby);
  return true;
}

export function reveal(lobby) {
  const om = omOf(lobby);
  const { game } = lobby;
  lobby.clearQuizTimer();
  om.token += 1;
  om.deadline = null;
  const gains = {};
  const shots = [];
  for (const [id, position] of om.guesses) {
    if (!lobby.players.has(id)) continue;
    const points = pointsFor(position, om.target);
    shots.push({ playerId: id, position, points, distance: Math.abs(position - om.target) });
    if (points) gains[id] = points;
  }
  shots.sort((a, b) => a.distance - b.distance);
  // Le médium : la moyenne des points des autres (arrondie).
  const mediumPoints = shots.length ? Math.round(shots.reduce((s, x) => s + x.points, 0) / shots.length) : 0;
  if (mediumPoints && lobby.players.has(om.medium)) gains[om.medium] = mediumPoints;
  for (const [id, n] of Object.entries(gains)) game.totals[id] = (game.totals[id] ?? 0) + n;
  const best = shots[0];
  if (best && (!om.bestShot || best.distance < om.bestShot.distance)) om.bestShot = { playerId: best.playerId, distance: best.distance, clue: om.clue, scale: om.scale, medium: om.medium };
  game.history.push({
    question: `Tour ${om.index + 1} · « ${om.clue} » (${om.scale.left} ↔ ${om.scale.right})`,
    topPlayerIds: shots.filter((s) => s.points === 4).map((s) => s.playerId),
  });
  game.result = {
    type: 'meme-onde',
    scale: om.scale,
    target: om.target,
    clue: om.clue,
    medium: om.medium,
    mediumPoints,
    shots,
    gains,
    scores: { ...game.totals },
  };
  lobby.state = 'om-reveal';
}

export function next(lobby) {
  const om = omOf(lobby);
  om.index += 1;
  openRound(lobby);
  return lobby.state === 'finished' ? 'finish' : 'next';
}

export function hostSkip(lobby) {
  if (lobby.state === 'om-clue') return skipRound(lobby);
  if (lobby.state === 'om-guess') return reveal(lobby);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

export function progress(lobby) {
  if (lobby.state === 'om-clue' && !isConnected(lobby, omOf(lobby).medium)) {
    skipRound(lobby);
    return true;
  }
  if (lobby.state === 'om-guess') return checkAllGuessed(lobby);
  return false;
}

export function playerGone(lobby, playerId) {
  lobby.game.om.guesses.delete(playerId);
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function omPublic(lobby, viewerId) {
  const om = lobby.game?.om;
  if (!om || !lobby.state.startsWith('om-')) return null;
  const isMedium = viewerId !== null && viewerId === om.medium;
  return {
    phase: lobby.state,
    index: om.index,
    total: lobby.game.totalRounds,
    medium: om.medium,
    isMedium,
    scale: om.scale,
    // La cible : seulement pour le médium (tout le monde la voit à la révélation, dans result).
    target: isMedium && lobby.state !== 'om-reveal' ? om.target : null,
    clue: om.clue,
    myGuess: om.guesses.get(viewerId) ?? null,
    doneIds: [...om.guesses.keys()].filter((id) => lobby.players.has(id)),
    zones: OM_ZONES.map((z) => ({ ...z })),
    deadline: om.deadline,
    timer: om.timer,
    serverNow: Date.now(),
  };
}

export function omLimits(lobby) {
  const bank = lobby.omBank ?? getBank();
  return {
    minPlayers: MIN_PLAYERS,
    turns: [...OM_LIMITS.turns],
    clue: [...OM_LIMITS.clue],
    guess: [...OM_LIMITS.guess],
    zones: OM_ZONES.map((z) => ({ ...z })),
    scales: bank.size,
    players: lobby.connectedPlayers.length,
  };
}

export function defaultSettings() {
  return { ...OM_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { omTurns, omClue, omGuess }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (omTurns !== undefined) next.turns = pickFrom(OM_LIMITS.turns, omTurns, 'Nombre de tours');
  if (omClue !== undefined) next.clue = pickFrom(OM_LIMITS.clue, omClue, 'Temps pour l’indice');
  if (omGuess !== undefined) next.guess = pickFrom(OM_LIMITS.guess, omGuess, 'Temps pour viser');
  return next;
}
