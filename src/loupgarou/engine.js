import { randomInt } from 'node:crypto';
import { GameError } from '../game/errors.js';

/**
 * Loup-Garou (les Loups-Garous de Thiercelieux, règles classiques).
 *   lg-reveal (chacun découvre son rôle, 10 s)
 *   → lg-night (Cupidon la 1re nuit, Voyante, Salvateur, Loups, Sorcière)
 *   → lg-dawn (annonce des morts) → [lg-hunter] [lg-successor]
 *   → lg-mayor (1er jour, si activé) → lg-debate → lg-vote → lg-verdict → [lg-hunter] [lg-successor] → nuit…
 *   → finished (un camp a gagné)
 * Les rôles des joueurs vivants ne sont JAMAIS envoyés aux autres (sauf entre loups, et au joueur lui-même).
 */

export const MIN_PLAYERS = 5;
export const ROLES = Object.freeze({
  loup: { label: 'Loup-Garou', emoji: '🐺', camp: 'loups', multiple: true, desc: 'Chaque nuit, avec les autres loups, tu choisis un villageois à dévorer. Le jour, fais-toi passer pour un innocent.' },
  villageois: { label: 'Simple Villageois', emoji: '🧑‍🌾', camp: 'village', multiple: true, desc: 'Tu n’as aucun pouvoir, juste ton flair. Démasque les loups pendant le débat et vote bien !' },
  voyante: { label: 'Voyante', emoji: '🔮', camp: 'village', desc: 'Chaque nuit, tu découvres le vrai rôle d’un joueur de ton choix.' },
  sorciere: { label: 'Sorcière', emoji: '🧪', camp: 'village', desc: 'Tu as une potion de vie (sauver la victime des loups) et une potion de mort (éliminer quelqu’un). Une seule fois chacune.' },
  chasseur: { label: 'Chasseur', emoji: '🏹', camp: 'village', desc: 'Si tu meurs, tu tires une dernière balle et tu emportes quelqu’un avec toi.' },
  cupidon: { label: 'Cupidon', emoji: '💘', camp: 'village', desc: 'La 1re nuit, tu désignes deux amoureux. Si l’un meurt, l’autre meurt de chagrin.' },
  'petite-fille': { label: 'Petite Fille', emoji: '👧', camp: 'village', desc: 'La nuit, tu espionnes le chat des loups… sans voir qui écrit.' },
  salvateur: { label: 'Salvateur', emoji: '🛡️', camp: 'village', desc: 'Chaque nuit, tu protèges un joueur des loups (pas deux fois de suite le même).' },
  ancien: { label: 'Ancien', emoji: '👴', camp: 'village', desc: 'Tu es coriace : tu survis à la première attaque des loups.' },
  idiot: { label: 'Idiot du village', emoji: '🤪', camp: 'village', desc: 'Si le village vote contre toi, tu es épargné (on voit que tu es l’idiot), mais tu ne votes plus.' },
});
export const ROLE_IDS = Object.keys(ROLES);
const SPECIALS = ROLE_IDS.filter((id) => !ROLES[id].multiple);

export const LG_LIMITS = Object.freeze({
  night: [20, 30, 45, 60], // secondes par rôle la nuit
  debate: [60, 120, 180, 300], // secondes de débat le jour
  defaults: { night: 30, debate: 120, mayor: true },
});
const MS = { reveal: 10_000, fake: 7_000, seerShow: 4_000, dawn: 8_000, verdict: 8_000, hunter: 30_000, successor: 30_000, mayor: 60_000, vote: 60_000, wolvesExtra: 15_000 };
const CHAT_MAX = 100;
const CHAT_LEN = 200;

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const pick = (items) => items[randomInt(items.length)];

// --- Composition -----------------------------------------------------------------------------------

// Recommandation selon le nombre de joueurs (les villageois complètent).
export function recommend(n) {
  const wolves = n <= 6 ? 1 : n <= 11 ? 2 : n <= 15 ? 3 : 4;
  const thresholds = { voyante: 5, sorciere: 5, chasseur: 5, cupidon: 6, 'petite-fille': 8, salvateur: 9, ancien: 11, idiot: 13 };
  const roles = { loup: wolves };
  for (const [id, min] of Object.entries(thresholds)) if (n >= min) roles[id] = 1;
  return roles;
}

