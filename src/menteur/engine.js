import { randomInt, randomUUID } from 'node:crypto';
import { GameError } from '../game/errors.js';

/**
 * Menteur ! (2 vérités, 1 mensonge).
 *   mt-write  : tout le monde écrit en même temps 3 affirmations sur lui et coche celle qui est fausse (chrono)
 *   mt-vote   : un joueur est sur la sellette (chacun son tour) ; ses 3 affirmations sont mélangées,
 *               les autres votent pour le mensonge (il peut raconter des anecdotes à voix haute pour embrouiller)
 *   mt-reveal : le mensonge, qui l'a trouvé, les points → joueur suivant → … → finished
 * Points : +2 si tu trouves le mensonge, +1 au menteur pour chaque joueur trompé.
 * Le mensonge n'est envoyé qu'à son auteur avant la révélation.
 */

export const MIN_PLAYERS = 3;
export const MT_POINTS = Object.freeze({ found: 2, fooled: 1 });
export const MT_LIMITS = Object.freeze({
  write: [90, 120, 180, 240],
  vote: [20, 30, 45, 60],
  defaults: { write: 180, vote: 30 },
});
const TEXT_MAX = 90;
const GRACE_MS = 1_000;

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const clean = (raw) => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX) : '');
const keyOf = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// --- Déroulé de la partie -------------------------------------------------------------------------------

const mtOf = (lobby) => lobby.game.mt;

function setTimer(lobby, seconds, fn) {
  const mt = mtOf(lobby);
  lobby.clearQuizTimer();
  const token = ++mt.token;
  mt.timer = seconds;
  mt.deadline = Date.now() + seconds * 1000;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.mt !== mt || mt.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, seconds * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

function stopTimer(lobby) {
  const mt = mtOf(lobby);
  lobby.clearQuizTimer();
  mt.token += 1;
  mt.deadline = null;
}

export function startMenteur(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  const settings = { ...lobby.settings.menteur };
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: lobby.connectedPlayers.length,
    mt: { settings, token: 0, deadline: null, timer: 0, sheets: new Map(), order: [], index: 0, subject: null, cards: [], votes: new Map(), fooled: {} },
  };
  lobby.state = 'mt-write';
  setTimer(lobby, settings.write, () => startVotes(lobby));
}

// Les 3 affirmations d'un joueur + l'indice (0, 1 ou 2) de celle qui est fausse.
export function submitSheet(lobby, playerId, { statements, lie } = {}) {
  if (lobby.game?.kind !== 'menteur' || lobby.state !== 'mt-write') throw new GameError('NOT_NOW', 'Ce n’est plus le moment d’écrire.');
  const list = Array.isArray(statements) ? statements.map(clean) : [];
  if (list.length !== 3 || list.some((s) => !s)) throw new GameError('INCOMPLETE', 'Écris tes 3 affirmations 😉');
  if (new Set(list.map(keyOf)).size !== 3) throw new GameError('DUPLICATE', 'Tes 3 affirmations doivent être différentes.');
  const lieIndex = Number.parseInt(lie, 10);
  if (![0, 1, 2].includes(lieIndex)) throw new GameError('NO_LIE', 'Coche celle qui est fausse 🤥');
  mtOf(lobby).sheets.set(playerId, { statements: list, lie: lieIndex });
  checkAllWritten(lobby);
}

function checkAllWritten(lobby) {
  if (lobby.state !== 'mt-write') return false;
  const mt = mtOf(lobby);
  const players = lobby.connectedPlayers;
  if (players.length === 0 || !players.every((p) => mt.sheets.has(p.id))) return false;
  startVotes(lobby);
  return true;
}

// Fin de l'écriture : on passe chaque joueur qui a écrit sur la sellette, dans un ordre au hasard.
function startVotes(lobby) {
  const mt = mtOf(lobby);
  stopTimer(lobby);
  mt.order = shuffle([...mt.sheets.keys()].filter((id) => lobby.players.has(id)));
  lobby.game.totalRounds = mt.order.length;
  mt.index = 0;
  if (mt.order.length < 2) {
    finish(lobby);
    return;
  }
  openVote(lobby);
}

function finish(lobby) {
  const mt = mtOf(lobby);
  stopTimer(lobby);
  lobby.game.index = lobby.game.totalRounds;
  lobby.finish();
  const best = Object.entries(mt.fooled).sort((a, b) => b[1] - a[1])[0];
  lobby.game.final.mt = { bestLiar: best && best[1] > 0 ? { playerId: best[0], fooled: best[1] } : null };
}

function openVote(lobby) {
  const mt = mtOf(lobby);
  // On saute les joueurs partis entre-temps.
  while (mt.index < mt.order.length && !lobby.players.has(mt.order[mt.index])) mt.index += 1;
  if (mt.index >= mt.order.length) return finish(lobby);
  mt.subject = mt.order[mt.index];
  const sheet = mt.sheets.get(mt.subject);
  mt.cards = shuffle(sheet.statements.map((text, i) => ({ id: randomUUID().slice(0, 8), text, lie: i === sheet.lie })));
  mt.votes = new Map();
  lobby.game.index = mt.index;
  lobby.game.result = null;
  lobby.state = 'mt-vote';
  setTimer(lobby, mt.settings.vote, () => reveal(lobby));
}

