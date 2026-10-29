import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { GameError } from '../game/errors.js';
import { levenshtein, normalize } from '../mculture/match.js';

/**
 * Paint (façon Skribbl) : à tour de rôle, un joueur dessine un mot, les autres devinent dans le chat.
 *   paint-choose (le dessinateur choisit facile / moyen / difficile)
 *   → paint-draw (dessin en direct + chrono + indices de lettres)
 *   → paint-end (le mot est révélé, points de la manche) → … → finished
 * Le mot n'est JAMAIS envoyé aux joueurs qui ne l'ont pas encore trouvé.
 */

export const PAINT_LIMITS = Object.freeze({
  turns: { min: 1, max: 5, default: 1 }, // nombre de fois que chaque joueur dessine
  timers: [60, 80, 100, 120, 150, 180],
  defaultTimer: 80,
});
export const DIFFICULTIES = Object.freeze({
  facile: { label: 'Facile', points: 1 },
  moyen: { label: 'Moyen', points: 2 },
  difficile: { label: 'Difficile', points: 3 },
});
const CHOOSE_MS = 15_000; // temps pour choisir le mot (sinon tiré au hasard)
const END_MS = 7_000; // affichage du mot avant la manche suivante
const GRACE_MS = 600;
const CHAT_MAX = 80;
const GUESS_MAX = 60;
const CANVAS = 800; // taille logique du dessin (identique sur tous les écrans)
const MAX_POINTS = 80_000; // garde-fou : points de dessin par manche
const COLOR = /^#[0-9a-f]{6}$/i;
const TOOLS = new Set(['pen', 'marker', 'spray', 'eraser']);

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// --- Mots (data/paint.json, relu automatiquement s'il change) -----------------------------------

function parseWords(raw) {
  const data = JSON.parse(raw);
  const lists = {};
  for (const level of Object.keys(DIFFICULTIES)) {
    lists[level] = [...new Set((Array.isArray(data[level]) ? data[level] : []).filter((w) => typeof w === 'string').map((w) => w.trim()).filter(Boolean))];
    if (lists[level].length === 0) throw new Error(`Aucun mot « ${level} ».`);
  }
  return lists;
}

export function createPaintWords(lists) {
  let words = { ...lists };
  return {
    replace(next) {
      words = { ...next };
    },
    counts() {
      return Object.fromEntries(Object.entries(words).map(([k, v]) => [k, v.length]));
    },
    // Un mot par difficulté, en évitant ceux déjà dessinés dans le lobby.
    pickChoices(used = new Set()) {
      const choices = {};
      for (const level of Object.keys(DIFFICULTIES)) {
        let pool = words[level].filter((w) => !used.has(w));
        if (pool.length === 0) {
          for (const w of words[level]) used.delete(w);
          pool = words[level];
        }
        choices[level] = pool[randomInt(pool.length)];
        used.add(choices[level]);
      }
      return choices;
    },
  };
}

export function loadPaintWords(fileUrl) {
  let mtime = statSync(fileUrl).mtimeMs;
  const bank = createPaintWords(parseWords(readFileSync(fileUrl, 'utf8')));
  const refresh = () => {
    try {
      const current = statSync(fileUrl).mtimeMs;
      if (current === mtime) return;
      bank.replace(parseWords(readFileSync(fileUrl, 'utf8')));
      mtime = current;
      console.log('[paint] Liste de mots rechargée.');
    } catch (error) {
      console.warn('[paint] Rechargement impossible, on garde la version précédente :', error.message);
    }
  };
  const basePick = bank.pickChoices;
  const baseCounts = bank.counts;
  bank.pickChoices = (used) => {
    refresh();
    return basePick(used);
  };
  bank.counts = () => {
    refresh();
    return baseCounts();
  };
  return bank;
}

// --- Comparaison des réponses -------------------------------------------------------------------
// Accents, majuscules, articles et tirets ignorés. Une lettre de travers (deux pour un mot long) = « proche ».

const compact = (text) => normalize(text).replace(/ /g, '');

export function judgeGuess(guess, word) {
  const g = compact(guess);
  const w = compact(word);
  if (!g) return 'empty';
  if (g === w) return 'correct';
  const allowed = w.length >= 8 ? 2 : 1;
  if (w.length >= 3 && Math.abs(g.length - w.length) <= allowed && levenshtein(g, w) <= allowed) return 'close';
  return 'wrong';
}

// --- Indices : quelques lettres dévoilées au fil du chrono, jamais trop ------------------------------