// Composition réelle : celle de l'hôte (ou la recommandation), complétée par des villageois.
export function composition(n, custom) {
  const base = custom ?? recommend(n);
  const roles = {};
  for (const id of ROLE_IDS) if (id !== 'villageois' && base[id]) roles[id] = base[id];
  const used = Object.values(roles).reduce((a, b) => a + b, 0);
  roles.villageois = n - used;
  let problem = null;
  if (n < MIN_PLAYERS) problem = `Il faut au moins ${MIN_PLAYERS} joueurs.`;
  else if (!roles.loup) problem = 'Il faut au moins un loup-garou.';
  else if (roles.loup * 2 >= n) problem = 'Trop de loups : ils doivent être moins nombreux que les villageois.';
  else if (roles.villageois < 0) problem = `Trop de rôles pour ${n} joueurs : retire ${-roles.villageois} rôle(s).`;
  if (roles.villageois <= 0) delete roles.villageois;
  return { roles, problem };
}

export function sanitizeCustom(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') throw new GameError('INVALID_SETTINGS', 'Composition invalide.');
  const roles = {};
  for (const id of ROLE_IDS) {
    if (id === 'villageois') continue;
    const value = Number.parseInt(raw[id] ?? 0, 10);
    if (!Number.isFinite(value) || value < 0) throw new GameError('INVALID_SETTINGS', 'Composition invalide.');
    roles[id] = ROLES[id].multiple ? Math.min(value, 8) : Math.min(value, 1);
  }
  return roles;
}

// --- Petits outils ---------------------------------------------------------------------------------

const lgOf = (lobby) => lobby.game.lg;
const isAlive = (lg, id) => lg.alive.has(id);
const roleOf = (lg, id) => lg.roles.get(id);
const holders = (lg, role) => [...lg.roles].filter(([, r]) => r === role).map(([id]) => id);
const aliveHolders = (lg, role) => holders(lg, role).filter((id) => lg.alive.has(id));
const name = (lobby, id) => lobby.players.get(id)?.name ?? 'Un joueur parti';

function setTimer(lobby, ms, fn) {
  const lg = lgOf(lobby);
  lobby.clearQuizTimer();
  const token = ++lg.token;
  lg.endsAt = Date.now() + ms;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.lg !== lg || lg.token !== token) return;
    fn();
    lobby.onChange?.(lobby);
  }, ms);
  lobby.quizTimer.unref?.();
}

function nextPhase(lobby, state, extra = {}) {
  const lg = lgOf(lobby);
  lg.token += 1; // invalide les anciens chronos
  lobby.state = state;
  Object.assign(lg, { step: null, actors: [], ...extra });
}

function addChat(lg, channel, entry) {
  const list = lg.chat[channel];
  list.push({ id: ++lg.chatSeq, at: Date.now(), ...entry });
  if (list.length > CHAT_MAX) list.splice(0, list.length - CHAT_MAX);
}

function narrate(lg, text) {
  addChat(lg, 'village', { system: true, text });
}

// --- Démarrage ---------------------------------------------------------------------------------------

export function startLoupGarou(lobby, base) {
  const ids = lobby.connectedPlayers.map((p) => p.id);
  const { roles, problem } = composition(ids.length, lobby.settings.loupGarou.custom);
  if (problem) throw new GameError('INVALID_COMPOSITION', problem);
  const deck = shuffle(Object.entries(roles).flatMap(([role, count]) => Array(count).fill(role)));
  const shuffledIds = shuffle(ids);
  const settings = lobby.settings.loupGarou;
  lobby.clearQuizTimer();
  lobby.game = {
    ...base,
    totalRounds: 1,
    lg: {
      seats: ids, // ordre autour de la table
      roles: new Map(shuffledIds.map((id, i) => [id, deck[i]])),
      composition: roles,
      alive: new Set(ids),
      dead: [], // { id, role, cause, when }
      lovers: null,
      mayorId: null,
      mayorEnabled: settings.mayor,
      nightMs: settings.night * 1000,
      debateMs: settings.debate * 1000,
      night: 0,
      day: 0,
      step: null,
      steps: [],
      actors: [],
      endsAt: null,
      token: 0,
      seer: new Map(), // voyanteId → [{ targetId, role, night }]
      seerPicked: false,
      guardLast: null,
      guardTarget: null,
      wolfVotes: new Map(),
      wolfVictim: null,
      witch: { life: true, death: true, saved: false, killId: null, done: false },
      elderLives: 2,
      idiots: new Set(),
      votes: new Map(),
      candidates: [],
      queue: [],
      after: null,
      announce: null,
      chat: { village: [], wolves: [], dead: [] },
      chatSeq: 0,
      result: null,
    },
  };
  nextPhase(lobby, 'lg-reveal');
  setTimer(lobby, MS.reveal, () => startNight(lobby));
}

