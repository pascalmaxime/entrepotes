import { randomInt } from 'node:crypto';
import { GameError } from '../game/errors.js';
import { judgeGuess } from '../paint/engine.js';

/**
 * Du coq à l'âne (téléphone arabe dessiné, façon Gartic Phone / Telestrations).
 * Chaque joueur a un carnet avec un mot secret. À chaque étape, les carnets tournent d'un cran :
 *   étape 0 : je dessine le mot de MON carnet
 *   étape 1 : je reçois le carnet de mon voisin, je ne vois que son dessin → j'écris ce que je devine
 *   étape 2 : carnet suivant, je ne vois que le mot deviné → je le dessine… et ainsi de suite.
 * La dernière étape est toujours une devinette. À la fin, on révèle les carnets page par page.
 *   cc-step (dessin ou devinette, chrono) → … → cc-reveal (l'hôte tourne les pages) → finished
 */

export const MIN_PLAYERS = 3;
export const CC_LIMITS = Object.freeze({
  draw: [45, 60, 90, 120], // secondes pour dessiner
  guess: [20, 30, 45], // secondes pour deviner
  difficulties: ['facile', 'moyen', 'difficile', 'melange'],
  defaults: { draw: 60, guess: 30, difficulty: 'melange' },
});
const GRACE_MS = 2_000; // les dessins envoyés à la toute fin du chrono arrivent un peu après
const MAX_POINTS = 40_000;
const GUESS_MAX = 60;
const CANVAS = 800;
const COLOR = /^#[0-9a-f]{6}$/i;
const TOOLS = new Set(['pen', 'marker', 'spray', 'eraser']);

const ccOf = (lobby) => lobby.game.cc;
const name = (lobby, id) => lobby.players.get(id)?.name ?? 'Un joueur parti';

function setTimer(lobby, ms, fn) {
  const cc = ccOf(lobby);
  lobby.clearQuizTimer();
  const token = ++cc.token;
  cc.deadline = Date.now() + ms;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.cc !== cc || cc.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, ms + GRACE_MS);
  lobby.quizTimer.unref?.();
}

// Nombre d'étapes : chacun touche chaque carnet, et on finit toujours par une devinette.
export const stepCount = (n) => (n % 2 === 0 ? n : n - 1);
export const stepKind = (step) => (step % 2 === 0 ? 'draw' : 'guess');

// --- Validation d'un dessin envoyé par un joueur ---------------------------------------------------

const clampInt = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

export function sanitizeOps(raw) {
  if (!Array.isArray(raw)) return [];
  const ops = [];
  let points = 0;
  for (const op of raw.slice(0, 5000)) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'c') ops.push({ t: 'c' });
    else if (op.t === 'f' && COLOR.test(op.color)) {
      ops.push({ t: 'f', x: clampInt(op.x, 0, CANVAS - 1), y: clampInt(op.y, 0, CANVAS - 1), color: op.color.toLowerCase() });
    } else if (op.t === 's' && TOOLS.has(op.tool) && COLOR.test(op.color) && typeof op.id === 'string' && Array.isArray(op.pts) && op.pts.length >= 2 && op.pts.length % 2 === 0) {
      points += op.pts.length / 2;
      if (points > MAX_POINTS) break;
      ops.push({ t: 's', id: op.id.slice(0, 20), tool: op.tool, color: op.color.toLowerCase(), size: clampInt(op.size, 2, 80), pts: op.pts.slice(0, 2000).map((v) => clampInt(v, -20, CANVAS + 20)) });
    }
  }
  return ops;
}

// --- Partie --------------------------------------------------------------------------------------------

export function startCoqAne(lobby, base) {
  const ids = lobby.connectedPlayers.map((p) => p.id);
  if (ids.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  if (!lobby.paintWords) throw new GameError('NO_WORDS', 'Aucune liste de mots disponible.');
  const settings = { ...lobby.settings.coqAne };
  const levels = ['facile', 'moyen', 'difficile'];
  // Ordre autour de la table : le carnet passe toujours au voisin suivant.
  const seats = [...ids];
  for (let i = seats.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [seats[i], seats[j]] = [seats[j], seats[i]];
  }
  const carnets = seats.map((ownerId) => {
    const choices = lobby.paintWords.pickChoices(lobby.usedPaintWords);
    const level = settings.difficulty === 'melange' ? levels[randomInt(3)] : settings.difficulty;
    return { ownerId, word: choices[level], level, pages: [] };
  });
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: 1,
    cc: { settings, seats, carnets, steps: stepCount(seats.length), step: 0, token: 0, deadline: null, reveal: null },
  };
  openStep(lobby);
}

