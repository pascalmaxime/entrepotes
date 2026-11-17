import { randomInt, randomUUID } from 'node:crypto';
import { GameError } from '../game/errors.js';

/**
 * Image Mystère (façon Dixit), avec les images de la bibliothèque Top Meme.
 * Chacun a une main de 5 images. À chaque manche, un conteur (chacun son tour) :
 *   im-tell   : choisit une de ses images et écrit une phrase (« Lundi matin »)
 *   im-play   : les autres posent l'image de leur main qui colle le mieux à la phrase
 *   im-vote   : les images posées sont mélangées ; chacun (sauf le conteur) cherche celle du conteur
 *   im-reveal : qui a posé quoi, qui a voté pour quoi, les points → manche suivante → … → finished
 * Points : si TOUT LE MONDE ou PERSONNE trouve l'image du conteur, il marque 0 et les autres 2.
 *          Sinon le conteur et ceux qui ont trouvé marquent 3. Et +1 par vote reçu sur ton image (3 max).
 * Le propriétaire des images n'est jamais envoyé avant la révélation.
 */

export const MIN_PLAYERS = 3;
export const HAND_SIZE = 5;
export const IM_POINTS = Object.freeze({ storyteller: 3, finder: 3, allOrNone: 2, perVote: 1, maxVoteBonus: 3 });
export const IM_LIMITS = Object.freeze({
  turns: [1, 2], // chacun est conteur N fois
  timers: [45, 60, 90, 120],
  defaults: { turns: 1, timer: 60 },
});
const PHRASE_MAX = 60;
const GRACE_MS = 1_000;

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const url = (id) => `/memes/${id}.jpg`;
export const minImages = (players) => players * (HAND_SIZE + 1);

export function cleanPhrase(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PHRASE_MAX);
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const imOf = (lobby) => lobby.game.im;
const isConnected = (lobby, id) => Boolean(lobby.players.get(id)?.connected);
const others = (lobby) => lobby.connectedPlayers.map((p) => p.id).filter((id) => id !== imOf(lobby).teller);