const voters = (lobby) => lobby.connectedPlayers.map((p) => p.id).filter((id) => id !== mtOf(lobby).subject);

export function vote(lobby, playerId, { cardId } = {}) {
  if (lobby.game?.kind !== 'menteur' || lobby.state !== 'mt-vote') throw new GameError('NOT_NOW', 'Le vote est terminé.');
  const mt = mtOf(lobby);
  if (playerId === mt.subject) throw new GameError('SUBJECT', 'Tu connais la réponse, toi 😏');
  if (!mt.cards.some((c) => c.id === cardId)) throw new GameError('INVALID_VOTE', 'Affirmation inconnue.');
  mt.votes.set(playerId, cardId);
  checkAllVoted(lobby);
}

function checkAllVoted(lobby) {
  if (lobby.state !== 'mt-vote') return false;
  const mt = mtOf(lobby);
  const list = voters(lobby);
  if (list.length === 0 || !list.every((id) => mt.votes.has(id))) return false;
  reveal(lobby);
  return true;
}

export function reveal(lobby) {
  const mt = mtOf(lobby);
  const { game } = lobby;
  stopTimer(lobby);
  const lie = mt.cards.find((c) => c.lie);
  const live = [...mt.votes].filter(([id]) => lobby.players.has(id));
  const finders = live.filter(([, cardId]) => cardId === lie.id).map(([id]) => id);
  const fooled = live.filter(([, cardId]) => cardId !== lie.id).map(([id]) => id);
  const gains = {};
  for (const id of finders) gains[id] = MT_POINTS.found;
  if (fooled.length && lobby.players.has(mt.subject)) gains[mt.subject] = fooled.length * MT_POINTS.fooled;
  for (const [id, n] of Object.entries(gains)) game.totals[id] = (game.totals[id] ?? 0) + n;
  mt.fooled[mt.subject] = (mt.fooled[mt.subject] ?? 0) + fooled.length;
  game.history.push({ question: `${lobby.players.get(mt.subject)?.name ?? '?'} · « ${lie.text} »`, topPlayerIds: finders });
  game.result = {
    type: 'menteur',
    subject: mt.subject,
    cards: mt.cards.map((c) => ({ id: c.id, text: c.text, lie: c.lie, voters: live.filter(([, v]) => v === c.id).map(([id]) => id) })),
    finders,
    fooled,
    gains,
    scores: { ...game.totals },
  };
  lobby.state = 'mt-reveal';
}

export function next(lobby) {
  const mt = mtOf(lobby);
  mt.index += 1;
  if (mt.index >= mt.order.length) {
    finish(lobby);
    return 'finish';
  }
  openVote(lobby);
  return lobby.state === 'finished' ? 'finish' : 'next';
}

export function hostSkip(lobby) {
  if (lobby.state === 'mt-write') return startVotes(lobby);
  if (lobby.state === 'mt-vote') return reveal(lobby);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

export function progress(lobby) {
  if (lobby.state === 'mt-write') return checkAllWritten(lobby);
  if (lobby.state === 'mt-vote') return checkAllVoted(lobby);
  return false;
}

export function playerGone(lobby, playerId) {
  const mt = lobby.game.mt;
  mt.votes.delete(playerId);
  if (lobby.state === 'mt-write') mt.sheets.delete(playerId);
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function mtPublic(lobby, viewerId) {
  const mt = lobby.game?.mt;
  if (!mt || !lobby.state.startsWith('mt-')) return null;
  const isSubject = viewerId !== null && viewerId === mt.subject;
  const mine = mt.sheets.get(viewerId) ?? null;
  const voting = lobby.state === 'mt-vote';
  return {
    phase: lobby.state,
    index: mt.index,
    total: lobby.game.totalRounds,
    mySheet: lobby.state === 'mt-write' ? mine : null,
    doneIds: lobby.state === 'mt-write' ? [...mt.sheets.keys()].filter((id) => lobby.players.has(id)) : [],
    subject: voting || lobby.state === 'mt-reveal' ? mt.subject : null,
    isSubject,
    // Le mensonge : seulement pour son auteur pendant le vote.
    cards: voting ? mt.cards.map((c) => ({ id: c.id, text: c.text, ...(isSubject ? { lie: c.lie } : {}) })) : [],
    myVote: mt.votes.get(viewerId) ?? null,
    votedIds: voting ? [...mt.votes.keys()].filter((id) => lobby.players.has(id)) : [],
    deadline: mt.deadline,
    timer: mt.timer,
    serverNow: Date.now(),
  };
}

export function mtLimits(lobby) {
  return { minPlayers: MIN_PLAYERS, write: [...MT_LIMITS.write], vote: [...MT_LIMITS.vote], points: { ...MT_POINTS }, players: lobby.connectedPlayers.length };
}

export function defaultSettings() {
  return { ...MT_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { mtWrite, mtVote }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (mtWrite !== undefined) next.write = pickFrom(MT_LIMITS.write, mtWrite, 'Temps d’écriture');
  if (mtVote !== undefined) next.vote = pickFrom(MT_LIMITS.vote, mtVote, 'Temps de vote');
  return next;
}