// --- Nuit ---------------------------------------------------------------------------------------------

const STEP_ROLE = { cupidon: 'cupidon', voyante: 'voyante', salvateur: 'salvateur', loups: 'loup', sorciere: 'sorciere' };
export const STEP_TEXT = {
  cupidon: 'Cupidon se réveille et désigne deux amoureux',
  voyante: 'La voyante se réveille et sonde un joueur',
  salvateur: 'Le salvateur se réveille et protège un joueur',
  loups: 'Les loups-garous se réveillent et choisissent leur victime',
  sorciere: 'La sorcière se réveille',
};

function startNight(lobby) {
  const lg = lgOf(lobby);
  lg.night += 1;
  lg.chat.wolves = []; // chat des loups temporaire : vidé chaque nuit
  Object.assign(lg, { wolfVotes: new Map(), wolfVictim: null, guardTarget: null, seerPicked: false, announce: null });
  lg.witch = { ...lg.witch, saved: false, killId: null, done: false };
  const order = lg.night === 1 ? ['cupidon', 'voyante', 'salvateur', 'loups', 'sorciere'] : ['voyante', 'salvateur', 'loups', 'sorciere'];
  // On ne joue que les rôles présents dans la partie (morts compris : faux tour pour garder le suspense).
  lg.steps = order.filter((step) => holders(lg, STEP_ROLE[step]).length > 0);
  narrate(lg, `🌙 La nuit ${lg.night} tombe sur le village…`);
  nextStep(lobby);
}

function nextStep(lobby) {
  const lg = lgOf(lobby);
  const step = lg.steps.shift();
  if (!step) {
    resolveNight(lobby);
    return;
  }
  const actors = aliveHolders(lg, STEP_ROLE[step]);
  nextPhase(lobby, 'lg-night', { step, actors });
  if (actors.length === 0) {
    setTimer(lobby, MS.fake, () => nextStep(lobby)); // rôle mort : on fait semblant
    return;
  }
  const ms = lg.nightMs + (step === 'loups' ? MS.wolvesExtra : 0);
  setTimer(lobby, ms, () => endStep(lobby, true));
}

// Fin d'un tour de nuit (action faite, ou chrono écoulé).
function endStep(lobby, timeout = false) {
  const lg = lgOf(lobby);
  if (lg.step === 'loups') lg.wolfVictim = wolfChoice(lg);
  if (lg.step === 'cupidon' && timeout && !lg.lovers) {
    // Cupidon endormi : deux amoureux au hasard.
    const [a, b] = shuffle([...lg.alive]);
    lg.lovers = [a, b];
  }
  nextStep(lobby);
}

function wolfChoice(lg) {
  const counts = new Map();
  for (const target of lg.wolfVotes.values()) if (lg.alive.has(target)) counts.set(target, (counts.get(target) ?? 0) + 1);
  if (counts.size === 0) return null;
  const max = Math.max(...counts.values());
  return pick([...counts].filter(([, n]) => n === max).map(([id]) => id));
}

function assertActor(lobby, playerId, step) {
  const lg = lgOf(lobby);
  if (lobby.state !== 'lg-night' || lg.step !== step) throw new GameError('NOT_YOUR_TURN', 'Ce n’est pas ton tour.');
  if (!lg.actors.includes(playerId)) throw new GameError('NOT_YOUR_TURN', 'Ce n’est pas ton tour.');
}

function assertTarget(lg, id, { allowSelf = true, self } = {}) {
  if (!lg.alive.has(id)) throw new GameError('INVALID_TARGET', 'Choisis un joueur vivant.');
  if (!allowSelf && id === self) throw new GameError('INVALID_TARGET', 'Tu ne peux pas te choisir.');
}

