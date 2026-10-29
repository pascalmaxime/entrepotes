import { randomInt } from 'node:crypto';
import { GameError } from '../game/errors.js';
import { CLUE_MAX, IMPOSTOR_POINTS, effectiveRoles } from '../game/modes/imposteur.js';
import { isCloseEnough, normalize } from '../mculture/match.js';

/**
 * Déroulé d'une manche de L'Imposteur (lobby.state) :
 *   reveal (chacun découvre son mot) → clues (un indice chacun) → ballot (vote)
 *   → elimination (rôle révélé, Mr. White tente le mot) → clues… → round-end → … → finished
 * Les rôles et les mots ne sont JAMAIS envoyés aux autres joueurs avant la fin de la manche
 * (sauf le rôle d'un joueur éliminé). Les civils et l'imposteur ne savent pas qui ils sont.
 */

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const ROLE_LABEL = { civil: 'Civil', impostor: 'Imposteur', white: 'Mr. White' };

export function startImpostorGame(lobby, base) {
  lobby.game = { ...base, totalRounds: lobby.settings.rounds, clueMode: lobby.settings.impostor.clueMode, manche: null };
  startManche(lobby);
}

function startManche(lobby) {
  const ids = shuffle(lobby.playerIds);
  const { impostors, whites } = effectiveRoles(lobby.settings.impostor, ids.length);
  const roles = new Map();
  ids.forEach((id, i) => roles.set(id, i < whites ? 'white' : i < whites + impostors ? 'impostor' : 'civil'));
  const words = lobby.wordBank.pick(lobby.usedPairs);
  lobby.game.manche = {
    words,
    roles,
    composition: { civils: ids.length - impostors - whites, impostors, whites },
    alive: new Set(ids),
    eliminated: [], // [{ playerId, role }] dans l'ordre
    ready: new Set(),
    tour: 0,
    order: [],
    turn: 0,
    clues: [], // par tour : [{ playerId, text }]
    votes: new Map(),
    candidates: null,
    revote: false,
    elimination: null,
    outcome: null,
  };
  lobby.state = 'reveal';
}

const manche = (lobby) => lobby.game.manche;
const connected = (lobby, id) => Boolean(lobby.players.get(id)?.connected);

export function wordOf(lobby, playerId) {
  const m = manche(lobby);
  const role = m.roles.get(playerId);
  if (role === 'civil') return m.words.civil;
  if (role === 'impostor') return m.words.impostor;
  return null;
}

// --- Découverte du mot -----------------------------------------------------------------

export function markReady(lobby, playerId) {
  if (lobby.state !== 'reveal') throw new GameError('NOT_REVEAL', 'La manche a déjà commencé.');
  if (!manche(lobby).roles.has(playerId)) throw new GameError('NOT_PLAYING', 'Tu ne joues pas cette manche.');
  manche(lobby).ready.add(playerId);
  checkImpostorProgress(lobby);
}

function startTour(lobby) {
  const m = manche(lobby);
  m.tour += 1;
  let order = shuffle([...m.alive]);
  // Mr. White ne commence jamais (il n'a aucun indice à copier).
  if (order.length > 1 && m.roles.get(order[0]) === 'white') {
    const swap = order.findIndex((id) => m.roles.get(id) !== 'white');
    if (swap > 0) [order[0], order[swap]] = [order[swap], order[0]];
  }
  m.order = order;
  m.turn = 0;
  m.clues.push([]);
  m.votes = new Map();
  m.candidates = null;
  m.revote = false;
  m.elimination = null;
  lobby.state = 'clues';
  skipAbsent(lobby);
}

// Passe les joueurs déconnectés ; à l'écrit, va au vote quand tout le monde est passé.
function skipAbsent(lobby) {
  const m = manche(lobby);
  if (lobby.game.clueMode !== 'ecrit') return;
  while (m.turn < m.order.length && !connected(lobby, m.order[m.turn])) m.turn += 1;
  if (m.turn >= m.order.length) startBallot(lobby);
}

export function currentSpeaker(lobby) {
  const m = manche(lobby);
  return lobby.state === 'clues' ? (m.order[m.turn] ?? null) : null;
}

// --- Indices --------------------------------------------------------------------------------