function hintPlan(word) {
  const letters = [...word].map((ch, i) => (/[\p{L}\p{N}]/u.test(ch) ? i : -1)).filter((i) => i >= 0);
  const L = letters.length;
  let count = L <= 3 ? 0 : L <= 5 ? 1 : L <= 8 ? 2 : 3;
  count = Math.min(count, Math.floor(L / 3));
  const at = { 0: [], 1: [0.6], 2: [0.5, 0.75], 3: [0.45, 0.65, 0.85] }[count];
  return { positions: shuffle(letters).slice(0, count), at };
}

export function maskWord(word, revealed = []) {
  return [...word].map((ch, i) => (!/[\p{L}\p{N}]/u.test(ch) ? ch : revealed.includes(i) ? ch : '_'));
}

// --- Déroulé de la partie -------------------------------------------------------------------------

export function startPaint(lobby, base) {
  const ids = lobby.connectedPlayers.map((p) => p.id);
  const { turns, timer } = lobby.settings.paint;
  const order = [];
  for (let t = 0; t < turns; t += 1) order.push(...shuffle(ids));
  lobby.clearQuizTimer();
  lobby.game = { ...base, order, totalRounds: order.length, turns, timer, manche: null, index: -1 };
  nextManche(lobby);
}

function schedule(lobby, ms, fn) {
  const timer = setTimeout(() => {
    lobby.extraTimers = (lobby.extraTimers ?? []).filter((t) => t !== timer);
    fn();
  }, ms);
  timer.unref?.();
  lobby.extraTimers = [...(lobby.extraTimers ?? []), timer];
}

const isCurrent = (lobby, index, state) => lobby.game?.kind === 'paint' && lobby.game.index === index && lobby.state === state;

// Passe à la manche suivante (en sautant les dessinateurs partis) ou termine la partie.
export function nextManche(lobby) {
  const { game } = lobby;
  lobby.clearQuizTimer();
  while (game.index + 1 < game.order.length) {
    game.index += 1;
    const drawerId = game.order[game.index];
    if (!lobby.players.get(drawerId)?.connected) continue;
    game.manche = {
      drawerId,
      choices: lobby.paintWords.pickChoices(lobby.usedPaintWords),
      chooseDeadline: Date.now() + CHOOSE_MS,
      word: null,
      difficulty: null,
      deadline: null,
      revealed: [],
      found: new Map(), // joueur → ordre d'arrivée
      status: new Map(), // joueur → 'wrong' | 'close' (dernière tentative)
      chat: [],
      ops: [],
      points: 0,
      result: null,
      nextAt: null,
    };
    lobby.state = 'paint-choose';
    const { index } = game;
    schedule(lobby, CHOOSE_MS + GRACE_MS, () => {
      if (!isCurrent(lobby, index, 'paint-choose')) return;
      const levels = Object.keys(DIFFICULTIES);
      chooseWord(lobby, drawerId, levels[randomInt(levels.length)]);
      lobby.onChange?.(lobby);
    });
    return 'next';
  }
  game.index = game.order.length;
  return 'finish';
}

export function chooseWord(lobby, playerId, difficulty) {
  const m = lobby.game?.manche;
  if (lobby.state !== 'paint-choose') throw new GameError('NOT_CHOOSING', 'Le mot est déjà choisi.');
  if (m.drawerId !== playerId) throw new GameError('NOT_DRAWER', 'C’est au dessinateur de choisir.');
  if (!DIFFICULTIES[difficulty]) throw new GameError('INVALID_CHOICE', 'Choix invalide.');
  lobby.clearQuizTimer();
  m.difficulty = difficulty;
  m.word = m.choices[difficulty];
  const duration = lobby.game.timer * 1000;
  m.startedAt = Date.now();
  m.deadline = m.startedAt + duration;
  lobby.state = 'paint-draw';
  const { index } = lobby.game;
  const plan = hintPlan(m.word);
  plan.at.forEach((fraction, i) => {
    schedule(lobby, duration * fraction, () => {
      if (!isCurrent(lobby, index, 'paint-draw')) return;
      m.revealed.push(plan.positions[i]);
      addChat(m, { kind: 'system', text: 'Un indice est apparu 💡' });
      lobby.onChange?.(lobby);
    });
  });
  schedule(lobby, duration + GRACE_MS, () => {
    if (!isCurrent(lobby, index, 'paint-draw')) return;
    endManche(lobby, 'time');
    lobby.onChange?.(lobby);
  });
}

function addChat(m, entry) {
  m.chat.push({ id: m.chat.length + 1, at: Date.now(), ...entry });
  if (m.chat.length > CHAT_MAX) m.chat.splice(0, m.chat.length - CHAT_MAX);
}