export function act(lobby, playerId, payload = {}) {
  const lg = lgOf(lobby);
  if (!lg) throw new GameError('NOT_PLAYING', 'Pas de partie de Loup-Garou en cours.');
  const { type, target } = payload;
  switch (type) {
    case 'cupid': {
      assertActor(lobby, playerId, 'cupidon');
      const targets = Array.isArray(payload.targets) ? payload.targets : [];
      if (targets.length !== 2 || targets[0] === targets[1]) throw new GameError('INVALID_TARGET', 'Choisis deux joueurs différents.');
      targets.forEach((id) => assertTarget(lg, id));
      lg.lovers = [...targets];
      endStep(lobby);
      return;
    }
    case 'see': {
      assertActor(lobby, playerId, 'voyante');
      if (lg.seerPicked) throw new GameError('ALREADY_DONE', 'Tu as déjà sondé quelqu’un cette nuit.');
      assertTarget(lg, target, { allowSelf: false, self: playerId });
      const list = lg.seer.get(playerId) ?? [];
      list.push({ targetId: target, role: roleOf(lg, target), night: lg.night });
      lg.seer.set(playerId, list);
      lg.seerPicked = true;
      setTimer(lobby, MS.seerShow, () => endStep(lobby)); // le temps de lire la réponse
      return;
    }
    case 'protect': {
      assertActor(lobby, playerId, 'salvateur');
      assertTarget(lg, target);
      if (target === lg.guardLast) throw new GameError('INVALID_TARGET', 'Pas le même joueur deux nuits de suite.');
      lg.guardTarget = target;
      lg.guardLast = target;
      endStep(lobby);
      return;
    }
    case 'wolf-vote': {
      assertActor(lobby, playerId, 'loups');
      assertTarget(lg, target);
      if (roleOf(lg, target) === 'loup') throw new GameError('INVALID_TARGET', 'On ne dévore pas un autre loup !');
      lg.wolfVotes.set(playerId, target);
      // Tous les loups (connectés) d'accord : on passe à la suite.
      const wolves = lg.actors.filter((id) => lobby.players.get(id)?.connected);
      const choices = wolves.map((id) => lg.wolfVotes.get(id));
      if (wolves.length && choices.every((c) => c && c === choices[0])) endStep(lobby);
      return;
    }
    case 'witch': {
      assertActor(lobby, playerId, 'sorciere');
      const { save = false, kill = null } = payload;
      if (save) {
        if (!lg.witch.life) throw new GameError('NO_POTION', 'Ta potion de vie est déjà utilisée.');
        if (!lg.wolfVictim) throw new GameError('NO_VICTIM', 'Personne à sauver cette nuit.');
      }
      if (kill) {
        if (!lg.witch.death) throw new GameError('NO_POTION', 'Ta potion de mort est déjà utilisée.');
        assertTarget(lg, kill);
      }
      if (save) {
        lg.witch.life = false;
        lg.witch.saved = true;
      }
      if (kill) {
        lg.witch.death = false;
        lg.witch.killId = kill;
      }
      endStep(lobby);
      return;
    }
    case 'skip': {
      if (lobby.state !== 'lg-night' || !lg.actors.includes(playerId) || lg.step === 'loups' || lg.step === 'cupidon') {
        throw new GameError('NOT_YOUR_TURN', 'Impossible de passer maintenant.');
      }
      endStep(lobby);
      return;
    }
    case 'vote':
      return dayVote(lobby, playerId, target);
    case 'shoot': {
      if (lobby.state !== 'lg-hunter' || lg.actors[0] !== playerId) throw new GameError('NOT_YOUR_TURN', 'Ce n’est pas à toi de tirer.');
      assertTarget(lg, target);
      narrate(lg, `🏹 ${name(lobby, playerId)} tire sur ${name(lobby, target)} !`);
      lg.announce = { type: 'shot', by: playerId, deaths: [] };
      kill(lobby, target, 'chasseur');
      lg.announce.deaths = lg.lastDeaths;
      continueFlow(lobby);
      return;
    }
    case 'successor': {
      if (lobby.state !== 'lg-successor' || lg.actors[0] !== playerId) throw new GameError('NOT_YOUR_TURN', 'Ce n’est pas à toi de choisir.');
      assertTarget(lg, target);
      lg.mayorId = target;
      narrate(lg, `👑 ${name(lobby, target)} devient le nouveau maire.`);
      continueFlow(lobby);
      return;
    }
    default:
      throw new GameError('INVALID_ACTION', 'Action inconnue.');
  }
}