export function submitClue(lobby, playerId, rawText) {
  if (lobby.state !== 'clues') throw new GameError('NOT_CLUES', 'Ce n’est pas le moment des indices.');
  if (lobby.game.clueMode !== 'ecrit') throw new GameError('ORAL_MODE', 'Les indices se donnent à l’oral dans cette partie.');
  if (currentSpeaker(lobby) !== playerId) throw new GameError('NOT_YOUR_TURN', 'Ce n’est pas ton tour.');
  const text = typeof rawText === 'string' ? rawText.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CLUE_MAX) : '';
  if (!text) throw new GameError('EMPTY_CLUE', 'Écris un indice.');
  const word = wordOf(lobby, playerId);
  const compact = (value) => normalize(value).replace(/ /g, '');
  if (word && (compact(text) === compact(word) || (compact(word).length >= 4 && compact(text).includes(compact(word))))) {
    throw new GameError('CLUE_IS_WORD', 'Tu ne peux pas donner ton mot, trouve un indice 😉');
  }
  const m = manche(lobby);
  m.clues.at(-1).push({ playerId, text });
  m.turn += 1;
  skipAbsent(lobby);
}

// --- Vote -----------------------------------------------------------------------------------

function startBallot(lobby) {
  const m = manche(lobby);
  m.votes = new Map();
  m.candidates = m.candidates ?? [...m.alive];
  lobby.state = 'ballot';
}

function voters(lobby) {
  const m = manche(lobby);
  return [...m.alive].filter((id) => connected(lobby, id));
}

export function submitImpostorVote(lobby, playerId, targetId) {
  if (lobby.state !== 'ballot') throw new GameError('NOT_VOTING', 'Ce n’est pas le moment de voter.');
  const m = manche(lobby);
  if (!m.alive.has(playerId)) throw new GameError('ELIMINATED', 'Tu es éliminé : tu regardes la suite 👀');
  if (targetId === playerId) throw new GameError('INVALID_VOTE', 'Tu ne peux pas voter contre toi.');
  if (!m.candidates.includes(targetId) || !m.alive.has(targetId)) throw new GameError('INVALID_VOTE', 'Vote invalide.');
  m.votes.set(playerId, targetId);
  checkImpostorProgress(lobby);
}

function tally(lobby) {
  const m = manche(lobby);
  const counts = new Map(m.candidates.filter((id) => m.alive.has(id)).map((id) => [id, 0]));
  for (const target of m.votes.values()) if (counts.has(target)) counts.set(target, counts.get(target) + 1);
  return [...counts].map(([playerId, votes]) => ({ playerId, votes })).sort((a, b) => b.votes - a.votes);
}

function revealBallot(lobby) {
  const m = manche(lobby);
  const results = tally(lobby);
  const top = results[0]?.votes ?? 0;
  const tied = results.filter((r) => r.votes === top).map((r) => r.playerId);
  if (tied.length > 1 || top === 0) {
    if (!m.revote && tied.length > 1) {
      // Égalité : on revote, seulement entre les ex aequo.
      m.candidates = tied;
      m.revote = true;
      m.lastTie = { results, tied };
      startBallot(lobby);
      return;
    }
    m.elimination = { playerId: null, role: null, results, tie: true, awaitingGuess: false, guess: null };
    lobby.state = 'elimination';
    return;
  }
  eliminate(lobby, tied[0], results);
}

function eliminate(lobby, playerId, results) {
  const m = manche(lobby);
  const role = m.roles.get(playerId);
  m.alive.delete(playerId);
  m.eliminated.push({ playerId, role });
  m.elimination = { playerId, role, results, tie: false, awaitingGuess: role === 'white', guess: null };
  lobby.state = 'elimination';
  if (role !== 'white') settleOutcome(lobby);
}

// Mr. White éliminé : il a une chance de trouver le mot des civils.
export function submitGuess(lobby, playerId, rawText) {
  const m = manche(lobby);
  if (lobby.state !== 'elimination' || !m.elimination?.awaitingGuess) throw new GameError('NO_GUESS', 'Pas de mot à deviner maintenant.');
  if (m.elimination.playerId !== playerId) throw new GameError('NOT_WHITE', 'Seul Mr. White peut tenter le mot.');
  const text = typeof rawText === 'string' ? rawText.replace(/\s+/g, ' ').trim().slice(0, CLUE_MAX) : '';
  if (!text) throw new GameError('EMPTY_GUESS', 'Écris le mot des civils.');
  const correct = isCloseEnough(text, m.words.civil);
  m.elimination.awaitingGuess = false;
  m.elimination.guess = { text, correct };
  if (correct) setOutcome(lobby, 'white', [playerId]);
  else settleOutcome(lobby);
}

