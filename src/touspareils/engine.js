import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError } from '../game/errors.js';
import { textKey } from '../bluff/engine.js';

/**
 * Tous pareils ! : une catégorie (« Un fruit rouge »), chacun écrit sa réponse en secret.
 * Le but : écrire LA MÊME CHOSE que les autres.
 *   tp-answer : tout le monde écrit (chrono)
 *   tp-reveal : les réponses regroupées (« Fraise » = « fraises » = « une fraise »), les points.
 *               L'hôte peut fusionner deux groupes (« Pomme » et « Pomme rouge ») → points recalculés.
 * Points : 1 pt par joueur qui a écrit la même chose que toi, +2 si ta réponse est la plus populaire.
 */

export const MIN_PLAYERS = 3;
export const TP_POINTS = Object.freeze({ perMatch: 1, top: 2 });
export const TP_LIMITS = Object.freeze({
  rounds: [5, 8, 10, 15],
  timers: [20, 30, 45],
  defaults: { rounds: 8, timer: 30 },
});
const ANSWER_MAX = 40;
const GRACE_MS = 1_000;
export const QUESTIONS_FILE = fileURLToPath(new URL('../../data/touspareils.json', import.meta.url));

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function cleanAnswer(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ANSWER_MAX);
}

// Une faute de frappe tolérée sur les réponses d'au moins 5 lettres (« fraize » = « fraise »).
function closeEnough(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

// Regroupe les réponses : [{ id, key, label, members: [{ playerId, text }] }], plus gros groupe d'abord.
export function groupAnswers(answers) {
  const groups = [];
  for (const [playerId, text] of answers) {
    const key = textKey(text) || text.toLowerCase();
    const group = groups.find((g) => closeEnough(g.key, key));
    if (group) group.members.push({ playerId, text });
    else groups.push({ key, members: [{ playerId, text }] });
  }
  return groups
    .map((g, i) => ({ id: `g${i + 1}`, key: g.key, label: labelOf(g.members), members: g.members }))
    .sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label, 'fr'));
}