// --- Aube : on compte les morts ------------------------------------------------------------------------

function resolveNight(lobby) {
  const lg = lgOf(lobby);
  lg.lastDeaths = [];
  const deaths = [];
  const victim = lg.wolfVictim;
  if (victim && lg.alive.has(victim) && victim !== lg.guardTarget && !lg.witch.saved) {
    if (roleOf(lg, victim) === 'ancien' && lg.elderLives > 1) lg.elderLives -= 1;
    else deaths.push([victim, 'loups']);
  }
  if (lg.witch.killId && lg.alive.has(lg.witch.killId)) deaths.push([lg.witch.killId, 'sorciere']);
  for (const [id, cause] of deaths) kill(lobby, id, cause);
  const all = lg.lastDeaths;
  lg.announce = { type: 'dawn', deaths: all };
  narrate(lg, all.length ? `☀️ Le jour se lève. ${all.map((d) => `${name(lobby, d.id)} (${ROLES[d.role].label})`).join(', ')} ${all.length > 1 ? 'sont morts' : 'est mort'} cette nuit.` : '☀️ Le jour se lève. Personne n’est mort cette nuit !');
  lg.after = 'day';
  nextPhase(lobby, 'lg-dawn');
  setTimer(lobby, MS.dawn, () => continueFlow(lobby));
}

// Tue un joueur (+ son amoureux), révèle son rôle, prépare le tir du chasseur / la succession du maire.
function kill(lobby, id, cause) {
  const lg = lgOf(lobby);
  if (!lg.alive.has(id)) return;
  lg.alive.delete(id);
  const role = roleOf(lg, id);
  const death = { id, role, cause, when: lobby.state === 'lg-night' ? `nuit ${lg.night}` : `jour ${lg.day}` };
  lg.dead.push(death);
  (lg.lastDeaths ??= []).push(death);
  lg.wolfVotes.delete(id);
  lg.votes.delete(id);
  if (role === 'chasseur') lg.queue.push({ type: 'hunter', id });
  if (lg.mayorId === id) lg.queue.push({ type: 'successor', id });
  if (lg.lovers?.includes(id)) {
    const partner = lg.lovers.find((p) => p !== id);
    if (lg.alive.has(partner)) kill(lobby, partner, 'chagrin');
  }
}

export function winner(lg) {
  const alive = [...lg.alive];
  const wolves = alive.filter((id) => roleOf(lg, id) === 'loup').length;
  const others = alive.length - wolves;
  const mixedLovers = lg.lovers && new Set(lg.lovers.map((id) => ROLES[roleOf(lg, id)].camp)).size === 2;
  if (mixedLovers && alive.length === 2 && lg.lovers.every((id) => lg.alive.has(id))) return 'amoureux';
  if (alive.length === 0) return 'personne';
  if (wolves === 0) return 'village';
  if (others === 0) return 'loups';
  return null;
}

// Après des morts : chasseur(s), puis fin de partie, puis nouveau maire, puis la suite (jour ou nuit).
function continueFlow(lobby) {
  const lg = lgOf(lobby);
  const hunterIndex = lg.queue.findIndex((t) => t.type === 'hunter');
  if (hunterIndex >= 0) {
    const [task] = lg.queue.splice(hunterIndex, 1);
    if (lobby.players.get(task.id)?.connected && lg.alive.size > 0) {
      lg.lastDeaths = [];
      nextPhase(lobby, 'lg-hunter', { actors: [task.id] });
      narrate(lg, `🏹 ${name(lobby, task.id)} était chasseur : il tire une dernière balle…`);
      setTimer(lobby, MS.hunter, () => continueFlow(lobby)); // pas de tir dans le temps imparti
      return;
    }
    continueFlow(lobby);
    return;
  }
  const win = winner(lg);
  if (win) {
    endGame(lobby, win);
    return;
  }
  const successorIndex = lg.queue.findIndex((t) => t.type === 'successor');
  if (successorIndex >= 0) {
    const [task] = lg.queue.splice(successorIndex, 1);
    if (lobby.players.get(task.id)?.connected) {
      nextPhase(lobby, 'lg-successor', { actors: [task.id] });
      narrate(lg, `👑 Le maire ${name(lobby, task.id)} est mort : il désigne son successeur.`);
      setTimer(lobby, MS.successor, () => {
        lg.mayorId = pick([...lg.alive]);
        narrate(lg, `👑 ${name(lobby, lg.mayorId)} devient le nouveau maire (tiré au sort).`);
        continueFlow(lobby);
      });
      return;
    }
    lg.mayorId = pick([...lg.alive]);
    continueFlow(lobby);
    return;
  }
  if (lg.after === 'day') startDay(lobby);
  else startNight(lobby);
}

