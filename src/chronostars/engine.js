import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError } from '../game/errors.js';

/**
 * Chrono Stars (façon Time's Up) : deux équipes font deviner des personnalités, avec le MÊME paquet sur 3 manches.
 *   manche 1 : description libre · manche 2 : un seul mot · manche 3 : mime
 *   cs-ready       : on annonce qui fait deviner ; il lance son chrono quand tout le monde est prêt
 *   cs-play        : son téléphone montre la carte (✅ Trouvé / ⏭ Passer dès la manche 2) jusqu'à la fin du chrono
 *   cs-manche-end  : le paquet est vide → points de la manche → manche suivante → … → finished
 * La carte n'est montrée qu'à celui qui fait deviner… et à l'équipe adverse, qui vérifie qu'il ne triche pas.
 * Points : chaque carte trouvée rapporte 1 pt à chaque membre de l'équipe.
 */

export const MIN_PLAYERS = 4;
export const TEAMS = Object.freeze(['rouge', 'bleu']);
export const CS_MANCHES = Object.freeze([
  { label: 'Description', emoji: '🗣️', rule: 'Fais deviner comme tu veux… sans dire le nom, ni un bout du nom !', pass: false },
  { label: 'Un seul mot', emoji: '☝️', rule: 'Un seul mot par carte, pas plus ! Tu peux passer une carte.', pass: true },
  { label: 'Mime', emoji: '🤫', rule: 'Mimes et bruitages uniquement, aucun mot ! Tu peux passer une carte.', pass: true },
]);
export const CS_CATEGORIES = Object.freeze([
  { id: 'stars', label: 'Stars d’aujourd’hui', emoji: '⭐' },
  { id: 'histoire', label: 'Personnages historiques', emoji: '📜' },
  { id: 'fiction', label: 'Héros de fiction', emoji: '🦸' },
]);
export const CS_CATEGORY_IDS = CS_CATEGORIES.map((c) => c.id);
export const CS_LIMITS = Object.freeze({
  cards: [20, 30, 40, 50],
  timers: [30, 45, 60, 90],
  defaults: { cards: 30, timer: 45 },
});
const GRACE_MS = 1_500;
export const CARDS_FILE = fileURLToPath(new URL('../../data/chronostars.json', import.meta.url));

const other = (team) => (team === 'rouge' ? 'bleu' : 'rouge');

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// --- Personnalités (data/chronostars.json, relu automatiquement s'il change) ---------------------------------

function parseCards(raw) {
  const data = JSON.parse(raw);
  const list = [];
  for (const cat of CS_CATEGORY_IDS) {
    const seen = new Set();
    for (const name of Array.isArray(data[cat]) ? data[cat] : []) {
      if (typeof name !== 'string' || !name.trim() || seen.has(name.trim().toLowerCase())) continue;
      seen.add(name.trim().toLowerCase());
      list.push({ key: `${cat}:${name.trim()}`, cat, name: name.trim() });
    }
  }
  if (list.length === 0) throw new Error('Aucune personnalité valide.');
  return list;
}