// Le libellé d'un groupe : l'orthographe la plus utilisée (puis la plus courte).
function labelOf(members) {
  const count = new Map();
  for (const m of members) count.set(m.text, (count.get(m.text) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
}

export function gainsFor(groups) {
  const gains = {};
  const top = Math.max(0, ...groups.map((g) => g.members.length));
  for (const g of groups) {
    const size = g.members.length;
    for (const m of g.members) {
      const n = (size - 1) * TP_POINTS.perMatch + (top >= 2 && size === top ? TP_POINTS.top : 0);
      if (n > 0) gains[m.playerId] = n;
    }
  }
  return gains;
}

// --- Questions (data/touspareils.json, relu automatiquement s'il change) -------------------------------------

function parseQuestions(raw) {
  const data = JSON.parse(raw);
  const list = [...new Set((Array.isArray(data.questions) ? data.questions : []).filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim()))];
  if (list.length === 0) throw new Error('Aucune question valide.');
  return list;
}

export function createQuestionBank(questions) {
  let list = [...questions];
  return {
    get size() {
      return list.length;
    },
    replace(next) {
      list = [...next];
    },
    pick(count, used = new Set()) {
      let fresh = list.filter((q) => !used.has(q));
      if (fresh.length < count) {
        for (const q of list) used.delete(q);
        fresh = list;
      }
      const picked = shuffle(fresh).slice(0, count);
      for (const q of picked) used.add(q);
      return picked;
    },
  };
}

export function loadQuestionBank(file = QUESTIONS_FILE) {
  let mtime = statSync(file).mtimeMs;
  const bank = createQuestionBank(parseQuestions(readFileSync(file, 'utf8')));
  const basePick = bank.pick;
  bank.pick = (count, used) => {
    try {
      const current = statSync(file).mtimeMs;
      if (current !== mtime) {
        bank.replace(parseQuestions(readFileSync(file, 'utf8')));
        mtime = current;
        console.log(`[tous-pareils] Fichier rechargé (${bank.size} questions).`);
      }
    } catch (error) {
      console.warn('[tous-pareils] Rechargement impossible, on garde la version précédente :', error.message);
    }
    return basePick(count, used);
  };
  return bank;
}

let sharedBank = null;
export function getBank() {
  if (!sharedBank) sharedBank = loadQuestionBank();
  return sharedBank;
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const tpOf = (lobby) => lobby.game.tp;

function setTimer(lobby, fn) {
  const tp = tpOf(lobby);
  lobby.clearQuizTimer();
  const token = ++tp.token;
  tp.deadline = Date.now() + tp.settings.timer * 1000;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.tp !== tp || tp.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, tp.settings.timer * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

export function startTousPareils(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  lobby.tpBank ??= getBank();
  lobby.usedTpQuestions ??= new Set();
  const settings = { ...lobby.settings.tousPareils };
  const questions = lobby.tpBank.pick(settings.rounds, lobby.usedTpQuestions);
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: questions.length,
    tp: { settings, questions, index: 0, token: 0, deadline: null, answers: new Map(), groups: [], gains: {} },
  };
  openRound(lobby);
}

function openRound(lobby) {
  const tp = tpOf(lobby);
  tp.answers = new Map();
  tp.groups = [];
  tp.gains = {};
  lobby.game.index = tp.index;
  lobby.game.result = null;
  lobby.state = 'tp-answer';
  setTimer(lobby, () => reveal(lobby));
}

export function submitAnswer(lobby, playerId, { index, text } = {}) {
  if (lobby.game?.kind !== 'tous-pareils' || lobby.state !== 'tp-answer') throw new GameError('NOT_NOW', 'Trop tard pour répondre !');
  const tp = tpOf(lobby);
  if (index !== tp.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la suite !');
  const answer = cleanAnswer(text);
  if (!answer) throw new GameError('EMPTY', 'Écris une réponse 😉');
  tp.answers.set(playerId, answer);
  checkAllAnswered(lobby);
}

function checkAllAnswered(lobby) {
  if (lobby.state !== 'tp-answer') return false;
  const tp = tpOf(lobby);
  const players = lobby.connectedPlayers;
  if (players.length === 0 || !players.every((p) => tp.answers.has(p.id))) return false;
  reveal(lobby);
  return true;
}

// Applique les points d'une répartition en groupes (et retire ceux de la répartition précédente).
function applyGroups(lobby, groups) {
  const tp = tpOf(lobby);
  const { game } = lobby;
  for (const [id, n] of Object.entries(tp.gains)) game.totals[id] = (game.totals[id] ?? 0) - n;
  tp.groups = groups;
  tp.gains = gainsFor(groups);
  for (const [id, n] of Object.entries(tp.gains)) game.totals[id] = (game.totals[id] ?? 0) + n;
  const question = tp.questions[tp.index];
  const top = groups[0];
  const entry = { question: `${question} → « ${top?.label ?? '—'} »`, topPlayerIds: top && top.members.length >= 2 ? top.members.map((m) => m.playerId) : [] };
  if (game.history.length > tp.index) game.history[tp.index] = entry;
  else game.history.push(entry);
  game.result = { type: 'tous-pareils', question, groups, gains: tp.gains, scores: { ...game.totals } };
}

export function reveal(lobby) {
  const tp = tpOf(lobby);
  lobby.clearQuizTimer();
  tp.token += 1;
  tp.deadline = null;
  const answers = [...tp.answers].filter(([id]) => lobby.players.has(id));
  applyGroups(lobby, groupAnswers(answers));
  lobby.state = 'tp-reveal';
}

// L'hôte fusionne deux groupes qu'il juge identiques.
export function merge(lobby, { from, into } = {}) {
  if (lobby.game?.kind !== 'tous-pareils' || lobby.state !== 'tp-reveal') throw new GameError('NOT_NOW', 'On ne peut fusionner qu’à la révélation.');
  const tp = tpOf(lobby);
  const a = tp.groups.find((g) => g.id === from);
  const b = tp.groups.find((g) => g.id === into);
  if (!a || !b || a === b) throw new GameError('INVALID_MERGE', 'Choisis deux réponses différentes.');
  const merged = { ...b, members: [...b.members, ...a.members] };
  merged.label = labelOf(merged.members);
  const groups = tp.groups.filter((g) => g !== a && g !== b).concat(merged).sort((x, y) => y.members.length - x.members.length || x.label.localeCompare(y.label, 'fr'));
  applyGroups(lobby, groups);
}

export function next(lobby) {
  const tp = tpOf(lobby);
  if (tp.index + 1 >= lobby.game.totalRounds) {
    lobby.game.index = lobby.game.totalRounds;
    lobby.finish();
    return 'finish';
  }
  tp.index += 1;
  openRound(lobby);
  return 'next';
}

export function hostSkip(lobby) {
  if (lobby.state === 'tp-answer') return reveal(lobby);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

export function progress(lobby) {
  if (lobby.state === 'tp-answer') return checkAllAnswered(lobby);
  return false;
}

export function playerGone(lobby, playerId) {
  lobby.game.tp.answers.delete(playerId);
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function tpPublic(lobby, viewerId) {
  const tp = lobby.game?.tp;
  if (!tp || !lobby.state.startsWith('tp-')) return null;
  return {
    phase: lobby.state,
    index: tp.index,
    total: lobby.game.totalRounds,
    question: tp.questions[tp.index],
    myAnswer: tp.answers.get(viewerId) ?? null,
    doneIds: [...tp.answers.keys()].filter((id) => lobby.players.has(id)),
    deadline: tp.deadline,
    timer: tp.settings.timer,
    serverNow: Date.now(),
  };
}

export function tpLimits(lobby) {
  const bank = lobby.tpBank ?? getBank();
  return { minPlayers: MIN_PLAYERS, rounds: [...TP_LIMITS.rounds], timers: [...TP_LIMITS.timers], points: { ...TP_POINTS }, questions: bank.size };
}

export function defaultSettings() {
  return { ...TP_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { tpRounds, tpTimer }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (tpRounds !== undefined) next.rounds = pickFrom(TP_LIMITS.rounds, tpRounds, 'Nombre de questions');
  if (tpTimer !== undefined) next.timer = pickFrom(TP_LIMITS.timers, tpTimer, 'Chrono');
  return next;
}