// --- Jour ---------------------------------------------------------------------------------------------

function startDay(lobby) {
  const lg = lgOf(lobby);
  lg.day += 1;
  if (lg.mayorEnabled && !lg.mayorId) {
    nextPhase(lobby, 'lg-mayor', { votes: new Map(), candidates: [...lg.alive] });
    narrate(lg, '👑 Élection du maire : sa voix comptera double.');
    setTimer(lobby, MS.mayor, () => resolveMayor(lobby));
    return;
  }
  startDebate(lobby);
}

function startDebate(lobby) {
  const lg = lgOf(lobby);
  nextPhase(lobby, 'lg-debate');
  narrate(lg, `🗣️ Jour ${lg.day} : débattez ! Qui est loup-garou ?`);
  setTimer(lobby, lg.debateMs, () => startVote(lobby));
}

function startVote(lobby) {
  const lg = lgOf(lobby);
  nextPhase(lobby, 'lg-vote', { votes: new Map(), candidates: [...lg.alive] });
  narrate(lg, '🗳️ Place au vote : qui éliminer ?');
  setTimer(lobby, MS.vote, () => resolveVote(lobby));
}

const voters = (lobby) => {
  const lg = lgOf(lobby);
  return lobby.connectedPlayers.filter((p) => lg.alive.has(p.id) && !(lobby.state === 'lg-vote' && lg.idiots.has(p.id)));
};

function dayVote(lobby, playerId, target) {
  const lg = lgOf(lobby);
  if (!['lg-vote', 'lg-mayor'].includes(lobby.state)) throw new GameError('NOT_VOTING', 'Ce n’est pas le moment de voter.');
  if (!lg.alive.has(playerId)) throw new GameError('ELIMINATED', 'Les morts ne votent pas.');
  if (lobby.state === 'lg-vote' && lg.idiots.has(playerId)) throw new GameError('NO_VOTE', 'L’idiot du village ne vote plus.');
  if (!lg.candidates.includes(target)) throw new GameError('INVALID_TARGET', 'Vote invalide.');
  lg.votes.set(playerId, target);
  checkVotes(lobby);
}

export function checkVotes(lobby) {
  if (!['lg-vote', 'lg-mayor'].includes(lobby.state)) return false;
  const lg = lgOf(lobby);
  const list = voters(lobby);
  if (list.length === 0 || !list.every((p) => lg.votes.has(p.id))) return false;
  if (lobby.state === 'lg-mayor') resolveMayor(lobby);
  else resolveVote(lobby);
  return true;
}

function tally(lg, weighted) {
  const counts = new Map();
  for (const [voter, target] of lg.votes) {
    if (!lg.alive.has(target)) continue;
    counts.set(target, (counts.get(target) ?? 0) + (weighted && voter === lg.mayorId ? 2 : 1));
  }
  const max = counts.size ? Math.max(...counts.values()) : 0;
  return { counts, top: [...counts].filter(([, n]) => n === max).map(([id]) => id), max };
}

function resolveMayor(lobby) {
  const lg = lgOf(lobby);
  const { top } = tally(lg, false);
  lg.mayorId = pick(top.length ? top : [...lg.alive]);
  narrate(lg, `👑 ${name(lobby, lg.mayorId)} est élu maire${top.length > 1 ? ' (égalité départagée au hasard)' : ''} !`);
  startDebate(lobby);
}