// Carnet tenu par un joueur à une étape donnée : le carnet de celui qui est « step » places avant lui.
export function carnetIndex(cc, playerId, step = cc.step) {
  const n = cc.seats.length;
  const seat = cc.seats.indexOf(playerId);
  if (seat < 0) return -1;
  return (((seat - step) % n) + n) % n;
}

function openStep(lobby) {
  const cc = ccOf(lobby);
  lobby.state = 'cc-step';
  const seconds = stepKind(cc.step) === 'draw' ? cc.settings.draw : cc.settings.guess;
  setTimer(lobby, seconds * 1000, () => closeStep(lobby));
}

const hasPage = (cc, carnet) => carnet.pages.length > cc.step;

export function submit(lobby, playerId, payload = {}) {
  if (lobby.game?.kind !== 'coq-ane' || lobby.state !== 'cc-step') throw new GameError('NOT_NOW', 'Ce n’est pas le moment.');
  const cc = ccOf(lobby);
  if (payload.step !== cc.step) throw new GameError('TOO_LATE', 'Trop tard, les carnets ont déjà tourné !');
  const index = carnetIndex(cc, playerId);
  if (index < 0) throw new GameError('NOT_PLAYING', 'Tu ne participes pas à cette partie.');
  const carnet = cc.carnets[index];
  if (hasPage(cc, carnet)) throw new GameError('ALREADY_DONE', 'Tu as déjà rendu ce carnet.');
  if (stepKind(cc.step) === 'draw') {
    carnet.pages.push({ kind: 'draw', authorId: playerId, ops: sanitizeOps(payload.ops) });
  } else {
    const text = typeof payload.text === 'string' ? payload.text.replace(/\s+/g, ' ').trim().slice(0, GUESS_MAX) : '';
    if (!text) throw new GameError('EMPTY', 'Écris ce que tu vois sur le dessin.');
    carnet.pages.push({ kind: 'guess', authorId: playerId, text });
  }
  checkAllDone(lobby);
}

export function checkAllDone(lobby) {
  if (lobby.state !== 'cc-step') return false;
  const cc = ccOf(lobby);
  const waiting = lobby.connectedPlayers.filter((p) => {
    const index = carnetIndex(cc, p.id);
    return index >= 0 && !hasPage(cc, cc.carnets[index]);
  });
  if (waiting.length > 0) return false;
  closeStep(lobby);
  return true;
}

// Fin d'étape : les pages manquantes (joueur parti ou trop lent) sont remplies, puis les carnets tournent.
function closeStep(lobby) {
  const cc = ccOf(lobby);
  for (const carnet of cc.carnets) {
    if (hasPage(cc, carnet)) continue;
    const authorId = cc.seats[(cc.seats.indexOf(carnet.ownerId) + cc.step) % cc.seats.length];
    carnet.pages.push(stepKind(cc.step) === 'draw' ? { kind: 'draw', authorId, ops: [], missed: true } : { kind: 'guess', authorId, text: '…', missed: true });
  }
  cc.step += 1;
  if (cc.step >= cc.steps) {
    startReveal(lobby);
    return;
  }
  openStep(lobby);
}

// --- Révélation ----------------------------------------------------------------------------------------

function startReveal(lobby) {
  const cc = ccOf(lobby);
  lobby.clearQuizTimer();
  cc.deadline = null;
  // Points : une devinette qui retrouve le mot de départ rapporte 1 pt au devineur et 1 pt au dessinateur juste avant.
  for (const carnet of cc.carnets) {
    carnet.pages.forEach((page, i) => {
      if (page.kind !== 'guess') return;
      page.correct = !page.missed && judgeGuess(page.text, carnet.word) === 'correct';
      if (page.correct) {
        lobby.game.totals[page.authorId] = (lobby.game.totals[page.authorId] ?? 0) + 1;
        const drawer = carnet.pages[i - 1]?.authorId;
        if (drawer) lobby.game.totals[drawer] = (lobby.game.totals[drawer] ?? 0) + 1;
      }
    });
    carnet.success = Boolean(carnet.pages.at(-1)?.correct);
  }
  cc.reveal = { carnet: 0, shown: 0 }; // shown = nombre de pages dévoilées (0 = juste le mot)
  lobby.state = 'cc-reveal';
}

// L'hôte tourne les pages : page suivante, carnet suivant, puis fin.
export function revealNext(lobby, playerId) {
  lobby.assertHost(playerId);
  if (lobby.state !== 'cc-reveal') throw new GameError('NOT_NOW', 'La révélation n’a pas commencé.');
  const cc = ccOf(lobby);
  const carnet = cc.carnets[cc.reveal.carnet];
  if (cc.reveal.shown < carnet.pages.length) {
    cc.reveal.shown += 1;
    return;
  }
  if (cc.reveal.carnet + 1 < cc.carnets.length) {
    cc.reveal = { carnet: cc.reveal.carnet + 1, shown: 0 };
    return;
  }
  finishGame(lobby);
}

