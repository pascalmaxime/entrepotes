import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError } from '../game/errors.js';

/**
 * Nom de code (façon Codenames) : deux équipes, une grille de 25 mots.
 * Chaque équipe a un espion qui voit la « clé » (à qui appartient chaque mot).
 *   cn-clue  : l'espion de l'équipe qui joue donne un indice d'un mot + un nombre
 *   cn-guess : ses coéquipiers votent pour un mot (majorité de l'équipe) ou pour finir le tour
 *   cn-end   : un camp a trouvé tous ses mots (ou l'autre a touché l'assassin) → manche suivante
 * Équipes et espions sont tirés à chaque manche (chacun est espion à tour de rôle).
 * Points : +1 par mot de ton équipe découvert, +5 à chaque membre de l'équipe gagnante.
 * La clé n'est envoyée qu'aux deux espions (et à tout le monde en fin de manche).
 */

export const MIN_PLAYERS = 4;
export const TEAMS = Object.freeze(['rouge', 'bleu']);
export const CN_POINTS = Object.freeze({ card: 1, win: 5 });
export const CN_LIMITS = Object.freeze({
  rounds: [1, 2, 3, 4, 5], // manches
  timers: [0, 60, 90, 120, 180], // secondes par étape (0 = pas de chrono)
  defaults: { rounds: 2, timer: 0 },
});
const BOARD = Object.freeze({ size: 25, starter: 9, other: 8, neutral: 7, assassin: 1 });
const CLUE_MAX = 24;
const MAX_COUNT = 9;
const GRACE_MS = 1_000;
export const WORDS_FILE = fileURLToPath(new URL('../../data/nomdecode.json', import.meta.url));

const other = (team) => (team === 'rouge' ? 'bleu' : 'rouge');

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// --- Comparaison de mots : « Chevaux » ≈ « cheval », « Étoiles » = « etoile » ---------------------------

export function norm(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Pluriels et « e » final retirés : chevaux → cheval, étoiles → etoil, pomme → pomm (≈ pommier).
function stem(key) {
  let k = key.length > 4 ? key.replace(/(aux|eaux|s|x)$/, (m) => (m === 'aux' ? 'al' : m === 'eaux' ? 'eau' : '')) : key;
  if (k.length > 4 && k.endsWith('e')) k = k.slice(0, -1);
  return k;
}

// L'indice est-il (une forme de) ce mot de la grille ? « pomme » / « pommier », « chevaux » / « cheval »…
export function clashes(clue, word) {
  const a = stem(norm(clue));
  const b = stem(norm(word));
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // « pommier » commence par « pomme » ; « million » ne bloque pas « lion » (fin de mot : 5 lettres minimum).
  return (short.length >= 4 && long.startsWith(short)) || (short.length >= 5 && long.endsWith(short));
}

export function cleanClue(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/’/g, "'").trim().slice(0, CLUE_MAX);
}

// --- Banque de mots (data/nomdecode.json, relu automatiquement s'il change) -------------------------------

function parseWords(raw) {
  const data = JSON.parse(raw);
  const seen = new Set();
  const list = [];
  for (const w of Array.isArray(data.mots) ? data.mots : []) {
    if (typeof w !== 'string') continue;
    const word = w.trim();
    const key = norm(word);
    if (!word || /\s/.test(word) || !key || seen.has(key)) continue;
    seen.add(key);
    list.push(word);
  }
  if (list.length < BOARD.size) throw new Error(`Il faut au moins ${BOARD.size} mots.`);
  return list;
}

export function createWordBank(words) {
  let list = [...words];
  return {
    get size() {
      return list.length;
    },
    replace(next) {
      list = [...next];
    },
    // 25 mots jamais vus dans ce lobby (on recommence quand la liste est épuisée).
    pick(count, used = new Set()) {
      let fresh = list.filter((w) => !used.has(norm(w)));
      if (fresh.length < count) {
        for (const w of list) used.delete(norm(w));
        fresh = list;
      }
      const picked = shuffle(fresh).slice(0, count);
      for (const w of picked) used.add(norm(w));
      return picked;
    },
  };
}

