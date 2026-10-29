import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { GameError } from '../game/errors.js';
import { assignRanks } from '../game/ranking.js';

/**
 * Le Juste Prix : des estimations (prix, poids, distances, volumes, population, PIB, temps…)
 * et des classements (« du plus haut au moins haut »).
 *   jp-question (chacun répond, chrono facultatif) → jp-reveal (bonne réponse + points) → … → finished
 * La bonne réponse n'est JAMAIS envoyée aux navigateurs avant la révélation.
 */

export const JP_CATEGORIES = Object.freeze([
  { id: 'prix', label: 'Prix & argent', emoji: '💶' },
  { id: 'poids', label: 'Poids', emoji: '⚖️' },
  { id: 'distances', label: 'Tailles & distances', emoji: '📏' },
  { id: 'volumes', label: 'Volumes', emoji: '🧴' },
  { id: 'population', label: 'Population & foules', emoji: '👥' },
  { id: 'economie', label: 'PIB & économie', emoji: '📈' },
  { id: 'temps', label: 'Temps, dates & vitesses', emoji: '⏱️' },
  { id: 'classements', label: 'Classements (Top 1, 2, 3…)', emoji: '🏆' },
]);
export const JP_CATEGORY_IDS = JP_CATEGORIES.map((c) => c.id);

// Points (à ajuster ici) : le plus proche, le 2e, le 3e ; bonus si pile (à 1 % près).
export const JP_POINTS = Object.freeze({ ranks: [3, 2, 1], exactBonus: 2, rankingItem: 1, rankingPerfect: 2 });
export const JP_GRACE_MS = 800;

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// --- Saisie des nombres : « 1 234,5 », « 1.234,5 », « 1234.5 », « 12k », « 3 millions »… ------------

const MULTIPLIERS = [
  [/\s*(milliards?|mds?)$/i, 1e9],
  [/\s*(millions?)$/i, 1e6],
  [/\s*(mille|k)$/i, 1e3],
];