export function createCardBank(cards) {
  let list = [...cards];
  return {
    get size() {
      return list.length;
    },
    replace(next) {
      list = [...next];
    },
    counts() {
      return Object.fromEntries(CS_CATEGORY_IDS.map((id) => [id, list.filter((c) => c.cat === id).length]));
    },
    // Cartes réparties entre les thèmes choisis, jamais déjà jouées dans ce lobby (on recommence quand tout est joué).
    pick({ categories, count }, used = new Set()) {
      const chosen = CS_CATEGORY_IDS.filter((id) => categories.includes(id) && list.some((c) => c.cat === id));
      const queues = new Map(
        chosen.map((id) => {
          const all = list.filter((c) => c.cat === id);
          let fresh = all.filter((c) => !used.has(c.key));
          if (fresh.length < count / chosen.length) {
            for (const c of all) used.delete(c.key);
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
      for (const c of picked) used.add(c.key);
      return picked;
    },
  };
}

export function loadCardBank(file = CARDS_FILE) {
  let mtime = statSync(file).mtimeMs;
  const bank = createCardBank(parseCards(readFileSync(file, 'utf8')));
  const refresh = () => {
    try {
      const current = statSync(file).mtimeMs;
      if (current === mtime) return;
      bank.replace(parseCards(readFileSync(file, 'utf8')));
      mtime = current;
      console.log(`[chrono-stars] Fichier rechargé (${bank.size} personnalités).`);
    } catch (error) {
      console.warn('[chrono-stars] Rechargement impossible, on garde la version précédente :', error.message);
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

let sharedBank = null;
export function getBank() {
  if (!sharedBank) sharedBank = loadCardBank();
  return sharedBank;
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const csOf = (lobby) => lobby.game.cs;
const isConnected = (lobby, id) => Boolean(lobby.players.get(id)?.connected);
const connectedOf = (lobby, team) => csOf(lobby).order[team].filter((id) => isConnected(lobby, id));
const cardName = (cs, id) => cs.cards.find((c) => c.id === id)?.name ?? '?';

function setTimer(lobby, seconds, fn) {
  const cs = csOf(lobby);
  lobby.clearQuizTimer();
  const token = ++cs.token;
  cs.deadline = Date.now() + seconds * 1000;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.cs !== cs || cs.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, seconds * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

function stopTimer(lobby) {
  const cs = csOf(lobby);
  lobby.clearQuizTimer();
  cs.token += 1;
  cs.deadline = null;
}

export function startChronoStars(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  lobby.csBank ??= getBank();
  lobby.usedCsCards ??= new Set();
  const settings = { ...lobby.settings.chronoStars };
  const picked = lobby.csBank.pick({ categories: settings.categories, count: settings.cards }, lobby.usedCsCards);
  if (picked.length < 5) throw new GameError('NO_CARDS', 'Pas assez de personnalités dans les thèmes choisis.');
  // Équipes fixes pour toute la partie, tirées au hasard.
  const ids = shuffle(lobby.connectedPlayers.map((p) => p.id));
  const half = Math.ceil(ids.length / 2);
  const first = TEAMS[randomInt(2)];
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: CS_MANCHES.length,
    cs: {
      settings,
      cards: picked.map((c, i) => ({ id: `c${i + 1}`, name: c.name, cat: c.cat })),
      order: { [first]: ids.slice(0, half), [other(first)]: ids.slice(half) },
      pointer: { rouge: 0, bleu: 0 }, // prochain joueur à faire deviner dans chaque équipe
      manche: 0,
      deck: [],
      current: null,
      turnTeam: null,
      clueur: null,
      turnNo: 0,
      turnFound: [],
      turnPasses: 0,
      lastTurn: null,
      found: [], // par manche : { rouge: [ids], bleu: [ids] }
      first,
      token: 0,
      deadline: null,
      result: null,
    },
  };
  openManche(lobby);
}

function openManche(lobby) {
  const cs = csOf(lobby);
  cs.deck = shuffle(cs.cards.map((c) => c.id));
  cs.found[cs.manche] = { rouge: [], bleu: [] };
  cs.lastTurn = null;
  cs.result = null;
  lobby.game.index = cs.manche;
  // L'équipe qui commence alterne : celle qui n'a pas joué le dernier tour.
  openReady(lobby, cs.turnTeam ? other(cs.turnTeam) : cs.first);
}

// Prochain joueur connecté de l'équipe, à tour de rôle.
function nextClueur(lobby, team) {
  const cs = csOf(lobby);
  const list = cs.order[team];
  for (let k = 0; k < list.length; k += 1) {
    const idx = (cs.pointer[team] + k) % list.length;
    if (isConnected(lobby, list[idx])) {
      cs.pointer[team] = idx + 1;
      return list[idx];
    }
  }
  return null;
}

function openReady(lobby, team) {
  const cs = csOf(lobby);
  if (connectedOf(lobby, team).length === 0 && connectedOf(lobby, other(team)).length > 0) team = other(team);
  stopTimer(lobby);
  cs.turnTeam = team;
  cs.clueur = nextClueur(lobby, team);
  cs.turnNo += 1;
  cs.current = null;
  cs.turnFound = [];
  cs.turnPasses = 0;
  lobby.state = 'cs-ready';
}

// Celui qui fait deviner lance son chrono.
export function go(lobby, playerId) {
  if (lobby.game?.kind !== 'chrono-stars' || lobby.state !== 'cs-ready') throw new GameError('NOT_NOW', 'Ce n’est pas le moment.');
  const cs = csOf(lobby);
  if (playerId !== cs.clueur) throw new GameError('NOT_YOUR_TURN', 'Ce n’est pas à toi de faire deviner.');
  cs.deck = shuffle(cs.deck);
  cs.current = cs.deck[0];
  lobby.state = 'cs-play';
  setTimer(lobby, cs.settings.timer, () => endTurn(lobby, 'time'));
}

function assertCard(lobby, playerId, cardId) {
  if (lobby.game?.kind !== 'chrono-stars' || lobby.state !== 'cs-play') throw new GameError('NOT_NOW', 'Le tour est terminé.');
  const cs = csOf(lobby);
  if (playerId !== cs.clueur) throw new GameError('NOT_YOUR_TURN', 'Ce n’est pas à toi de faire deviner.');
  // Protège du double appui : on valide la carte affichée, pas la suivante.
  if (cardId !== cs.current) throw new GameError('STALE', 'Cette carte est déjà passée.');
  return cs;
}

export function found(lobby, playerId, { cardId } = {}) {
  const cs = assertCard(lobby, playerId, cardId);
  cs.deck = cs.deck.filter((id) => id !== cardId);
  cs.turnFound.push(cardId);
  cs.found[cs.manche][cs.turnTeam].push(cardId);
  if (cs.deck.length === 0) return endTurn(lobby, 'empty');
  cs.current = cs.deck[0];
}

export function pass(lobby, playerId, { cardId } = {}) {
  const cs = assertCard(lobby, playerId, cardId);
  if (!CS_MANCHES[cs.manche].pass) throw new GameError('NO_PASS', 'Pas de « passer » à la manche 1 : courage ! 💪');
  if (cs.deck.length < 2) throw new GameError('LAST_CARD', 'C’est la dernière carte, impossible de passer.');
  cs.deck = [...cs.deck.slice(1), cardId];
  cs.current = cs.deck[0];
  cs.turnPasses += 1;
}

function endTurn(lobby, reason) {
  const cs = csOf(lobby);
  stopTimer(lobby);
  cs.lastTurn = { team: cs.turnTeam, clueur: cs.clueur, found: cs.turnFound.map((id) => cardName(cs, id)), passes: cs.turnPasses, reason };
  cs.current = null;
  if (cs.deck.length === 0) return endManche(lobby);
  openReady(lobby, other(cs.turnTeam));
}

function endManche(lobby) {
  const cs = csOf(lobby);
  const { game } = lobby;
  const counts = Object.fromEntries(TEAMS.map((t) => [t, cs.found[cs.manche][t].length]));
  const gains = {};
  for (const team of TEAMS) {
    for (const id of cs.order[team]) {
      if (!lobby.players.has(id)) continue;
      gains[id] = counts[team];
      game.totals[id] = (game.totals[id] ?? 0) + counts[team];
    }
  }
  const m = CS_MANCHES[cs.manche];
  const winner = counts.rouge === counts.bleu ? null : counts.rouge > counts.bleu ? 'rouge' : 'bleu';
  game.history.push({
    question: `Manche ${cs.manche + 1} · ${m.label} — 🔴 ${counts.rouge} / 🔵 ${counts.bleu}`,
    topPlayerIds: winner ? cs.order[winner].filter((id) => lobby.players.has(id)) : [],
  });
  cs.result = {
    counts,
    winner,
    gains,
    found: Object.fromEntries(TEAMS.map((t) => [t, cs.found[cs.manche][t].map((id) => cardName(cs, id))])),
    scores: { ...game.totals },
  };
  lobby.state = 'cs-manche-end';
}

const teamTotals = (cs) => Object.fromEntries(TEAMS.map((t) => [t, cs.found.reduce((sum, f) => sum + (f?.[t]?.length ?? 0), 0)]));

export function next(lobby) {
  const cs = csOf(lobby);
  if (cs.manche + 1 >= CS_MANCHES.length || lobby.connectedPlayers.length < 2) {
    lobby.game.index = lobby.game.totalRounds;
    lobby.finish();
    const totals = teamTotals(cs);
    lobby.game.final.cs = {
      totals,
      winner: totals.rouge === totals.bleu ? null : totals.rouge > totals.bleu ? 'rouge' : 'bleu',
      teams: Object.fromEntries(TEAMS.map((t) => [t, cs.order[t].filter((id) => lobby.players.has(id))])),
    };
    return 'finish';
  }
  cs.manche += 1;
  openManche(lobby);
  return 'next';
}

// L'hôte : au moment de lancer, passe à un autre joueur de l'équipe ; pendant le tour, l'arrête.
export function hostSkip(lobby) {
  const cs = csOf(lobby);
  if (lobby.state === 'cs-ready') {
    const next2 = nextClueur(lobby, cs.turnTeam);
    if (next2 && next2 !== cs.clueur) cs.clueur = next2;
    else openReady(lobby, other(cs.turnTeam));
    return;
  }
  if (lobby.state === 'cs-play') return endTurn(lobby, 'host');
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

// Déconnexions : celui qui fait deviner part → son tour s'arrête (ou un coéquipier le remplace avant de lancer).
export function progress(lobby) {
  const cs = csOf(lobby);
  if (lobby.state === 'cs-ready' && !isConnected(lobby, cs.clueur)) {
    const replacement = nextClueur(lobby, cs.turnTeam);
    if (replacement) cs.clueur = replacement;
    else if (connectedOf(lobby, other(cs.turnTeam)).length) openReady(lobby, other(cs.turnTeam));
    else return false;
    return true;
  }
  if (lobby.state === 'cs-play' && !isConnected(lobby, cs.clueur)) {
    endTurn(lobby, 'left');
    return true;
  }
  return false;
}

export function playerGone(lobby, playerId) {
  const cs = lobby.game.cs;
  for (const team of TEAMS) {
    const idx = cs.order[team].indexOf(playerId);
    if (idx === -1) continue;
    cs.order[team].splice(idx, 1);
    if (cs.pointer[team] > idx) cs.pointer[team] -= 1;
  }
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function csPublic(lobby, viewerId) {
  const cs = lobby.game?.cs;
  if (!cs || !lobby.state.startsWith('cs-')) return null;
  const myTeam = TEAMS.find((t) => cs.order[t].includes(viewerId)) ?? null;
  const isClueur = viewerId !== null && viewerId === cs.clueur;
  // La carte : pour celui qui fait deviner, et pour l'équipe adverse qui surveille. Jamais pour ses coéquipiers.
  const seesCard = lobby.state === 'cs-play' && (isClueur || (myTeam !== null && myTeam !== cs.turnTeam));
  const card = seesCard && cs.current ? cs.cards.find((c) => c.id === cs.current) : null;
  return {
    phase: lobby.state,
    manche: cs.manche,
    manches: CS_MANCHES.map(({ label, emoji, rule, pass }) => ({ label, emoji, rule, pass })),
    myTeam,
    isClueur,
    clueur: cs.clueur,
    turnTeam: cs.turnTeam,
    turnNo: cs.turnNo,
    teams: Object.fromEntries(TEAMS.map((t) => [t, cs.order[t].filter((id) => lobby.players.has(id))])),
    card: card ? { id: card.id, name: card.name, cat: card.cat } : null,
    deckLeft: cs.deck.length,
    totalCards: cs.cards.length,
    turnFound: cs.turnFound.map((id) => cardName(cs, id)),
    lastTurn: cs.lastTurn,
    totals: teamTotals(cs),
    perManche: cs.found.map((f) => Object.fromEntries(TEAMS.map((t) => [t, f?.[t]?.length ?? 0]))),
    deadline: cs.deadline,
    timer: cs.settings.timer,
    serverNow: Date.now(),
    result: lobby.state === 'cs-manche-end' ? cs.result : null,
  };
}

export function csLimits(lobby) {
  const bank = lobby.csBank ?? getBank();
  const counts = bank.counts();
  return {
    minPlayers: MIN_PLAYERS,
    cards: [...CS_LIMITS.cards],
    timers: [...CS_LIMITS.timers],
    players: lobby.connectedPlayers.length,
    manches: CS_MANCHES.map(({ label, emoji }) => ({ label, emoji })),
    categories: CS_CATEGORIES.map(({ id, label, emoji }) => ({ id, label, emoji, count: counts[id] ?? 0 })),
  };
}

export function defaultSettings() {
  return { ...CS_LIMITS.defaults, categories: [...CS_CATEGORY_IDS] };
}

export function sanitizeSettings(currentSettings, { csCards, csTimer, csCategories }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (csCards !== undefined) next.cards = pickFrom(CS_LIMITS.cards, csCards, 'Nombre de cartes');
  if (csTimer !== undefined) next.timer = pickFrom(CS_LIMITS.timers, csTimer, 'Chrono');
  if (csCategories !== undefined) {
    if (!Array.isArray(csCategories)) throw new GameError('INVALID_SETTINGS', 'Thèmes invalides.');
    next.categories = CS_CATEGORY_IDS.filter((id) => csCategories.includes(id));
    if (next.categories.length === 0) throw new GameError('INVALID_SETTINGS', 'Garde au moins un thème.');
  }
  return next;
}