function resolveVote(lobby) {
  const lg = lgOf(lobby);
  const { counts, top } = tally(lg, true);
  const details = [...lg.votes].map(([voterId, targetId]) => ({ voterId, targetId }));
  lg.lastDeaths = [];
  lg.after = 'night';
  if (top.length !== 1) {
    lg.announce = { type: 'verdict', targetId: null, counts: Object.fromEntries(counts), details, tie: top.length > 1 };
    narrate(lg, top.length > 1 ? '⚖️ Égalité : personne n’est éliminé.' : '🤷 Personne n’a voté : personne n’est éliminé.');
  } else {
    const [target] = top;
    if (roleOf(lg, target) === 'idiot' && !lg.idiots.has(target)) {
      lg.idiots.add(target);
      lg.announce = { type: 'verdict', targetId: target, idiot: true, counts: Object.fromEntries(counts), details };
      narrate(lg, `🤪 ${name(lobby, target)} était l’idiot du village : il est épargné, mais ne votera plus.`);
    } else {
      kill(lobby, target, 'vote');
      lg.announce = { type: 'verdict', targetId: target, counts: Object.fromEntries(counts), details, deaths: lg.lastDeaths };
      narrate(lg, `⚰️ Le village élimine ${name(lobby, target)}, qui était ${ROLES[roleOf(lg, target)].label}.`);
    }
  }
  nextPhase(lobby, 'lg-verdict');
  setTimer(lobby, MS.verdict, () => continueFlow(lobby));
}

// --- Fin de partie ------------------------------------------------------------------------------------

function endGame(lobby, win) {
  const lg = lgOf(lobby);
  lobby.clearQuizTimer();
  const winners = [...lg.roles.keys()].filter((id) => {
    if (win === 'amoureux') return lg.lovers.includes(id);
    if (win === 'village') return ROLES[roleOf(lg, id)].camp === 'village';
    if (win === 'loups') return roleOf(lg, id) === 'loup';
    return false;
  });
  for (const id of winners) lobby.game.totals[id] = 1;
  lg.result = {
    winner: win,
    winners,
    roles: [...lg.roles].map(([id, role]) => ({ id, role, alive: lg.alive.has(id) })),
    lovers: lg.lovers,
    nights: lg.night,
  };
  const label = { village: 'Victoire du village 🧑‍🌾', loups: 'Victoire des loups-garous 🐺', amoureux: 'Victoire des amoureux 💘', personne: 'Tout le monde est mort…' }[win];
  narrate(lg, `🏁 ${label}`);
  lobby.game.history = [{ question: label, answer: '', topPlayerIds: winners }];
  lobby.finish();
  lobby.game.final.lg = { ...lg.result, label };
}

// --- Commandes de l'hôte, départs ---------------------------------------------------------------------

// « Passer » : on termine tout de suite l'étape en cours (comme si le chrono était écoulé).
export function hostSkip(lobby) {
  const lg = lgOf(lobby);
  switch (lobby.state) {
    case 'lg-reveal':
      return startNight(lobby);
    case 'lg-night':
      return lg.actors.length ? endStep(lobby, true) : nextStep(lobby);
    case 'lg-dawn':
    case 'lg-verdict':
    case 'lg-hunter':
      return continueFlow(lobby);
    case 'lg-successor':
      lg.mayorId = pick([...lg.alive]);
      return continueFlow(lobby);
    case 'lg-mayor':
      return resolveMayor(lobby);
    case 'lg-debate':
      return startVote(lobby);
    case 'lg-vote':
      return resolveVote(lobby);
    default:
      throw new GameError('NOT_NOW', 'Rien à passer pour le moment.');
  }
}

export function progress(lobby) {
  return checkVotes(lobby);
}

export function chat(lobby, playerId, { channel, text } = {}) {
  const lg = lgOf(lobby);
  if (!lg) throw new GameError('NOT_PLAYING', 'Pas de partie en cours.');
  const clean = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_LEN) : '';
  if (!clean) throw new GameError('EMPTY', 'Écris un message.');
  if (!channelsFor(lobby, playerId).write.includes(channel)) throw new GameError('CHAT_CLOSED', 'Tu ne peux pas écrire ici pour le moment.');
  addChat(lg, channel, { from: playerId, text: clean });
}

const NIGHT_STATES = new Set(['lg-reveal', 'lg-night']);

export function channelsFor(lobby, viewerId) {
  const lg = lgOf(lobby);
  const role = roleOf(lg, viewerId);
  const alive = lg.alive.has(viewerId);
  const read = ['village'];
  const write = [];
  if (alive && !NIGHT_STATES.has(lobby.state)) write.push('village');
  if (role === 'loup' && alive) {
    read.push('wolves');
    if (lobby.state === 'lg-night' && lg.step === 'loups') write.push('wolves');
  }
  if (role === 'petite-fille' && alive) read.push('wolves');
  if (!alive && lg.roles.has(viewerId)) {
    read.push('wolves', 'dead');
    write.push('dead');
  }
  return { read: [...new Set(read)], write };
}