// Victoire : plus aucun méchant → civils ; un seul civil (ou moins) encore en vie → infiltrés.
function settleOutcome(lobby) {
  const m = manche(lobby);
  if (m.outcome) return true;
  const alive = [...m.alive];
  const badAlive = alive.filter((id) => m.roles.get(id) !== 'civil').length;
  const civilsAlive = alive.length - badAlive;
  const team = (roles) => [...m.roles].filter(([, role]) => roles.includes(role)).map(([id]) => id);
  if (badAlive === 0) return setOutcome(lobby, 'civils', team(['civil']));
  if (civilsAlive <= 1) return setOutcome(lobby, 'infiltres', team(['impostor', 'white']));
  return false;
}

function setOutcome(lobby, winner, winners) {
  const m = manche(lobby);
  const { game } = lobby;
  const points = {};
  for (const id of winners) {
    const role = m.roles.get(id);
    if (winner === 'white') points[id] = IMPOSTOR_POINTS.whiteGuess;
    else if (role === 'civil') points[id] = IMPOSTOR_POINTS.civil;
    else if (role === 'impostor') points[id] = IMPOSTOR_POINTS.impostor;
    else points[id] = IMPOSTOR_POINTS.white;
  }
  for (const [id, n] of Object.entries(points)) game.totals[id] = (game.totals[id] ?? 0) + n;
  m.outcome = { winner, winners, points };
  game.history.push({
    question: `Manche ${game.index + 1} · ${m.words.civil} / ${m.words.impostor}`,
    topPlayerIds: winners.filter((id) => lobby.players.has(id)),
  });
  return true;
}

// --- Commandes de l'hôte -----------------------------------------------------------------------

// « Passer » : lancer les indices sans attendre / indice suivant / passer au vote / révéler le vote
// / Mr. White n'a pas répondu.
export function impostorForce(lobby) {
  const m = manche(lobby);
  switch (lobby.state) {
    case 'reveal':
      startTour(lobby);
      return;
    case 'clues':
      if (lobby.game.clueMode === 'oral') startBallot(lobby);
      else {
        m.turn += 1;
        skipAbsent(lobby);
      }
      return;
    case 'ballot':
      if (m.votes.size === 0) throw new GameError('NO_VOTES', 'Personne n’a encore voté.');
      revealBallot(lobby);
      return;
    case 'elimination':
      if (!m.elimination?.awaitingGuess) throw new GameError('NOTHING', 'Rien à passer.');
      m.elimination.awaitingGuess = false;
      m.elimination.guess = { text: '', correct: false };
      settleOutcome(lobby);
      return;
    default:
      throw new GameError('NOTHING', 'Rien à passer pour le moment.');
  }
}

// « Continuer » après une élimination ou une fin de manche.
export function impostorNext(lobby) {
  const m = manche(lobby);
  if (lobby.state === 'elimination') {
    if (m.elimination?.awaitingGuess) throw new GameError('WAIT_GUESS', 'Mr. White doit d’abord tenter sa chance.');
    if (m.outcome) lobby.state = 'round-end';
    else startTour(lobby);
    return 'continue';
  }
  if (lobby.state === 'round-end') {
    if (lobby.game.index + 1 >= lobby.game.totalRounds) return 'finish';
    lobby.game.index += 1;
    startManche(lobby);
    return 'continue';
  }
  throw new GameError('NOT_NOW', 'Pas encore !');
}

// --- Avancement automatique (votes complets, joueur parti…) ------------------------------------