export function loadWordBank(file = WORDS_FILE) {
  let mtime = statSync(file).mtimeMs;
  const bank = createWordBank(parseWords(readFileSync(file, 'utf8')));
  const basePick = bank.pick;
  bank.pick = (count, used) => {
    try {
      const current = statSync(file).mtimeMs;
      if (current !== mtime) {
        bank.replace(parseWords(readFileSync(file, 'utf8')));
        mtime = current;
        console.log(`[nom-de-code] Fichier rechargé (${bank.size} mots).`);
      }
    } catch (error) {
      console.warn('[nom-de-code] Rechargement impossible, on garde la version précédente :', error.message);
    }
    return basePick(count, used);
  };
  return bank;
}

let sharedBank = null;
export function getBank() {
  if (!sharedBank) sharedBank = loadWordBank();
  return sharedBank;
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const cnOf = (lobby) => lobby.game.cn;
const isConnected = (lobby, id) => Boolean(lobby.players.get(id)?.connected);
const membersOf = (lobby, team) => [...cnOf(lobby).teamOf].filter(([id, t]) => t === team && lobby.players.has(id)).map(([id]) => id);
const connectedMembers = (lobby, team) => membersOf(lobby, team).filter((id) => isConnected(lobby, id));
export const guessersOf = (lobby, team) => connectedMembers(lobby, team).filter((id) => id !== cnOf(lobby).spies[team]);
const remaining = (cn, team) => cn.board.filter((c) => c.type === team && !c.revealed).length;

function setTimer(lobby, fn) {
  const cn = cnOf(lobby);
  lobby.clearQuizTimer();
  const token = ++cn.token;
  const seconds = cn.settings.timer;
  if (!seconds) {
    cn.deadline = null;
    return;
  }
  cn.deadline = Date.now() + seconds * 1000;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.cn !== cn || cn.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, seconds * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

export function startNomDeCode(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  lobby.cnBank ??= getBank();
  lobby.usedCnWords ??= new Set();
  const settings = { ...lobby.settings.nomDeCode };
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: settings.rounds,
    cn: {
      settings,
      manche: 0,
      firstStarter: TEAMS[randomInt(2)],
      spyCount: new Map(), // combien de fois chacun a été espion
      token: 0,
      deadline: null,
      teamOf: new Map(),
      spies: { rouge: null, bleu: null },
      board: [],
      starter: null,
      turn: null,
      clue: null,
      guessesLeft: 0,
      votes: new Map(),
      log: [],
      result: null,
    },
  };
  startManche(lobby);
}

// L'espion d'une équipe : celui qui l'a été le moins souvent (au hasard en cas d'égalité).
function chooseSpy(lobby, team) {
  const cn = cnOf(lobby);
  const candidates = shuffle(connectedMembers(lobby, team));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (cn.spyCount.get(a) ?? 0) - (cn.spyCount.get(b) ?? 0));
  const spy = candidates[0];
  cn.spyCount.set(spy, (cn.spyCount.get(spy) ?? 0) + 1);
  cn.spies[team] = spy;
  return spy;
}