function setTimer(lobby, fn) {
  const im = imOf(lobby);
  lobby.clearQuizTimer();
  const token = ++im.token;
  const seconds = im.settings.timer;
  im.deadline = Date.now() + seconds * 1000;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.im !== im || im.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, seconds * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

function stopTimer(lobby) {
  const im = imOf(lobby);
  lobby.clearQuizTimer();
  im.token += 1;
  im.deadline = null;
}

export function startImageMystere(lobby, base) {
  const players = lobby.connectedPlayers;
  if (players.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  const ids = lobby.memeLibrary?.list().map((e) => e.id) ?? [];
  const need = minImages(players.length);
  if (ids.length < need) {
    throw new GameError('NO_TEMPLATES', `Il faut au moins ${need} images dans la bibliothèque pour ${players.length} joueurs (il y en a ${ids.length}). Importe le pack d’images depuis l’espace admin.`);
  }
  const settings = { ...lobby.settings.imageMystere };
  const order = shuffle(players.map((p) => p.id));
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: order.length * settings.turns,
    im: {
      settings,
      order,
      index: 0,
      token: 0,
      deadline: null,
      deck: shuffle(ids),
      discard: [],
      hands: new Map(),
      teller: null,
      phrase: null,
      played: new Map(), // joueur → image posée (le conteur compris)
      choices: [], // images mélangées pour le vote
      votes: new Map(),
      best: null,
    },
  };
  openRound(lobby);
}

// Pioche : quand le paquet est vide, on remélange les images déjà jouées.
function draw(lobby) {
  const im = imOf(lobby);
  const alive = new Set(lobby.memeLibrary.list().map((e) => e.id));
  const inHands = new Set([...im.hands.values()].flat());
  for (let tries = 0; tries < 2; tries += 1) {
    while (im.deck.length) {
      const id = im.deck.pop();
      if (alive.has(id) && !inHands.has(id)) return id;
    }
    im.deck = shuffle([...new Set([...im.discard, ...alive])].filter((id) => !inHands.has(id)));
    im.discard = [];
  }
  return null;
}

function refillHands(lobby) {
  const im = imOf(lobby);
  const alive = new Set(lobby.memeLibrary.list().map((e) => e.id));
  for (const p of lobby.connectedPlayers) {
    const hand = (im.hands.get(p.id) ?? []).filter((id) => alive.has(id)); // image supprimée par l'admin : remplacée
    im.hands.set(p.id, hand);
    while (hand.length < HAND_SIZE) {
      const id = draw(lobby);
      if (!id) break;
      hand.push(id);
    }
  }
}

function openRound(lobby) {
  const im = imOf(lobby);
  const { game } = lobby;
  while (im.index < game.totalRounds && !isConnected(lobby, im.order[im.index % im.order.length])) im.index += 1;
  if (im.index >= game.totalRounds || lobby.connectedPlayers.length < MIN_PLAYERS) {
    stopTimer(lobby);
    game.index = game.totalRounds;
    lobby.finish();
    lobby.game.final.im = { best: im.best };
    return;
  }
  refillHands(lobby);
  im.teller = im.order[im.index % im.order.length];
  im.phrase = null;
  im.played = new Map();
  im.choices = [];
  im.votes = new Map();
  game.index = im.index;
  game.result = null;
  lobby.state = 'im-tell';
  setTimer(lobby, () => skipRound(lobby));
}

function skipRound(lobby) {
  const im = imOf(lobby);
  lobby.game.history.push({ question: `Manche ${im.index + 1} · pas de phrase du conteur`, topPlayerIds: [] });
  im.index += 1;
  openRound(lobby);
}

const assertHand = (im, playerId, cardId) => {
  if (!(im.hands.get(playerId) ?? []).includes(cardId)) throw new GameError('NOT_IN_HAND', 'Cette image n’est pas dans ta main.');
};

// Le conteur choisit son image et sa phrase.
export function tell(lobby, playerId, { cardId, phrase } = {}) {
  if (lobby.game?.kind !== 'image-mystere' || lobby.state !== 'im-tell') throw new GameError('NOT_NOW', 'Ce n’est pas le moment.');
  const im = imOf(lobby);
  if (playerId !== im.teller) throw new GameError('NOT_TELLER', 'C’est le conteur qui choisit la phrase.');
  assertHand(im, playerId, cardId);
  const text = cleanPhrase(phrase);
  if (!text) throw new GameError('EMPTY', 'Écris une phrase (un mot, un titre, un bruit… ce que tu veux) 😉');
  im.phrase = text;
  im.played.set(playerId, cardId);
  lobby.state = 'im-play';
  setTimer(lobby, () => openVote(lobby));
}

// Les autres posent une image (on peut changer d'avis jusqu'au vote).
export function play(lobby, playerId, { cardId } = {}) {
  if (lobby.game?.kind !== 'image-mystere' || lobby.state !== 'im-play') throw new GameError('NOT_NOW', 'Ce n’est plus le moment de poser une image.');
  const im = imOf(lobby);
  if (playerId === im.teller) throw new GameError('TELLER', 'Ton image est déjà posée 😉');
  assertHand(im, playerId, cardId);
  im.played.set(playerId, cardId);
  checkAllPlayed(lobby);
}

function checkAllPlayed(lobby) {
  if (lobby.state !== 'im-play') return false;
  const im = imOf(lobby);
  const list = others(lobby);
  if (list.length === 0 || !list.every((id) => im.played.has(id))) return false;
  openVote(lobby);
  return true;
}

function openVote(lobby) {
  const im = imOf(lobby);
  // Il faut au moins 2 images (celle du conteur + une autre) pour voter, sinon la manche ne compte pas.
  const played = [...im.played].filter(([id]) => lobby.players.has(id));
  if (played.length < 2 || !played.some(([id]) => id === im.teller)) return skipRound(lobby);
  im.choices = shuffle(played.map(([owner, cardId]) => ({ id: randomUUID().slice(0, 8), cardId, owner })));
  im.votes = new Map();
  lobby.state = 'im-vote';
  setTimer(lobby, () => reveal(lobby));
}

export function vote(lobby, playerId, { choiceId } = {}) {
  if (lobby.game?.kind !== 'image-mystere' || lobby.state !== 'im-vote') throw new GameError('NOT_NOW', 'Le vote est terminé.');
  const im = imOf(lobby);
  if (playerId === im.teller) throw new GameError('TELLER', 'Le conteur ne vote pas 😏');
  const choice = im.choices.find((c) => c.id === choiceId);
  if (!choice) throw new GameError('INVALID_VOTE', 'Image inconnue.');
  if (choice.owner === playerId) throw new GameError('OWN_CARD', 'C’est ton image, cherche celle du conteur !');
  im.votes.set(playerId, choiceId);
  checkAllVoted(lobby);
}

function checkAllVoted(lobby) {
  if (lobby.state !== 'im-vote') return false;
  const im = imOf(lobby);
  const list = others(lobby);
  if (list.length === 0 || !list.every((id) => im.votes.has(id))) return false;
  reveal(lobby);
  return true;
}

export function reveal(lobby) {
  const im = imOf(lobby);
  const { game } = lobby;
  stopTimer(lobby);
  const live = (id) => lobby.players.has(id);
  const tellerChoice = im.choices.find((c) => c.owner === im.teller);
  const voters = new Map(im.choices.map((c) => [c.id, []]));
  for (const [id, choiceId] of im.votes) if (live(id)) voters.get(choiceId)?.push(id);
  const allVoters = [...im.votes.keys()].filter(live);
  const finders = voters.get(tellerChoice.id) ?? [];
  const gains = {};
  const add = (id, n) => {
    if (n > 0 && live(id)) gains[id] = (gains[id] ?? 0) + n;
  };
  const allOrNone = finders.length === 0 || finders.length === allVoters.length;
  if (allOrNone) {
    for (const c of im.choices) if (c.owner !== im.teller) add(c.owner, IM_POINTS.allOrNone);
  } else {
    add(im.teller, IM_POINTS.storyteller);
    finders.forEach((id) => add(id, IM_POINTS.finder));
  }
  for (const c of im.choices) {
    if (c.owner !== im.teller) add(c.owner, Math.min(IM_POINTS.maxVoteBonus, voters.get(c.id).length * IM_POINTS.perVote));
  }
  for (const [id, n] of Object.entries(gains)) game.totals[id] = (game.totals[id] ?? 0) + n;

  // Le leurre de la soirée : l'image d'un autre joueur qui a piégé le plus de monde.
  for (const c of im.choices) {
    const n = voters.get(c.id).length;
    if (c.owner !== im.teller && n > 0 && (!im.best || n > im.best.votes)) im.best = { owner: c.owner, cardUrl: url(c.cardId), votes: n, phrase: im.phrase };
  }
  game.history.push({ question: `Manche ${im.index + 1} · « ${im.phrase} »`, topPlayerIds: allOrNone ? [] : [im.teller, ...finders] });
  game.result = {
    type: 'image-mystere',
    teller: im.teller,
    phrase: im.phrase,
    allOrNone,
    nobody: finders.length === 0,
    cards: im.choices.map((c) => ({ id: c.id, url: url(c.cardId), owner: c.owner, teller: c.owner === im.teller, voters: voters.get(c.id) })),
    gains,
    scores: { ...game.totals },
  };
  // Les images posées quittent les mains.
  for (const [id, cardId] of im.played) {
    const hand = im.hands.get(id);
    if (hand) im.hands.set(id, hand.filter((x) => x !== cardId));
    im.discard.push(cardId);
  }
  lobby.state = 'im-reveal';
}

export function next(lobby) {
  const im = imOf(lobby);
  im.index += 1;
  openRound(lobby);
  return lobby.state === 'finished' ? 'finish' : 'next';
}

export function hostSkip(lobby) {
  if (lobby.state === 'im-tell') return skipRound(lobby);
  if (lobby.state === 'im-play') return openVote(lobby);
  if (lobby.state === 'im-vote') return reveal(lobby);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

export function progress(lobby) {
  if (lobby.state === 'im-tell' && !isConnected(lobby, imOf(lobby).teller)) {
    skipRound(lobby);
    return true;
  }
  if (lobby.state === 'im-play') return checkAllPlayed(lobby);
  if (lobby.state === 'im-vote') return checkAllVoted(lobby);
  return false;
}

export function playerGone(lobby, playerId) {
  const im = lobby.game.im;
  im.votes.delete(playerId);
  if (lobby.state !== 'im-vote') im.played.delete(playerId);
  im.discard.push(...(im.hands.get(playerId) ?? []));
  im.hands.delete(playerId);
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function imPublic(lobby, viewerId) {
  const im = lobby.game?.im;
  if (!im || !lobby.state.startsWith('im-')) return null;
  const isTeller = viewerId !== null && viewerId === im.teller;
  const live = (ids) => [...ids].filter((id) => lobby.players.has(id));
  const myCard = im.played.get(viewerId) ?? null;
  return {
    phase: lobby.state,
    index: im.index,
    total: lobby.game.totalRounds,
    teller: im.teller,
    isTeller,
    phrase: im.phrase,
    hand: (im.hands.get(viewerId) ?? []).map((id) => ({ id, url: url(id) })),
    myCard,
    playedIds: lobby.state === 'im-play' ? live(im.played.keys()).filter((id) => id !== im.teller) : [],
    // Vote : les images, jamais leur propriétaire ; on dit seulement laquelle est la tienne.
    choices: lobby.state === 'im-vote' ? im.choices.map((c) => ({ id: c.id, url: url(c.cardId), mine: c.owner === viewerId })) : [],
    myVote: im.votes.get(viewerId) ?? null,
    votedIds: lobby.state === 'im-vote' ? live(im.votes.keys()) : [],
    deadline: im.deadline,
    timer: im.settings.timer,
    serverNow: Date.now(),
  };
}

export function imLimits(lobby) {
  const n = lobby.connectedPlayers.length;
  return {
    minPlayers: MIN_PLAYERS,
    turns: [...IM_LIMITS.turns],
    timers: [...IM_LIMITS.timers],
    points: { ...IM_POINTS },
    handSize: HAND_SIZE,
    players: n,
    images: lobby.memeLibrary?.count ?? 0,
    imagesNeeded: minImages(Math.max(MIN_PLAYERS, n)),
  };
}

export function defaultSettings() {
  return { ...IM_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { imTurns, imTimer }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (imTurns !== undefined) next.turns = pickFrom(IM_LIMITS.turns, imTurns, 'Nombre de tours');
  if (imTimer !== undefined) next.timer = pickFrom(IM_LIMITS.timers, imTimer, 'Chrono');
  return next;
}