export function submitGuess(lobby, playerId, rawText) {
  if (lobby.state !== 'paint-draw') throw new GameError('NOT_DRAWING', 'Ce n’est pas le moment de deviner.');
  const m = lobby.game.manche;
  const text = typeof rawText === 'string' ? rawText.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, GUESS_MAX) : '';
  if (!text) throw new GameError('EMPTY_GUESS', 'Écris quelque chose.');

  // Le dessinateur peut parler, mais pas donner le mot.
  if (playerId === m.drawerId) {
    if (compact(text).includes(compact(m.word)) || judgeGuess(text, m.word) !== 'wrong') {
      throw new GameError('NO_SPOILER', 'Pas le droit d’écrire le mot 😉');
    }
    addChat(m, { kind: 'drawer', playerId, text });
    return 'drawer';
  }
  // Ceux qui ont trouvé discutent entre eux (invisible pour les autres).
  if (m.found.has(playerId)) {
    addChat(m, { kind: 'secret', playerId, text });
    return 'secret';
  }
  const verdict = judgeGuess(text, m.word);
  if (verdict === 'correct') {
    m.found.set(playerId, m.found.size + 1);
    m.status.delete(playerId);
    addChat(m, { kind: 'found', playerId });
    checkAllFound(lobby);
    return 'correct';
  }
  m.status.set(playerId, verdict === 'close' ? 'close' : 'wrong');
  addChat(m, { kind: verdict === 'close' ? 'close' : 'guess', playerId, text });
  return verdict;
}

function guessers(lobby) {
  const m = lobby.game.manche;
  return lobby.connectedPlayers.filter((p) => p.id !== m.drawerId);
}

export function checkAllFound(lobby) {
  if (lobby.state !== 'paint-draw') return false;
  const list = guessers(lobby);
  if (list.length > 0 && !list.every((p) => lobby.game.manche.found.has(p.id))) return false;
  endManche(lobby, list.length === 0 ? 'alone' : 'all-found');
  return true;
}

// Après une déconnexion : dessinateur parti → fin de manche ; sinon tout le monde a peut-être trouvé.
export function progress(lobby) {
  const m = lobby.game?.manche;
  if (!m || !['paint-choose', 'paint-draw'].includes(lobby.state)) return false;
  if (!lobby.players.get(m.drawerId)?.connected) {
    endManche(lobby, 'drawer-left');
    return true;
  }
  return lobby.state === 'paint-draw' ? checkAllFound(lobby) : false;
}

// Points : le 1er qui trouve 3 × la difficulté, le 2e 2 ×, les suivants 1 × ; le dessinateur 1 × par joueur qui trouve.
export function endManche(lobby, reason) {
  const { game } = lobby;
  const m = game.manche;
  lobby.clearQuizTimer();
  const mult = m.difficulty ? DIFFICULTIES[m.difficulty].points : 0;
  const points = {};
  for (const [playerId, order] of m.found) points[playerId] = mult * (order === 1 ? 3 : order === 2 ? 2 : 1);
  if (m.found.size) points[m.drawerId] = mult * m.found.size;
  for (const [id, pts] of Object.entries(points)) game.totals[id] = (game.totals[id] ?? 0) + pts;
  const drawer = lobby.players.get(m.drawerId);
  m.result = {
    reason,
    word: m.word,
    difficulty: m.difficulty,
    points,
    foundIds: [...m.found.keys()],
    scores: { ...game.totals },
  };
  if (m.word) {
    game.history.push({
      question: `🎨 « ${m.word} » (${DIFFICULTIES[m.difficulty].label.toLowerCase()})`,
      answer: `dessiné par ${drawer?.name ?? 'un joueur parti'}`,
      topPlayerIds: [...m.found.keys()],
    });
  }
  lobby.state = 'paint-end';
  m.nextAt = Date.now() + END_MS;
  const { index } = game;
  schedule(lobby, END_MS, () => {
    if (!isCurrent(lobby, index, 'paint-end')) return;
    if (nextManche(lobby) === 'finish') lobby.finish();
    lobby.onChange?.(lobby);
  });
}

// L'hôte : passer la manche en cours (dessinateur absent…) ou ne pas attendre la suivante.
export function hostSkip(lobby) {
  if (lobby.state === 'paint-end') return nextManche(lobby);
  if (lobby.state === 'paint-choose' || lobby.state === 'paint-draw') {
    endManche(lobby, 'skipped');
    return 'ended';
  }
  throw new GameError('NOT_NOW', 'Rien à passer pour le moment.');
}