export function revealAll(lobby, playerId) {
  lobby.assertHost(playerId);
  if (lobby.state !== 'cc-reveal') throw new GameError('NOT_NOW', 'La révélation n’a pas commencé.');
  const cc = ccOf(lobby);
  cc.reveal.shown = cc.carnets[cc.reveal.carnet].pages.length;
}

function finishGame(lobby) {
  const cc = ccOf(lobby);
  lobby.game.history = cc.carnets.map((c) => ({
    question: `📒 Carnet de ${name(lobby, c.ownerId)} : « ${c.word} »`,
    answer: `→ « ${c.pages.at(-1)?.text ?? '…'} »${c.success ? ' ✅' : ''}`,
    topPlayerIds: c.pages.filter((p) => p.correct).map((p) => p.authorId),
  }));
  lobby.finish();
  lobby.game.final.cc = { success: cc.carnets.filter((c) => c.success).length, total: cc.carnets.length };
}

// L'hôte passe l'étape (quelqu'un ne rend pas son carnet).
export function hostSkip(lobby) {
  if (lobby.state === 'cc-step') return closeStep(lobby);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

export function progress(lobby) {
  return checkAllDone(lobby);
}

// --- Ce que voit chaque joueur ---------------------------------------------------------------------------

export function ccPublic(lobby, viewerId) {
  const cc = lobby.game?.cc;
  if (!cc) return null;
  const base = { phase: lobby.state, seats: cc.seats, steps: cc.steps, step: cc.step, serverNow: Date.now(), deadline: cc.deadline };
  if (lobby.state === 'cc-step') {
    const done = cc.carnets.filter((c) => hasPage(cc, c)).map((c) => cc.seats[(cc.seats.indexOf(c.ownerId) + cc.step) % cc.seats.length]);
    const index = carnetIndex(cc, viewerId);
    let task = null;
    if (index >= 0) {
      const carnet = cc.carnets[index];
      const kind = stepKind(cc.step);
      const previous = carnet.pages.at(cc.step - 1);
      task = {
        kind,
        // Ce que le joueur a sous les yeux : le mot (1re étape), la devinette précédente, ou le dessin précédent.
        word: cc.step === 0 ? carnet.word : null,
        text: cc.step > 0 && kind === 'draw' ? previous?.text ?? '…' : null,
        ops: kind === 'guess' ? previous?.ops ?? [] : null,
        fromId: cc.step > 0 ? previous?.authorId : null,
        done: hasPage(cc, carnet),
      };
    }
    return { ...base, doneIds: done, task };
  }
  if (lobby.state === 'cc-reveal' || lobby.state === 'finished') {
    const r = cc.reveal ?? { carnet: cc.carnets.length - 1, shown: Infinity };
    const carnet = cc.carnets[r.carnet];
    const full = lobby.state === 'finished';
    return {
      ...base,
      reveal: {
        index: r.carnet,
        total: cc.carnets.length,
        shown: Math.min(r.shown, carnet.pages.length),
        pages: carnet.pages.length,
        ownerId: carnet.ownerId,
        word: carnet.word,
        level: carnet.level,
        // Seules les pages déjà dévoilées partent vers les navigateurs (le suspense est préservé).
        visible: carnet.pages.slice(0, r.shown).map(({ kind, authorId, ops, text, missed, correct }) => ({ kind, authorId, ops, text, missed, correct })),
        success: r.shown >= carnet.pages.length ? carnet.success : null,
      },
      summary: full ? cc.carnets.map((c) => ({ ownerId: c.ownerId, word: c.word, last: c.pages.at(-1)?.text ?? '…', success: c.success })) : null,
    };
  }
  return base;
}

export function playerGone() {
  // Rien de spécial : ses pages seront remplies (« … ») à la fin de chaque étape.
}

export function sanitizeSettings(current, { ccDraw, ccGuess, ccDifficulty }) {
  const next = { ...current };
  const pickFrom = (list, value, label) => {
    const v = typeof value === 'string' ? value : Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (ccDraw !== undefined) next.draw = pickFrom(CC_LIMITS.draw, ccDraw, 'Temps de dessin');
  if (ccGuess !== undefined) next.guess = pickFrom(CC_LIMITS.guess, ccGuess, 'Temps pour deviner');
  if (ccDifficulty !== undefined) next.difficulty = pickFrom(CC_LIMITS.difficulties, ccDifficulty, 'Difficulté');
  return next;
}