function startManche(lobby) {
  const cn = cnOf(lobby);
  const starter = cn.manche % 2 === 0 ? cn.firstStarter : other(cn.firstStarter);
  // Les deux espions d'abord : ceux qui l'ont été le moins souvent (chacun son tour), puis les autres au hasard.
  // Avec un nombre impair, le joueur en plus va à l'équipe qui ne commence pas.
  const ids = shuffle(lobby.connectedPlayers.map((p) => p.id)).sort((a, b) => (cn.spyCount.get(a) ?? 0) - (cn.spyCount.get(b) ?? 0));
  const [spyA, spyB] = shuffle(ids.slice(0, 2));
  const rest = shuffle(ids.slice(2));
  const half = Math.floor(ids.length / 2);
  cn.teamOf = new Map([
    [spyA, starter],
    ...rest.slice(0, half - 1).map((id) => [id, starter]),
    [spyB, other(starter)],
    ...rest.slice(half - 1).map((id) => [id, other(starter)]),
  ]);
  cn.spies = { [starter]: spyA, [other(starter)]: spyB };
  for (const id of [spyA, spyB]) cn.spyCount.set(id, (cn.spyCount.get(id) ?? 0) + 1);
  const words = lobby.cnBank.pick(BOARD.size, lobby.usedCnWords);
  const types = shuffle([
    ...Array(BOARD.starter).fill(starter),
    ...Array(BOARD.other).fill(other(starter)),
    ...Array(BOARD.neutral).fill('neutre'),
    ...Array(BOARD.assassin).fill('assassin'),
  ]);
  cn.board = words.map((word, i) => ({ word, type: types[i], revealed: false, by: null }));
  cn.starter = starter;
  cn.log = [];
  cn.result = null;
  lobby.game.index = cn.manche;
  lobby.game.result = null;
  openClue(lobby, starter);
}

function ensureSpy(lobby, team) {
  if (!isConnected(lobby, cnOf(lobby).spies[team])) chooseSpy(lobby, team);
}

function openClue(lobby, team) {
  const cn = cnOf(lobby);
  // Équipe sans personne de connecté : on donne directement la main à l'autre.
  if (connectedMembers(lobby, team).length === 0 && connectedMembers(lobby, other(team)).length > 0) team = other(team);
  ensureSpy(lobby, team);
  cn.turn = team;
  cn.clue = null;
  cn.guessesLeft = 0;
  cn.votes = new Map();
  lobby.state = 'cn-clue';
  setTimer(lobby, () => endTurn(lobby));
}

function endTurn(lobby) {
  openClue(lobby, other(cnOf(lobby).turn));
}