// --- Ce que voit chaque joueur ------------------------------------------------------------------------

export function lgPublic(lobby, viewerId) {
  const lg = lobby.game?.lg;
  if (!lg) return null;
  const role = roleOf(lg, viewerId);
  const alive = lg.alive.has(viewerId);
  const ended = lobby.state === 'finished';
  const seeAll = ended || (!alive && lg.roles.has(viewerId));

  // Rôles que ce joueur a le droit de connaître.
  const known = {};
  for (const d of lg.dead) known[d.id] = d.role;
  for (const id of lg.idiots) known[id] = 'idiot';
  if (role) known[viewerId] = role;
  if (role === 'loup') for (const id of holders(lg, 'loup')) known[id] = 'loup';
  for (const s of lg.seer.get(viewerId) ?? []) known[s.targetId] = s.role;
  if (seeAll) for (const [id, r] of lg.roles) known[id] = r;

  const loverOf = lg.lovers?.includes(viewerId) ? lg.lovers.find((id) => id !== viewerId) : null;
  const isActor = lg.actors.includes(viewerId);
  const channels = role ? channelsFor(lobby, viewerId) : { read: ['village'], write: [] };
  const anonymize = role === 'petite-fille' && alive && !seeAll;
  const chats = {};
  for (const channel of channels.read) {
    chats[channel] = lg.chat[channel].map((m) => (channel === 'wolves' && anonymize ? { ...m, from: null } : m));
  }

  const votesVisible = ['lg-vote', 'lg-mayor'].includes(lobby.state);
  return {
    phase: lobby.state,
    step: lg.step,
    stepText: lg.step ? STEP_TEXT[lg.step] : null,
    night: lg.night,
    day: lg.day,
    endsAt: lg.endsAt,
    serverNow: Date.now(),
    seats: lg.seats,
    alive: [...lg.alive],
    dead: lg.dead,
    idiots: [...lg.idiots],
    mayorId: lg.mayorId,
    composition: lg.composition,
    known,
    lovers: seeAll ? lg.lovers : loverOf ? [viewerId, loverOf] : null,
    actors: ['lg-hunter', 'lg-successor'].includes(lobby.state) ? lg.actors : [], // le chasseur / le maire sont publics
    votes: votesVisible || lobby.state === 'lg-verdict' ? Object.fromEntries(lg.votes) : null,
    candidates: votesVisible ? lg.candidates : null,
    announce: lg.announce,
    chats,
    canWrite: channels.write,
    me: role
      ? {
          role,
          alive,
          isActor,
          teammates: role === 'loup' ? holders(lg, 'loup').filter((id) => id !== viewerId) : [],
          seer: role === 'voyante' ? lg.seer.get(viewerId) ?? [] : null,
          seerPicked: role === 'voyante' && isActor ? lg.seerPicked : false,
          guardLast: role === 'salvateur' ? lg.guardLast : null,
          wolfVotes: role === 'loup' && lobby.state === 'lg-night' && lg.step === 'loups' ? Object.fromEntries(lg.wolfVotes) : null,
          witch: role === 'sorciere' ? { life: lg.witch.life, death: lg.witch.death, victim: isActor ? lg.wolfVictim : null } : null,
          myVote: lg.votes.get(viewerId) ?? null,
          canVote: alive && (lobby.state === 'lg-mayor' || (lobby.state === 'lg-vote' && !lg.idiots.has(viewerId))),
        }
      : null,
    result: lg.result,
  };
}

export function playerGone(lobby, playerId) {
  const lg = lobby.game?.lg;
  if (!lg || !lg.alive.has(playerId) || lobby.state === 'finished') return;
  // Un joueur qui quitte définitivement la partie est considéré comme mort (rôle révélé).
  lg.lastDeaths = [];
  kill(lobby, playerId, 'parti');
  narrate(lg, `🚪 ${name(lobby, playerId)} a quitté la partie (${ROLES[roleOf(lg, playerId)].label}).`);
  lg.queue = lg.queue.filter((t) => t.id !== playerId);
  const win = winner(lg);
  if (win) endGame(lobby, win);
}