export function parseNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/[\s  ']/g, ' ').replace(/[€$%]/g, '').trim();
  let factor = 1;
  for (const [pattern, value] of MULTIPLIERS) {
    if (pattern.test(text)) {
      factor = value;
      text = text.replace(pattern, '');
      break;
    }
  }
  text = text.replace(/ /g, '');
  if (!/^-?[\d.,]+$/.test(text)) return null;
  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  if (dots && commas) {
    // Le dernier séparateur est la virgule décimale : « 1.234,5 » ou « 1,234.5 »
    text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (commas > 1) {
    text = text.replace(/,/g, '');
  } else if (dots > 1) {
    text = text.replace(/\./g, '');
  } else {
    text = text.replace(',', '.');
  }
  const value = Number(text) * factor;
  if (!Number.isFinite(value) || Math.abs(value) > 1e15) return null;
  return Math.round(value * 1e6) / 1e6;
}

// --- Banque de questions (data/justeprix.json, relu automatiquement s'il change) -----------------

function parseBank(raw) {
  const data = JSON.parse(raw);
  const estimates = (Array.isArray(data.questions) ? data.questions : [])
    .filter((q) => JP_CATEGORY_IDS.includes(q?.cat) && q.cat !== 'classements' && typeof q.q === 'string' && Number.isFinite(q.a))
    .map((q) => ({
      key: `${q.cat}:${q.q}`,
      cat: q.cat,
      kind: 'estimate',
      prompt: q.q.trim(),
      answer: q.a,
      unit: typeof q.unit === 'string' ? q.unit.trim() : '',
      info: typeof q.info === 'string' ? q.info.trim() : null,
    }));
  const rankings = (Array.isArray(data.classements) ? data.classements : [])
    .filter((r) => typeof r?.q === 'string' && Array.isArray(r.items) && r.items.length >= 3)
    .filter((r) => r.items.every((item) => Array.isArray(item) && typeof item[0] === 'string' && Number.isFinite(item[1])))
    .map((r) => ({
      key: `classements:${r.theme ?? ''}:${r.q}`,
      cat: 'classements',
      kind: 'ranking',
      theme: typeof r.theme === 'string' ? r.theme.trim() : '',
      prompt: r.q.trim(),
      unit: typeof r.unit === 'string' ? r.unit.trim() : '',
      items: r.items.slice(0, 6).map(([label, value]) => ({ label: label.trim(), value })),
    }));
  if (estimates.length + rankings.length === 0) throw new Error('Aucune question valide.');
  return [...estimates, ...rankings];
}

export function createJustePrixBank(questions) {
  let list = [...questions];
  return {
    get size() {
      return list.length;
    },
    replace(next) {
      list = [...next];
    },
    counts() {
      return Object.fromEntries(JP_CATEGORY_IDS.map((id) => [id, list.filter((q) => q.cat === id).length]));
    },
    // Questions réparties entre les catégories choisies, sans répéter celles déjà jouées dans le lobby.
    pick({ categories, count }, used = new Set()) {
      const chosen = JP_CATEGORY_IDS.filter((id) => categories.includes(id) && list.some((q) => q.cat === id));
      if (chosen.length === 0) return [];
      const queues = new Map(
        chosen.map((id) => {
          const all = list.filter((q) => q.cat === id);
          let fresh = all.filter((q) => !used.has(q.key));
          if (fresh.length === 0) {
            for (const q of all) used.delete(q.key);
            fresh = all;
          }
          return [id, shuffle(fresh)];
        }),
      );
      const picked = [];
      let order = shuffle(chosen);
      while (picked.length < count && order.length) {
        for (const id of order) {
          if (picked.length >= count) break;
          const next = queues.get(id).shift();
          if (next) picked.push(next);
        }
        order = order.filter((id) => queues.get(id).length > 0);
      }
      for (const q of picked) used.add(q.key);
      // Classements : les propositions sont mélangées pour l'affichage.
      return shuffle(picked).map((q) => (q.kind === 'ranking' ? { ...q, shuffled: shuffle(q.items.map((i) => i.label)) } : q));
    },
  };
}

export function loadJustePrixBank(fileUrl) {
  let mtime = statSync(fileUrl).mtimeMs;
  const bank = createJustePrixBank(parseBank(readFileSync(fileUrl, 'utf8')));
  const refresh = () => {
    try {
      const current = statSync(fileUrl).mtimeMs;
      if (current === mtime) return;
      bank.replace(parseBank(readFileSync(fileUrl, 'utf8')));
      mtime = current;
      console.log(`[juste-prix] Fichier rechargé (${bank.size} questions).`);
    } catch (error) {
      console.warn('[juste-prix] Rechargement impossible, on garde la version précédente :', error.message);
    }
  };
  const basePick = bank.pick;
  const baseCounts = bank.counts;
  bank.pick = (options, used) => {
    refresh();
    return basePick(options, used);
  };
  bank.counts = () => {
    refresh();
    return baseCounts();
  };
  return bank;
}

// --- Déroulé de la partie (fonctions appelées par Lobby) -------------------------------------------

export function startJustePrix(lobby, base) {
  const { justePrix } = lobby.settings;
  const questions = lobby.justePrixBank?.pick({ categories: justePrix.categories, count: lobby.settings.rounds }, lobby.usedJustePrix) ?? [];
  if (questions.length === 0) throw new GameError('NO_QUESTIONS', 'Aucune question disponible dans les catégories choisies.');
  lobby.clearQuizTimer();
  lobby.game = { ...base, questions, totalRounds: questions.length, timer: justePrix.timer, answers: new Map(), deadline: null };
  openQuestion(lobby);
}

function openQuestion(lobby) {
  const { game } = lobby;
  lobby.clearQuizTimer();
  game.answers = new Map();
  game.result = null;
  game.deadline = game.timer > 0 ? Date.now() + game.timer * 1000 : null;
  lobby.state = 'jp-question';
  if (game.deadline) {
    const index = game.index;
    lobby.quizTimer = setTimeout(() => {
      lobby.quizTimer = null;
      if (lobby.state !== 'jp-question' || lobby.game?.index !== index) return;
      reveal(lobby);
      lobby.onChange?.(lobby);
    }, game.timer * 1000 + JP_GRACE_MS);
    lobby.quizTimer.unref?.();
  }
}

const current = (game) => game.questions[game.index];

export function submitAnswer(lobby, playerId, { index, value } = {}) {
  if (lobby.state !== 'jp-question') throw new GameError('NOT_ANSWERING', 'Ce n’est plus le moment de répondre.');
  const { game } = lobby;
  if (index !== game.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la question suivante !');
  const question = current(game);
  if (question.kind === 'ranking') {
    const labels = question.items.map((i) => i.label);
    if (!Array.isArray(value) || value.length !== labels.length || new Set(value).size !== labels.length || !value.every((v) => labels.includes(v))) {
      throw new GameError('INVALID_ANSWER', 'Classe toutes les propositions avant de valider.');
    }
    game.answers.set(playerId, [...value]);
  } else {
    const number = parseNumber(value);
    if (number === null) throw new GameError('INVALID_ANSWER', 'Écris un nombre (ex : 1 234,5).');
    game.answers.set(playerId, number);
  }
  checkAllAnswered(lobby);
}

export function checkAllAnswered(lobby) {
  if (lobby.state !== 'jp-question') return false;
  const players = lobby.connectedPlayers;
  if (players.length === 0 || !players.every((p) => lobby.game.answers.has(p.id))) return false;
  reveal(lobby);
  return true;
}

export function reveal(lobby) {
  const { game } = lobby;
  lobby.clearQuizTimer();
  game.deadline = null;
  const question = current(game);
  const result = question.kind === 'ranking' ? scoreRanking(lobby, question) : scoreEstimate(lobby, question);
  for (const entry of result.entries) {
    if (entry.points) game.totals[entry.playerId] = (game.totals[entry.playerId] ?? 0) + entry.points;
  }
  const best = Math.max(0, ...result.entries.map((e) => e.points));
  game.history.push({
    question: question.kind === 'ranking' ? `🏆 ${question.theme} : ${question.prompt.toLowerCase()}` : question.prompt,
    answer: question.kind === 'ranking' ? question.items.map((i) => i.label).join(' > ') : `${formatNumber(question.answer)} ${question.unit}`.trim(),
    topPlayerIds: best > 0 ? result.entries.filter((e) => e.points === best).map((e) => e.playerId) : [],
  });
  result.scores = { ...game.totals }; // scores cumulés, pour le mini-classement
  game.result = result;
  lobby.state = 'jp-reveal';
}

function scoreEstimate(lobby, question) {
  const { game } = lobby;
  const tolerance = question.unit === 'année' ? 0 : Math.abs(question.answer) * 0.01;
  const answered = [...game.answers]
    .filter(([id]) => lobby.players.has(id))
    .map(([playerId, value]) => ({
      playerId,
      value,
      diff: Math.abs(value - question.answer),
      percent: question.answer ? Math.round(((value - question.answer) / Math.abs(question.answer)) * 1000) / 10 : null,
    }))
    .sort((a, b) => a.diff - b.diff);
  assignRanks(answered, (e) => e.diff);
  for (const entry of answered) {
    entry.exact = entry.diff <= tolerance;
    entry.points = (JP_POINTS.ranks[entry.rank - 1] ?? 0) + (entry.exact ? JP_POINTS.exactBonus : 0);
  }
  const missing = lobby.playerIds
    .filter((id) => !game.answers.has(id))
    .map((playerId) => ({ playerId, value: null, diff: null, percent: null, rank: null, exact: false, points: 0 }));
  return {
    type: 'juste-prix',
    kind: 'estimate',
    question: publicQuestion(question),
    answer: question.answer,
    unit: question.unit,
    info: question.info,
    entries: [...answered, ...missing],
  };
}

function scoreRanking(lobby, question) {
  const { game } = lobby;
  const correct = question.items.map((i) => i.label);
  const entries = lobby.playerIds.map((playerId) => {
    const order = game.answers.get(playerId) ?? null;
    if (!order) return { playerId, order: null, marks: [], good: 0, points: 0 };
    const marks = order.map((label, i) => label === correct[i]);
    const good = marks.filter(Boolean).length;
    const points = good * JP_POINTS.rankingItem + (good === correct.length ? JP_POINTS.rankingPerfect : 0);
    return { playerId, order, marks, good, points };
  });
  entries.sort((a, b) => b.points - a.points);
  return {
    type: 'juste-prix',
    kind: 'ranking',
    question: publicQuestion(question),
    items: question.items,
    unit: question.unit,
    entries,
  };
}

export function nextJustePrix(lobby) {
  const { game } = lobby;
  if (game.index + 1 >= game.totalRounds) {
    game.index += 1;
    return 'finish';
  }
  game.index += 1;
  openQuestion(lobby);
  return 'next';
}

// Le joueur part définitivement : sa réponse disparaît, on vérifie si tout le monde a répondu.
export function playerGone(lobby, playerId) {
  lobby.game.answers?.delete(playerId);
}

export function formatNumber(value) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(value);
}

function publicQuestion(question) {
  const { cat, kind, prompt, unit, theme, shuffled } = question;
  return { cat, kind, prompt, unit, theme, choices: kind === 'ranking' ? shuffled : undefined };
}

export function justePrixPublic(lobby) {
  const { game, state } = lobby;
  if (state !== 'jp-question') return null;
  return {
    index: game.index,
    total: game.totalRounds,
    deadline: game.deadline,
    serverNow: Date.now(),
    timer: game.timer,
    question: publicQuestion(current(game)),
  };
}

export function justePrixPrivate(lobby, viewerId) {
  if (lobby.state !== 'jp-question') return null;
  const answer = lobby.game.answers.get(viewerId);
  return { answered: answer !== undefined, answer: answer ?? null };
}