export function submitClue(lobby, playerId, { word, count } = {}) {
  if (lobby.game?.kind !== 'nom-de-code' || lobby.state !== 'cn-clue') throw new GameError('NOT_NOW', 'Ce n’est pas le moment de donner un indice.');
  const cn = cnOf(lobby);
  if (playerId !== cn.spies[cn.turn]) throw new GameError('NOT_SPY', 'Seul l’espion de l’équipe qui joue donne l’indice.');
  const clue = cleanClue(word);
  if (!clue) throw new GameError('EMPTY', 'Écris un indice 😉');
  if (/\s/.test(clue)) throw new GameError('ONE_WORD', 'Un seul mot pour l’indice (sans espace).');
  if (!/\p{L}/u.test(clue) || !/^[\p{L}0-9'-]+$/u.test(clue)) throw new GameError('INVALID_CLUE', 'L’indice doit être un vrai mot (lettres uniquement).');
  const n = Number.parseInt(count, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) throw new GameError('INVALID_COUNT', `Choisis un nombre entre 1 et ${MAX_COUNT}.`);
  const clash = cn.board.find((c) => !c.revealed && clashes(clue, c.word));
  if (clash) {
    const same = norm(clue) === norm(clash.word);
    throw new GameError('CLUE_ON_BOARD', same ? `Interdit : « ${clash.word} » est sur la grille 😉` : `Interdit : « ${clue} » est trop proche de « ${clash.word} », qui est sur la grille.`);
  }
  cn.clue = { word: clue, count: n };
  cn.guessesLeft = n + 1; // on a droit à un mot de plus que le nombre annoncé
  cn.log.push({ team: cn.turn, clue: clue, count: n, picks: [] });
  cn.votes = new Map();
  lobby.state = 'cn-guess';
  setTimer(lobby, () => endTurn(lobby));
  resolve(lobby); // équipe sans agent connecté : on passe directement
}

// Un agent touche un mot (index de la carte) ou vote pour finir le tour ('pass'). Retoucher = annuler son choix.
export function pick(lobby, playerId, { card } = {}) {
  if (lobby.game?.kind !== 'nom-de-code' || lobby.state !== 'cn-guess') throw new GameError('NOT_NOW', 'Ce n’est pas le moment de choisir.');
  const cn = cnOf(lobby);
  const team = cn.teamOf.get(playerId);
  if (team !== cn.turn) throw new GameError('NOT_YOUR_TURN', 'C’est à l’autre équipe de jouer.');
  if (cn.spies[team] === playerId) throw new GameError('SPY_NO_TOUCH', 'L’espion ne touche pas les cartes 🤐');
  let choice;
  if (card === 'pass') choice = 'pass';
  else {
    choice = Number.parseInt(card, 10);
    if (!Number.isInteger(choice) || !cn.board[choice]) throw new GameError('INVALID_CARD', 'Carte inconnue.');
    if (cn.board[choice].revealed) throw new GameError('ALREADY_REVEALED', 'Ce mot est déjà découvert.');
  }
  if (cn.votes.get(playerId) === choice) cn.votes.delete(playerId);
  else cn.votes.set(playerId, choice);
  resolve(lobby);
}

// Un choix est appliqué quand la majorité des agents connectés de l'équipe est d'accord.
function resolve(lobby) {
  if (lobby.state !== 'cn-guess') return false;
  const cn = cnOf(lobby);
  const guessers = guessersOf(lobby, cn.turn);
  if (guessers.length === 0) {
    endTurn(lobby);
    return true;
  }
  const need = Math.floor(guessers.length / 2) + 1;
  const tally = new Map();
  for (const id of guessers) {
    if (!cn.votes.has(id)) continue;
    const choice = cn.votes.get(id);
    tally.set(choice, (tally.get(choice) ?? 0) + 1);
  }
  const winner = [...tally].find(([, n]) => n >= need)?.[0];
  if (winner === undefined) return false;
  if (winner === 'pass') endTurn(lobby);
  else revealCard(lobby, winner);
  return true;
}

function revealCard(lobby, index) {
  const cn = cnOf(lobby);
  const card = cn.board[index];
  const team = cn.turn;
  card.revealed = true;
  card.by = team;
  cn.votes = new Map();
  cn.log.at(-1)?.picks.push({ word: card.word, type: card.type });
  if (card.type === 'assassin') return endManche(lobby, other(team), 'assassin');
  if (TEAMS.includes(card.type) && remaining(cn, card.type) === 0) return endManche(lobby, card.type, card.type === team ? 'all' : 'gift');
  if (card.type !== team) return endTurn(lobby);
  cn.guessesLeft -= 1;
  if (cn.guessesLeft <= 0) endTurn(lobby);
}

function endManche(lobby, winner, reason) {
  const cn = cnOf(lobby);
  const { game } = lobby;
  lobby.clearQuizTimer();
  cn.token += 1;
  cn.deadline = null;
  const found = Object.fromEntries(TEAMS.map((t) => [t, cn.board.filter((c) => c.type === t && c.revealed).length]));
  const gains = {};
  for (const [id, team] of cn.teamOf) {
    if (!lobby.players.has(id)) continue;
    gains[id] = found[team] * CN_POINTS.card + (team === winner ? CN_POINTS.win : 0);
    game.totals[id] = (game.totals[id] ?? 0) + gains[id];
  }
  const winners = membersOf(lobby, winner);
  const label = winner === 'rouge' ? '🔴 Rouges' : '🔵 Bleus';
  const why = reason === 'assassin' ? ' (l’autre équipe a touché l’assassin 💀)' : reason === 'gift' ? ' (l’autre équipe leur a donné leur dernier mot)' : '';
  game.history.push({ question: `Manche ${cn.manche + 1} · victoire des ${label}${why}`, topPlayerIds: winners });
  cn.result = { winner, reason, found, gains, scores: { ...game.totals } };
  lobby.state = 'cn-end';
}

export function next(lobby) {
  const cn = cnOf(lobby);
  if (cn.manche + 1 >= lobby.game.totalRounds || lobby.connectedPlayers.length < MIN_PLAYERS) {
    lobby.game.index = lobby.game.totalRounds;
    lobby.finish();
    return 'finish';
  }
  cn.manche += 1;
  startManche(lobby);
  return 'next';
}

// L'hôte fait passer le tour (espion absent, équipe bloquée…).
export function hostSkip(lobby) {
  if (lobby.state === 'cn-clue' || lobby.state === 'cn-guess') return endTurn(lobby);
  throw new GameError('NOT_NOW', 'Rien à passer.');
}

// Déconnexions : nouvel espion si besoin, tour passé si l'équipe n'a plus personne.
export function progress(lobby) {
  if (!lobby.state.startsWith('cn-') || lobby.state === 'cn-end') return false;
  const cn = cnOf(lobby);
  // Pendant que les agents cherchent, on ne leur vole pas un joueur pour en faire l'espion : ça attendra son prochain tour.
  for (const team of TEAMS) if (!(lobby.state === 'cn-guess' && team === cn.turn)) ensureSpy(lobby, team);
  const playing = connectedMembers(lobby, cn.turn).length > 0;
  const waiting = connectedMembers(lobby, other(cn.turn)).length > 0;
  if (!playing && !waiting) return false;
  if (!playing) {
    endTurn(lobby);
    return true;
  }
  if (lobby.state === 'cn-guess') return resolve(lobby);
  return false;
}

export function playerGone(lobby, playerId) {
  const cn = lobby.game.cn;
  cn.votes.delete(playerId);
  cn.teamOf.delete(playerId);
  for (const team of TEAMS) if (cn.spies[team] === playerId) cn.spies[team] = null;
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function cnPublic(lobby, viewerId) {
  const cn = lobby.game?.cn;
  if (!cn || !lobby.state.startsWith('cn-')) return null;
  const ended = lobby.state === 'cn-end';
  const mySpy = viewerId !== null && (cn.spies.rouge === viewerId || cn.spies.bleu === viewerId);
  const showKey = mySpy || ended;
  const live = (ids) => ids.filter((id) => lobby.players.has(id));
  return {
    phase: lobby.state,
    manche: cn.manche,
    total: lobby.game.totalRounds,
    starter: cn.starter,
    turn: cn.turn,
    myTeam: cn.teamOf.get(viewerId) ?? null,
    mySpy,
    spies: { ...cn.spies },
    teams: Object.fromEntries(TEAMS.map((t) => [t, live(membersOf(lobby, t))])),
    remaining: Object.fromEntries(TEAMS.map((t) => [t, remaining(cn, t)])),
    // La couleur d'un mot n'est donnée que s'il est découvert… sauf aux espions.
    board: cn.board.map((c) => ({ word: c.word, revealed: c.revealed, by: c.by, type: c.revealed || showKey ? c.type : null })),
    clue: cn.clue,
    guessesLeft: cn.guessesLeft,
    votes: [...cn.votes].filter(([id]) => lobby.players.has(id)).map(([playerId, card]) => ({ playerId, card })),
    guessers: lobby.state === 'cn-guess' ? guessersOf(lobby, cn.turn) : [],
    log: cn.log,
    deadline: cn.deadline,
    timer: cn.settings.timer,
    serverNow: Date.now(),
    result: ended ? cn.result : null,
  };
}

export function cnLimits(lobby) {
  const bank = lobby.cnBank ?? getBank();
  return {
    minPlayers: MIN_PLAYERS,
    rounds: [...CN_LIMITS.rounds],
    timers: [...CN_LIMITS.timers],
    points: { ...CN_POINTS },
    words: bank.size,
    players: lobby.connectedPlayers.length,
  };
}

export function defaultSettings() {
  return { ...CN_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { cnRounds, cnTimer }) {
  const next = { ...currentSettings };
  const pickFrom = (list, value, label) => {
    const v = Number.parseInt(value, 10);
    if (!list.includes(v)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
    return v;
  };
  if (cnRounds !== undefined) next.rounds = pickFrom(CN_LIMITS.rounds, cnRounds, 'Nombre de manches');
  if (cnTimer !== undefined) next.timer = pickFrom(CN_LIMITS.timers, cnTimer, 'Chrono');
  return next;
}