export function checkImpostorProgress(lobby) {
  const m = manche(lobby);
  if (!m) return false;
  if (lobby.state === 'reveal') {
    const players = lobby.connectedPlayers.filter((p) => m.roles.has(p.id));
    if (players.length && players.every((p) => m.ready.has(p.id))) {
      startTour(lobby);
      return true;
    }
  } else if (lobby.state === 'clues') {
    const before = m.turn;
    skipAbsent(lobby);
    return lobby.state !== 'clues' || m.turn !== before;
  } else if (lobby.state === 'ballot') {
    const list = voters(lobby).filter((id) => m.candidates.some((c) => c !== id));
    if (list.length && list.every((id) => m.votes.has(id))) {
      revealBallot(lobby);
      return true;
    }
  }
  return false;
}

// Joueur supprimé de la partie (parti, ou absent depuis trop longtemps).
export function impostorPlayerGone(lobby, playerId) {
  const m = manche(lobby);
  if (!m || !m.roles.has(playerId)) return;
  const wasAlive = m.alive.delete(playerId);
  m.ready.delete(playerId);
  m.votes.delete(playerId);
  for (const [voter, target] of m.votes) if (target === playerId) m.votes.delete(voter);
  if (m.candidates) m.candidates = m.candidates.filter((id) => id !== playerId);
  const index = m.order.indexOf(playerId);
  if (index !== -1) {
    m.order.splice(index, 1);
    if (index < m.turn) m.turn -= 1;
  }
  if (m.elimination?.playerId === playerId && m.elimination.awaitingGuess) {
    m.elimination.awaitingGuess = false;
    m.elimination.guess = { text: '', correct: false };
  }
  if (wasAlive && ['reveal', 'clues', 'ballot'].includes(lobby.state) && settleOutcome(lobby)) {
    lobby.state = 'round-end';
    return;
  }
  if (lobby.state === 'ballot' && m.candidates.length < 2 && m.candidates.length > 0 && m.revote) {
    eliminate(lobby, m.candidates[0], tally(lobby));
  }
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------

export function impostorPublic(lobby) {
  const m = manche(lobby);
  if (!m) return null;
  const { state } = lobby;
  const end = state === 'round-end';
  return {
    manche: lobby.game.index + 1,
    totalManches: lobby.game.totalRounds,
    clueMode: lobby.game.clueMode,
    composition: { ...m.composition },
    tour: m.tour,
    order: [...m.order],
    speaker: currentSpeaker(lobby),
    clues: m.clues.map((entries, i) => ({ tour: i + 1, entries: entries.map((e) => ({ ...e })) })),
    alive: [...m.alive],
    eliminated: m.eliminated.map((e) => ({ ...e, label: ROLE_LABEL[e.role] })),
    readyIds: state === 'reveal' ? [...m.ready].filter((id) => lobby.players.has(id)) : [],
    votedIds: state === 'ballot' ? [...m.votes.keys()].filter((id) => lobby.players.has(id)) : [],
    candidates: state === 'ballot' ? [...m.candidates] : null,
    revote: state === 'ballot' && m.revote,
    lastTie: state === 'ballot' && m.revote ? m.lastTie?.tied ?? null : null,
    elimination: ['elimination', 'round-end'].includes(state) && m.elimination
      ? {
          ...m.elimination,
          label: m.elimination.role ? ROLE_LABEL[m.elimination.role] : null,
          // Le mot proposé par Mr. White n'est montré qu'une fois sa tentative terminée.
          guess: m.elimination.guess,
        }
      : null,
    outcome: m.outcome && (end || state === 'elimination') ? { winner: m.outcome.winner } : null,
    // Révélation complète en fin de manche seulement.
    reveal: end
      ? {
          words: { ...m.words },
          roles: [...m.roles].filter(([id]) => lobby.players.has(id)).map(([playerId, role]) => ({ playerId, role, label: ROLE_LABEL[role] })),
          winners: [...m.outcome.winners],
          points: { ...m.outcome.points },
        }
      : null,
    totals: { ...lobby.game.totals },
  };
}

export function impostorPrivate(lobby, viewerId) {
  const m = manche(lobby);
  if (!m || !m.roles.has(viewerId)) return null;
  return {
    word: wordOf(lobby, viewerId),
    isWhite: m.roles.get(viewerId) === 'white',
    alive: m.alive.has(viewerId),
    ready: m.ready.has(viewerId),
    vote: lobby.state === 'ballot' ? (m.votes.get(viewerId) ?? null) : null,
  };
}