export function playerGone(lobby, playerId) {
  const m = lobby.game?.manche;
  if (!m) return;
  m.found.delete(playerId);
  m.status.delete(playerId);
}

// --- Dessin en direct ------------------------------------------------------------------------------

const clampInt = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

/** Valide une action du dessinateur. Renvoie { op } à diffuser, ou { reset: ops } après « annuler ». */
export function draw(lobby, playerId, raw) {
  if (lobby.state !== 'paint-draw') throw new GameError('NOT_DRAWING', 'Ce n’est pas le moment de dessiner.');
  const m = lobby.game.manche;
  if (m.drawerId !== playerId) throw new GameError('NOT_DRAWER', 'Ce n’est pas ton tour de dessiner.');
  if (!raw || typeof raw !== 'object') throw new GameError('INVALID_DRAW', 'Dessin invalide.');

  if (raw.t === 'u') {
    // Annuler : retire le dernier trait entier (ou le dernier remplissage / effacement).
    const last = m.ops.at(-1);
    if (last) {
      if (last.t === 's') m.ops = m.ops.filter((op) => !(op.t === 's' && op.id === last.id));
      else m.ops.pop();
    }
    return { reset: m.ops };
  }
  if (raw.t === 'c') {
    const op = { t: 'c' };
    m.ops.push(op);
    return { op };
  }
  if (raw.t === 'f') {
    if (!COLOR.test(raw.color)) throw new GameError('INVALID_DRAW', 'Couleur invalide.');
    const op = { t: 'f', x: clampInt(raw.x, 0, CANVAS - 1), y: clampInt(raw.y, 0, CANVAS - 1), color: raw.color.toLowerCase() };
    m.ops.push(op);
    return { op };
  }
  if (raw.t === 's') {
    if (!TOOLS.has(raw.tool) || !COLOR.test(raw.color) || typeof raw.id !== 'string' || raw.id.length > 20) {
      throw new GameError('INVALID_DRAW', 'Trait invalide.');
    }
    if (!Array.isArray(raw.pts) || raw.pts.length < 2 || raw.pts.length % 2 || raw.pts.length > 600) {
      throw new GameError('INVALID_DRAW', 'Trait invalide.');
    }
    m.points += raw.pts.length / 2;
    if (m.points > MAX_POINTS) throw new GameError('TOO_MUCH', 'Le dessin est trop chargé, efface un peu !');
    const op = {
      t: 's',
      id: raw.id,
      tool: raw.tool,
      color: raw.color.toLowerCase(),
      size: clampInt(raw.size, 2, 80),
      pts: raw.pts.map((v) => clampInt(v, -20, CANVAS + 20)),
    };
    m.ops.push(op);
    return { op };
  }
  throw new GameError('INVALID_DRAW', 'Action de dessin inconnue.');
}

export function syncOps(lobby) {
  const m = lobby.game?.manche;
  if (!m || lobby.game.kind !== 'paint') return { key: null, ops: [] };
  return { key: lobby.game.index, ops: m.ops };
}

// --- Ce que voit chaque joueur -----------------------------------------------------------------------

export function paintPublic(lobby, viewerId) {
  const { game, state } = lobby;
  const m = game.manche;
  if (!m || !['paint-choose', 'paint-draw', 'paint-end'].includes(state)) return null;
  const isDrawer = viewerId === m.drawerId;
  const knowsWord = isDrawer || m.found.has(viewerId) || state === 'paint-end';
  const statuses = {};
  for (const id of m.found.keys()) statuses[id] = 'found';
  for (const [id, s] of m.status) statuses[id] = s;
  statuses[m.drawerId] = 'drawing';
  const chat = m.chat
    .filter((c) => c.kind !== 'secret' || knowsWord)
    .map((c) => (c.kind === 'close' && c.playerId !== viewerId && !isDrawer ? { ...c, text: null } : c));
  return {
    key: game.index,
    manche: game.index + 1,
    total: game.totalRounds,
    turns: game.turns,
    drawerId: m.drawerId,
    timer: game.timer,
    serverNow: Date.now(),
    chooseDeadline: state === 'paint-choose' ? m.chooseDeadline : null,
    deadline: state === 'paint-draw' ? m.deadline : null,
    difficulty: m.difficulty,
    mask: m.word && state === 'paint-draw' && !knowsWord ? maskWord(m.word, m.revealed) : null,
    word: m.word && knowsWord ? m.word : null,
    choices: state === 'paint-choose' && isDrawer ? m.choices : null,
    statuses,
    scores: { ...game.totals },
    chat,
    result: state === 'paint-end' ? m.result : null,
    nextAt: state === 'paint-end' ? m.nextAt : null,
  };
}
