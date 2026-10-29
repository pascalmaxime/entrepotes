import { randomInt, randomUUID } from 'node:crypto';
import { GameError } from './errors.js';
import { sanitizeName } from './names.js';
import { assignRanks } from './ranking.js';
import { DEFAULT_MODE, getMode } from './modes/index.js';
import topMeme, { MEME_REROLLS } from './modes/topMeme.js';
import { QUIZ_LIMITS } from './modes/mCulture.js';
import { CATEGORIES, CATEGORY_IDS } from '../mculture/quizBank.js';
import { suggestCorrect } from '../mculture/match.js';
import { CLUE_MODES, effectiveRoles } from './modes/imposteur.js';
import * as impostor from '../imposteur/engine.js';
import * as justePrix from '../justeprix/engine.js';
import * as paint from '../paint/engine.js';
import * as lg from '../loupgarou/engine.js';
import * as tb from '../tictacboum/engine.js';
import * as cc from '../coqane/engine.js';

export const MAX_PLAYERS = 12;
export const ROUNDS_LIMITS = Object.freeze({ min: 1, max: 20, default: 5 });
// Marge laissée après la fin du chrono pour les réponses envoyées au dernier moment.
const QUIZ_GRACE_MS = 800;

const OPEN_STATES = new Set(['lobby', 'finished']);

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Un lobby = un groupe de joueurs + la partie en cours.
 * Modes "question" (Qui de nous, Tier List) : lobby → question ⇄ results → finished
 * Mode "meme" (Top Meme)                      : lobby → create → vote → results → … → finished
 * Mode "quiz" (M-Culture)                     : lobby → quiz (toutes les questions) → review (correction) → finished
 * Mode "impostor" (L'Imposteur)               : lobby → reveal → clues ⇄ ballot → elimination → … → round-end → … → finished
 */
export class Lobby {
  constructor(code, { questionBank, memeLibrary = null, quizBank = null, wordBank = null, justePrixBank = null, paintWords = null }) {
    this.code = code;
    this.questionBank = questionBank;
    this.memeLibrary = memeLibrary;
    this.quizBank = quizBank;
    this.onChange = null; // appelé quand l'état change tout seul (fin du chrono)
    this.quizTimer = null;
    this.usedQuiz = new Set();
    this.wordBank = wordBank;
    this.usedPairs = new Set();
    this.justePrixBank = justePrixBank;
    this.usedJustePrix = new Set();
    this.paintWords = paintWords;
    this.usedPaintWords = new Set();
    this.extraTimers = []; // chronos secondaires (indices de Paint…)
    this.players = new Map();
    this.hostId = null;
    this.mode = DEFAULT_MODE;
    this.settings = {
      rounds: ROUNDS_LIMITS.default,
      questions: QUIZ_LIMITS.questions.default,
      timer: QUIZ_LIMITS.defaultTimer,
      categories: [...CATEGORY_IDS],
      impostor: { impostors: 1, whites: 1, clueMode: 'ecrit' },
      justePrix: { categories: [...justePrix.JP_CATEGORY_IDS], timer: QUIZ_LIMITS.defaultTimer },
      paint: { turns: paint.PAINT_LIMITS.turns.default, timer: paint.PAINT_LIMITS.defaultTimer },
      loupGarou: { custom: null, ...lg.LG_LIMITS.defaults }, // custom null = composition recommandée
      ticTacBoum: { ...tb.TB_LIMITS.defaults, positions: [...tb.TB_LIMITS.defaults.positions] },
      coqAne: { ...cc.CC_LIMITS.defaults },
    };
    this.state = 'lobby';
    this.game = null;
    this.usedQuestions = new Set();
    this.createdAt = Date.now();
  }

  get isEmpty() {
    return this.players.size === 0;
  }

  get connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  get playerIds() {
    return [...this.players.keys()];
  }

  get currentMode() {
    return getMode(this.game?.modeId ?? this.mode);
  }

  get currentQuestion() {
    return this.game?.questions?.[this.game.index] ?? null;
  }

  // --- Joueurs ---------------------------------------------------------------

  addPlayer(rawName, socketId) {
    this.assertOpen('Une partie est en cours dans ce lobby. Attends la fin pour rejoindre.');
    if (this.players.size >= MAX_PLAYERS) {
      throw new GameError('LOBBY_FULL', `Le lobby est complet (${MAX_PLAYERS} joueurs max).`);
    }
    const name = sanitizeName(rawName);
    const lower = name.toLocaleLowerCase('fr');
    if ([...this.players.values()].some((p) => p.name.toLocaleLowerCase('fr') === lower)) {
      throw new GameError('NAME_TAKEN', 'Ce pseudo est déjà pris dans ce lobby.');
    }
    const player = {
      id: randomUUID(),
      token: randomUUID(), // secret qui permet de se reconnecter (veille du téléphone, refresh…)
      name,
      socketId,
      connected: true,
      disconnectedAt: null,
      joinedAt: Date.now(),
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    return player;
  }

  reconnect(playerId, token, socketId) {
    const player = this.players.get(playerId);
    if (!player || player.token !== token) {
      throw new GameError('RECONNECT_FAILED', 'Impossible de te reconnecter à cette partie.');
    }
    const previousSocketId = player.connected ? player.socketId : null;
    player.socketId = socketId;
    player.connected = true;
    player.disconnectedAt = null;
    if (!this.players.get(this.hostId)?.connected) this.hostId = player.id;
    return { player, previousSocketId };
  }

  // Ignoré si la socket n'est plus la socket active du joueur (il s'est déjà reconnecté ailleurs).
  markDisconnected(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player || !player.connected || player.socketId !== socketId) return false;
    player.connected = false;
    player.disconnectedAt = Date.now();
    if (this.hostId === playerId) this.transferHost();
    this.checkProgress();
    return true;
  }

  removePlayer(playerId) {
    if (!this.players.delete(playerId)) return false;
    if (this.game) {
      this.game.votes?.delete(playerId);
      this.game.assignments?.delete(playerId);
      this.game.submissions?.delete(playerId);
      this.game.memeVotes?.delete(playerId);
      for (const responses of this.game.responses ?? []) responses.delete(playerId);
      if (this.game.kind === 'impostor') impostor.impostorPlayerGone(this, playerId);
      if (this.game.kind === 'juste-prix') justePrix.playerGone(this, playerId);
      if (this.game.kind === 'paint') paint.playerGone(this, playerId);
      if (this.game.kind === 'loup-garou') lg.playerGone(this, playerId);
      if (this.game.kind === 'tic-tac-boum') tb.playerGone(this, playerId);
    }
    if (this.hostId === playerId) this.transferHost();
    if (this.isEmpty) this.hostId = null;
    this.checkProgress();
    return true;
  }

  // L'hôte passe au joueur connecté le plus ancien.
  transferHost() {
    const candidate = [...this.players.values()]
      .filter((p) => p.connected && p.id !== this.hostId)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (candidate) this.hostId = candidate.id;
    else if (!this.players.has(this.hostId)) this.hostId = this.playerIds[0] ?? null;
  }

  // --- Réglages (hôte) -----------------------------------------------------------

  assertHost(playerId) {
    if (playerId !== this.hostId) throw new GameError('NOT_HOST', 'Seul l’hôte peut faire ça.');
  }

  assertOpen(message) {
    if (!OPEN_STATES.has(this.state)) throw new GameError('GAME_IN_PROGRESS', message);
  }

  setMode(playerId, modeId) {
    this.assertHost(playerId);
    this.assertOpen('Impossible de changer de mode pendant une partie.');
    if (!getMode(modeId)) throw new GameError('INVALID_MODE', 'Ce mode de jeu n’existe pas.');
    this.mode = modeId;
  }

  // Chaque réglage est facultatif : on ne modifie que ce qui est envoyé.
  setSettings(playerId, { rounds, questions, timer, categories, impostors, whites, clueMode, jpCategories, jpTimer, paintTurns, paintTimer, lgCustom, lgMayor, lgNight, lgDebate, tbLives, tbFuse, tbDifficulty, tbPositions, ccDraw, ccGuess, ccDifficulty } = {}) {
    this.assertHost(playerId);
    this.assertOpen('Impossible de modifier les réglages pendant une partie.');
    const next = { ...this.settings };
    const int = (value, label) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) throw new GameError('INVALID_SETTINGS', `${label} invalide.`);
      return parsed;
    };
    if (rounds !== undefined) {
      next.rounds = Math.min(ROUNDS_LIMITS.max, Math.max(ROUNDS_LIMITS.min, int(rounds, 'Nombre de manches')));
    }
    if (questions !== undefined) {
      const { min, max } = QUIZ_LIMITS.questions;
      next.questions = Math.min(max, Math.max(min, int(questions, 'Nombre de questions')));
    }
    if (timer !== undefined) {
      const value = int(timer, 'Chrono');
      if (!QUIZ_LIMITS.timers.includes(value)) throw new GameError('INVALID_SETTINGS', 'Durée de chrono invalide.');
      next.timer = value;
    }
    if (categories !== undefined) {
      if (!Array.isArray(categories)) throw new GameError('INVALID_SETTINGS', 'Catégories invalides.');
      next.categories = CATEGORY_IDS.filter((id) => categories.includes(id));
      if (next.categories.length === 0) throw new GameError('INVALID_SETTINGS', 'Garde au moins une catégorie.');
    }
    if (impostors !== undefined || whites !== undefined || clueMode !== undefined) {
      const wanted = { ...next.impostor };
      if (impostors !== undefined) wanted.impostors = int(impostors, 'Nombre d’imposteurs');
      if (whites !== undefined) wanted.whites = int(whites, 'Nombre de Mr. White');
      if (clueMode !== undefined) {
        if (!CLUE_MODES.includes(clueMode)) throw new GameError('INVALID_SETTINGS', 'Mode d’indices invalide.');
        wanted.clueMode = clueMode;
      }
      // On garde des valeurs possibles pour le nombre de joueurs actuel (au moins 4 pour le calcul).
      const roles = effectiveRoles(wanted, Math.max(4, this.players.size));
      next.impostor = { ...wanted, impostors: roles.impostors, whites: roles.whites };
    }
    if (jpCategories !== undefined || jpTimer !== undefined) {
      const jp = { ...next.justePrix };
      if (jpCategories !== undefined) {
        if (!Array.isArray(jpCategories)) throw new GameError('INVALID_SETTINGS', 'Catégories invalides.');
        jp.categories = justePrix.JP_CATEGORY_IDS.filter((id) => jpCategories.includes(id));
        if (jp.categories.length === 0) throw new GameError('INVALID_SETTINGS', 'Garde au moins une catégorie.');
      }
      if (jpTimer !== undefined) {
        const value = int(jpTimer, 'Chrono');
        if (!QUIZ_LIMITS.timers.includes(value)) throw new GameError('INVALID_SETTINGS', 'Durée de chrono invalide.');
        jp.timer = value;
      }
      next.justePrix = jp;
    }
    if (paintTurns !== undefined || paintTimer !== undefined) {
      const p = { ...next.paint };
      const { min, max } = paint.PAINT_LIMITS.turns;
      if (paintTurns !== undefined) p.turns = Math.min(max, Math.max(min, int(paintTurns, 'Nombre de tours')));
      if (paintTimer !== undefined) {
        const value = int(paintTimer, 'Chrono');
        if (!paint.PAINT_LIMITS.timers.includes(value)) throw new GameError('INVALID_SETTINGS', 'Durée de chrono invalide (60 s minimum).');
        p.timer = value;
      }
      next.paint = p;
    }
    if ([ccDraw, ccGuess, ccDifficulty].some((v) => v !== undefined)) {
      next.coqAne = cc.sanitizeSettings(next.coqAne, { ccDraw, ccGuess, ccDifficulty });
    }
    if ([tbLives, tbFuse, tbDifficulty, tbPositions].some((v) => v !== undefined)) {
      next.ticTacBoum = tb.sanitizeSettings(next.ticTacBoum, { tbLives, tbFuse, tbDifficulty, tbPositions });
    }
    if ([lgCustom, lgMayor, lgNight, lgDebate].some((v) => v !== undefined)) {
      const l = { ...next.loupGarou };
      if (lgCustom !== undefined) l.custom = lg.sanitizeCustom(lgCustom);
      if (lgMayor !== undefined) l.mayor = Boolean(lgMayor);
      if (lgNight !== undefined) {
        const value = int(lgNight, 'Durée de nuit');
        if (!lg.LG_LIMITS.night.includes(value)) throw new GameError('INVALID_SETTINGS', 'Durée de nuit invalide.');
        l.night = value;
      }
      if (lgDebate !== undefined) {
        const value = int(lgDebate, 'Durée du débat');
        if (!lg.LG_LIMITS.debate.includes(value)) throw new GameError('INVALID_SETTINGS', 'Durée du débat invalide.');
        l.debate = value;
      }
      next.loupGarou = l;
    }
    if ([rounds, questions, timer, categories, impostors, whites, clueMode, jpCategories, jpTimer, paintTurns, paintTimer, lgCustom, lgMayor, lgNight, lgDebate, tbLives, tbFuse, tbDifficulty, tbPositions, ccDraw, ccGuess, ccDifficulty].every((v) => v === undefined)) {
      throw new GameError('INVALID_SETTINGS', 'Aucun réglage à modifier.');
    }
    this.settings = next;
  }

  // --- Lancement de la partie ------------------------------------------------------

  startGame(playerId) {
    this.assertHost(playerId);
    this.assertOpen('Une partie est déjà en cours.');
    const mode = getMode(this.mode);
    if (this.connectedPlayers.length < mode.minPlayers) {
      throw new GameError(
        'NOT_ENOUGH_PLAYERS',
        `Il faut au moins ${mode.minPlayers} joueurs connectés pour le mode ${mode.label}.`,
      );
    }
    const base = { modeId: mode.id, kind: mode.kind, index: 0, result: null, history: [], totals: {}, final: null };

    if (mode.kind === 'quiz') {
      this.startQuiz(base);
      return;
    }

    if (mode.kind === 'juste-prix') {
      justePrix.startJustePrix(this, base);
      return;
    }

    if (mode.kind === 'coq-ane') {
      cc.startCoqAne(this, base);
      return;
    }

    if (mode.kind === 'tic-tac-boum') {
      tb.startTicTacBoum(this, base);
      return;
    }

    if (mode.kind === 'loup-garou') {
      lg.startLoupGarou(this, base);
      return;
    }

    if (mode.kind === 'paint') {
      if (!this.paintWords) throw new GameError('NO_WORDS', 'Aucune liste de mots disponible.');
      paint.startPaint(this, base);
      return;
    }

    if (mode.kind === 'impostor') {
      if (!this.wordBank) throw new GameError('NO_WORDS', 'Aucune liste de mots disponible.');
      impostor.startImpostorGame(this, base);
      return;
    }

    if (mode.kind === 'meme') {
      if (!this.memeLibrary?.count) {
        throw new GameError('NO_TEMPLATES', 'Ajoutez au moins une image à la bibliothèque pour jouer à Top Meme.');
      }
      this.game = { ...base, totalRounds: this.settings.rounds, usedTemplates: new Set() };
      this.startMemeRound();
      return;
    }

    const questions = this.questionBank.pick(this.settings.rounds, this.usedQuestions);
    this.game = { ...base, questions, totalRounds: questions.length, votes: new Map() };
    this.state = 'question';
  }

  // Révélation / passage à l'étape suivante dès que tous les joueurs CONNECTÉS ont joué.
  checkProgress() {
    if (this.state === 'question') return this.checkAllVoted();
    if (this.state === 'create') return this.checkAllSubmitted();
    if (this.state === 'vote') return this.checkAllMemeVoted();
    if (this.state === 'quiz') return this.checkAllAnswered();
    if (this.state === 'jp-question') return justePrix.checkAllAnswered(this);
    if (this.game?.kind === 'paint') return paint.progress(this);
    if (this.game?.kind === 'loup-garou' && this.state !== 'finished') return lg.progress(this);
    if (this.game?.kind === 'tic-tac-boum') return tb.progress(this);
    if (this.game?.kind === 'coq-ane') return cc.progress(this);
    if (this.game?.kind === 'impostor') return impostor.checkImpostorProgress(this);
    return false;
  }

  // --- Modes "question" (Qui de nous, Tier List) ----------------------------------------

  // On peut changer son vote tant que les résultats ne sont pas révélés.
  submitVote(playerId, rawVote) {
    if (this.state !== 'question') throw new GameError('NOT_VOTING', 'Le vote est terminé pour cette question.');
    const vote = this.currentMode.normalizeVote(rawVote, { playerIds: this.playerIds });
    if (vote === null) throw new GameError('INVALID_VOTE', 'Vote invalide, réessaie.');
    this.game.votes.set(playerId, vote);
    this.checkAllVoted();
  }

  checkAllVoted() {
    if (this.state !== 'question') return false;
    const voters = this.connectedPlayers;
    if (voters.length === 0 || !voters.every((p) => this.game.votes.has(p.id))) return false;
    this.reveal();
    return true;
  }

  reveal() {
    const mode = this.currentMode;
    const result = mode.aggregate(this.game.votes, this.playerIds);
    for (const [id, points] of Object.entries(mode.scoreDelta(result))) {
      this.game.totals[id] = (this.game.totals[id] ?? 0) + points;
    }
    this.game.result = result;
    this.game.history.push({ question: this.currentQuestion, topPlayerIds: mode.topPlayerIds(result) });
    this.state = 'results';
  }

  // --- Mode "meme" (Top Meme) -----------------------------------------------------------

  // Tire une image au hasard : d'abord parmi celles pas encore vues dans la partie,
  // puis parmi celles pas déjà données dans la manche, sinon n'importe laquelle.
  drawTemplate(taken = new Set()) {
    const library = this.memeLibrary;
    const id =
      library?.randomId(new Set([...this.game.usedTemplates, ...taken])) ?? library?.randomId(taken) ?? library?.randomId();
    if (!id) throw new GameError('NO_TEMPLATES', 'La bibliothèque d’images est vide : ajoutez des images pour jouer.');
    return id;
  }

  startMemeRound() {
    const assignments = new Map();
    const taken = new Set();
    for (const playerId of this.playerIds) {
      const templateId = this.drawTemplate(taken);
      taken.add(templateId);
      assignments.set(playerId, { templateId, rerollsLeft: MEME_REROLLS });
    }
    for (const id of taken) this.game.usedTemplates.add(id);
    Object.assign(this.game, { assignments, submissions: new Map(), memeVotes: new Map(), voteOrder: [] });
    this.state = 'create';
  }

  rerollTemplate(playerId) {
    if (this.state !== 'create') throw new GameError('NOT_CREATING', 'La phase de création est terminée.');
    const assignment = this.game.assignments.get(playerId);
    if (!assignment) throw new GameError('NOT_PLAYING', 'Tu ne participes pas à cette manche.');
    if (this.game.submissions.has(playerId)) throw new GameError('ALREADY_SUBMITTED', 'Tu as déjà envoyé ton meme.');
    if (assignment.rerollsLeft <= 0) throw new GameError('NO_REROLL', 'Plus de changement d’image possible pour cette manche.');
    const taken = new Set([...this.game.assignments.values()].map((a) => a.templateId));
    const templateId = this.drawTemplate(taken);
    if (templateId === assignment.templateId) {
      throw new GameError('NO_REROLL', 'Pas d’autre image disponible dans la bibliothèque.');
    }
    this.game.usedTemplates.add(templateId);
    assignment.templateId = templateId;
    assignment.rerollsLeft -= 1;
  }

  // On peut renvoyer son meme (le modifier) tant que le vote n'a pas commencé.
  submitMeme(playerId, rawItems) {
    if (this.state !== 'create') throw new GameError('NOT_CREATING', 'La phase de création est terminée.');
    const assignment = this.game.assignments.get(playerId);
    if (!assignment) throw new GameError('NOT_PLAYING', 'Tu ne participes pas à cette manche.');
    const items = topMeme.sanitizeItems(rawItems);
    if (items.length === 0) throw new GameError('EMPTY_MEME', 'Ajoute au moins un texte ou un emoji.');
    const previous = this.game.submissions.get(playerId);
    this.game.submissions.set(playerId, {
      id: previous?.id ?? randomUUID().slice(0, 8), // identifiant anonyme pendant le vote
      authorId: playerId,
      templateId: assignment.templateId,
      items,
    });
    this.checkAllSubmitted();
  }

  checkAllSubmitted() {
    if (this.state !== 'create') return false;
    const players = this.connectedPlayers;
    if (players.length === 0 || !players.every((p) => this.game.submissions.has(p.id))) return false;
    this.startMemeVote();
    return true;
  }

  startMemeVote() {
    this.game.voteOrder = shuffle([...this.game.submissions.keys()]);
    this.state = 'vote';
    this.checkAllMemeVoted();
  }

  // Les memes à noter par un joueur : tous sauf le sien.
  memesToRate(playerId) {
    return this.game.voteOrder.filter((authorId) => authorId !== playerId && this.game.submissions.has(authorId));
  }

  submitMemeVotes(playerId, rawVotes) {
    if (this.state !== 'vote') throw new GameError('NOT_VOTING', 'Le vote est terminé pour cette manche.');
    const expected = this.memesToRate(playerId);
    if (expected.length === 0) throw new GameError('NOTHING_TO_VOTE', 'Aucun meme à noter pour toi.');
    const votes = new Map();
    for (const authorId of expected) {
      const value = rawVotes?.[this.game.submissions.get(authorId).id];
      if (![1, 0, -1].includes(value)) throw new GameError('INVALID_VOTE', 'Note tous les memes avant d’envoyer.');
      votes.set(authorId, value);
    }
    this.game.memeVotes.set(playerId, votes);
    this.checkAllMemeVoted();
  }

  checkAllMemeVoted() {
    if (this.state !== 'vote') return false;
    const players = this.connectedPlayers;
    if (players.length === 0) return false;
    const required = players.filter((p) => this.memesToRate(p.id).length > 0);
    if (!required.every((p) => this.game.memeVotes.has(p.id))) return false;
    this.revealMemes();
    return true;
  }

  revealMemes() {
    const result = topMeme.aggregate(this.game);
    for (const meme of result.memes) {
      this.game.totals[meme.authorId] = (this.game.totals[meme.authorId] ?? 0) + meme.score;
    }
    const [best] = result.memes;
    this.game.result = result;
    this.game.history.push({
      round: this.game.index + 1,
      question: `Manche ${this.game.index + 1}`,
      topPlayerIds: topMeme.topPlayerIds(result),
      best: best ? { authorId: best.authorId, templateId: best.templateId, items: best.items } : null,
    });
    this.state = 'results';
  }

  // --- Mode "quiz" (M-Culture) -------------------------------------------------------------

  startQuiz(base) {
    const questions = this.quizBank?.pick({ categories: this.settings.categories, count: this.settings.questions }, this.usedQuiz) ?? [];
    if (questions.length === 0) {
      throw new GameError('NO_QUESTIONS', 'Aucune question disponible dans les catégories choisies.');
    }
    this.clearQuizTimer();
    this.game = {
      ...base,
      questions,
      totalRounds: questions.length,
      timer: this.settings.timer,
      responses: questions.map(() => new Map()), // par question : joueur → { text, locked }
      marks: null,
      reviewIndex: 0,
      deadline: null,
    };
    this.state = 'quiz';
    this.openQuizQuestion();
  }

  openQuizQuestion() {
    const { game } = this;
    this.clearQuizTimer();
    game.deadline = game.timer > 0 ? Date.now() + game.timer * 1000 : null;
    if (game.deadline) {
      const index = game.index;
      this.quizTimer = setTimeout(() => {
        this.quizTimer = null;
        if (this.state !== 'quiz' || this.game?.index !== index) return;
        this.advanceQuiz();
        this.onChange?.(this);
      }, game.timer * 1000 + QUIZ_GRACE_MS);
      this.quizTimer.unref?.();
    }
  }

  clearQuizTimer() {
    if (this.quizTimer) clearTimeout(this.quizTimer);
    this.quizTimer = null;
    for (const timer of this.extraTimers ?? []) clearTimeout(timer);
    this.extraTimers = [];
  }

  // `final` : le joueur a cliqué sur « Valider ». Sinon c'est un brouillon (envoyé pendant la saisie,
  // pour que la réponse compte même si le chrono tombe avant la validation).
  submitAnswer(playerId, { index, text, final = true } = {}) {
    if (this.state !== 'quiz') throw new GameError('NOT_ANSWERING', 'Ce n’est plus le moment de répondre.');
    if (index !== this.game.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la question suivante !');
    if (typeof text !== 'string') throw new GameError('INVALID_ANSWER', 'Réponse invalide.');
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, QUIZ_LIMITS.answerMax);
    if (final && !clean) throw new GameError('EMPTY_ANSWER', 'Écris une réponse (ou attends la fin du chrono).');
    this.game.responses[index].set(playerId, { text: clean, locked: Boolean(final) });
    this.checkAllAnswered();
  }

  checkAllAnswered() {
    if (this.state !== 'quiz') return false;
    const responses = this.game.responses[this.game.index];
    const players = this.connectedPlayers;
    if (players.length === 0 || !players.every((p) => responses.get(p.id)?.locked)) return false;
    this.advanceQuiz();
    return true;
  }

  advanceQuiz() {
    const { game } = this;
    if (game.index + 1 >= game.totalRounds) {
      this.startReview();
      return;
    }
    game.index += 1;
    this.openQuizQuestion();
  }

  // Correction : chaque réponse est pré-cochée si elle ressemble à la bonne, l'hôte ajuste.
  startReview() {
    const { game } = this;
    this.clearQuizTimer();
    game.deadline = null;
    game.marks = game.questions.map((question, index) => {
      const marks = new Map();
      for (const [playerId, { text }] of game.responses[index]) marks.set(playerId, suggestCorrect(question, text));
      return marks;
    });
    game.reviewIndex = 0;
    this.state = 'review';
  }

  markAnswer(playerId, { index, playerId: targetId, correct } = {}) {
    this.assertHost(playerId);
    if (this.state !== 'review') throw new GameError('NOT_REVIEWING', 'La correction n’a pas commencé.');
    if (!Number.isInteger(index) || index < 0 || index >= this.game.totalRounds) {
      throw new GameError('INVALID_MARK', 'Question inconnue.');
    }
    if (!this.game.responses[index].get(targetId)?.text) throw new GameError('INVALID_MARK', 'Ce joueur n’a pas répondu.');
    this.game.marks[index].set(targetId, Boolean(correct));
  }

  goToReview(playerId, { index } = {}) {
    this.assertHost(playerId);
    if (this.state !== 'review') throw new GameError('NOT_REVIEWING', 'La correction n’a pas commencé.');
    if (!Number.isInteger(index) || index < 0 || index >= this.game.totalRounds) {
      throw new GameError('INVALID_REVIEW', 'Question inconnue.');
    }
    this.game.reviewIndex = index;
  }

  quizScores() {
    const { game } = this;
    const totals = {};
    game.questions.forEach((question, index) => {
      for (const [playerId, correct] of game.marks?.[index] ?? []) {
        if (correct) totals[playerId] = (totals[playerId] ?? 0) + question.pts;
      }
    });
    return totals;
  }

  finishQuiz(playerId) {
    this.assertHost(playerId);
    if (this.state !== 'review') throw new GameError('NOT_REVIEWING', 'La correction n’a pas commencé.');
    const { game } = this;
    game.totals = this.quizScores();
    game.history = game.questions.map((question, index) => ({
      question: quizLabel(question),
      answer: question.answer ?? '',
      pts: question.pts,
      topPlayerIds: [...game.marks[index]].filter(([, correct]) => correct).map(([id]) => id),
    }));
    game.index = game.totalRounds;
    this.finish();
  }

  // --- Mode "impostor" (L'Imposteur) -------------------------------------------------------

  // --- Mode "juste-prix" (Le Juste Prix) -----------------------------------------------------

  justePrixAnswer(playerId, payload) {
    justePrix.submitAnswer(this, playerId, payload);
  }

  // --- Mode "paint" (Paint) ------------------------------------------------------------------

  paintChoose(playerId, difficulty) {
    paint.chooseWord(this, playerId, difficulty);
  }

  paintGuess(playerId, text) {
    return paint.submitGuess(this, playerId, text);
  }

  paintDraw(playerId, op) {
    return paint.draw(this, playerId, op);
  }

  paintSync() {
    return paint.syncOps(this);
  }

  // --- Mode "coq-ane" (Du coq à l'âne) ---------------------------------------------------------

  ccSubmit(playerId, payload) {
    cc.submit(this, playerId, payload);
  }

  ccRevealAll(playerId) {
    cc.revealAll(this, playerId);
  }

  // --- Mode "tic-tac-boum" -------------------------------------------------------------------

  tbWord(playerId, text) {
    return tb.submitWord(this, playerId, text);
  }

  tbTyping(playerId, text) {
    return tb.typing(this, playerId, text);
  }

  // --- Mode "loup-garou" ----------------------------------------------------------------------

  lgAct(playerId, payload) {
    if (this.game?.kind !== 'loup-garou') throw new GameError('NOT_PLAYING', 'Pas de partie de Loup-Garou en cours.');
    lg.act(this, playerId, payload);
  }

  lgChat(playerId, payload) {
    if (this.game?.kind !== 'loup-garou') throw new GameError('NOT_PLAYING', 'Pas de partie de Loup-Garou en cours.');
    lg.chat(this, playerId, payload);
  }

  impostorReady(playerId) {
    impostor.markReady(this, playerId);
  }

  impostorClue(playerId, text) {
    impostor.submitClue(this, playerId, text);
  }

  impostorVote(playerId, targetId) {
    impostor.submitImpostorVote(this, playerId, targetId);
  }

  impostorGuess(playerId, text) {
    impostor.submitGuess(this, playerId, text);
  }

  impostorNext(playerId) {
    this.assertHost(playerId);
    if (this.game?.kind !== 'impostor') throw new GameError('NOT_NOW', 'Pas encore !');
    if (impostor.impostorNext(this) === 'finish') {
      this.game.index = this.game.totalRounds;
      this.finish();
    }
  }

  dispose() {
    this.clearQuizTimer();
    this.onChange = null;
  }

  // --- Commandes de l'hôte ---------------------------------------------------------------

  // Bouton "passer à la suite" : révèle les votes / lance le vote des memes sans attendre les retardataires.
  forceReveal(playerId) {
    this.assertHost(playerId);
    if (this.state === 'question') {
      if (this.game.votes.size === 0) throw new GameError('NO_VOTES', 'Personne n’a encore voté.');
      this.reveal();
    } else if (this.state === 'create') {
      if (this.game.submissions.size === 0) throw new GameError('NO_MEMES', 'Personne n’a encore envoyé de meme.');
      this.startMemeVote();
    } else if (this.state === 'vote') {
      if (this.game.memeVotes.size === 0) throw new GameError('NO_VOTES', 'Personne n’a encore voté.');
      this.revealMemes();
    } else if (this.state === 'quiz') {
      this.advanceQuiz(); // l'hôte passe la question
    } else if (this.state === 'cc-step') {
      cc.hostSkip(this); // l'hôte fait tourner les carnets sans attendre
    } else if (this.state.startsWith('tb-')) {
      tb.hostSkip(this); // l'hôte fait passer la bombe d'un joueur qui ne répond plus
    } else if (this.state.startsWith('lg-')) {
      lg.hostSkip(this); // l'hôte passe l'étape en cours (joueur absent…)
    } else if (['paint-choose', 'paint-draw', 'paint-end'].includes(this.state)) {
      if (paint.hostSkip(this) === 'finish') this.finish(); // l'hôte passe la manche
    } else if (this.state === 'jp-question') {
      justePrix.reveal(this); // l'hôte révèle sans attendre les retardataires
    } else if (this.game?.kind === 'impostor') {
      impostor.impostorForce(this);
    } else {
      throw new GameError('NOT_VOTING', 'Rien à révéler pour le moment.');
    }
  }

  nextQuestion(playerId) {
    this.assertHost(playerId);
    if (this.state === 'jp-reveal') {
      if (justePrix.nextJustePrix(this) === 'finish') this.finish();
      return;
    }
    if (this.state === 'cc-reveal') {
      cc.revealNext(this, playerId);
      return;
    }
    if (this.state === 'paint-end') {
      if (paint.hostSkip(this) === 'finish') this.finish();
      return;
    }
    if (this.state !== 'results') throw new GameError('NOT_IN_RESULTS', 'Les résultats ne sont pas encore affichés.');
    const { game } = this;
    if (game.index + 1 >= game.totalRounds) {
      game.index += 1;
      this.finish();
      return;
    }
    if (game.kind === 'meme') {
      const previous = { index: game.index, result: game.result };
      game.index += 1;
      try {
        this.startMemeRound();
        game.result = null;
      } catch (error) {
        Object.assign(game, previous); // bibliothèque vidée entre-temps : on reste sur les résultats
        throw error;
      }
      return;
    }
    game.index += 1;
    game.votes = new Map();
    game.result = null;
    this.state = 'question';
  }

  finish() {
    const ranking = this.playerIds
      .map((playerId) => ({ playerId, total: this.game.totals[playerId] ?? 0 }))
      .sort((a, b) => b.total - a.total);
    assignRanks(ranking, (e) => e.total);
    this.game.result = null;
    this.game.final = { type: this.game.modeId, ranking, recap: this.game.history };
    this.state = 'finished';
  }

  backToLobby(playerId) {
    this.assertHost(playerId);
    this.clearQuizTimer();
    this.state = 'lobby';
    this.game = null;
  }

  // --- Ce qui est envoyé aux navigateurs ----------------------------------------------------
  // Jamais les jetons, jamais les votes en cours, jamais l'auteur d'un meme avant les résultats.

  publicState(viewerId = null) {
    const { game, state } = this;
    const live = (ids) => [...ids].filter((id) => this.players.has(id));
    let votedIds = [];
    if (state === 'question') votedIds = live(game.votes.keys());
    if (state === 'vote') votedIds = live(game.memeVotes.keys());
    if (state === 'jp-question') votedIds = live(game.answers.keys());
    if (state === 'paint-draw') votedIds = live(game.manche.found.keys());
    if (state === 'quiz') {
      votedIds = live([...game.responses[game.index]].filter(([, r]) => r.locked).map(([id]) => id));
    }
    const impostorView = game?.kind === 'impostor' && state !== 'finished' ? impostor.impostorPublic(this) : null;

    return {
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      settings: { ...this.settings },
      state,
      limits: { maxPlayers: MAX_PLAYERS, rounds: { ...ROUNDS_LIMITS }, quiz: this.quizLimits(), impostor: this.impostorLimits(), justePrix: this.justePrixLimits(), paint: this.paintLimits(), loupGarou: this.loupGarouLimits(), ticTacBoum: OPEN_STATES.has(state) ? tb.tbLimits() : null, coqAne: OPEN_STATES.has(state) ? { ...cc.CC_LIMITS, minPlayers: cc.MIN_PLAYERS, players: this.connectedPlayers.length } : null },
      library: this.memeLibrary ? { count: this.memeLibrary.count } : null,
      players: [...this.players.values()].map(({ id, name, connected }) => ({
        id,
        name,
        connected,
        isHost: id === this.hostId,
      })),
      game: game
        ? {
            modeId: game.modeId,
            kind: game.kind,
            round: Math.min(game.index + 1, game.totalRounds),
            totalRounds: game.totalRounds,
            question: ['quiz', 'juste-prix'].includes(game.kind) ? null : this.currentQuestion,
            votedIds,
            submittedIds: state === 'create' ? live(game.submissions.keys()) : [],
            memes:
              state === 'vote'
                ? game.voteOrder
                    .filter((authorId) => game.submissions.has(authorId))
                    .map((authorId) => {
                      const { id, templateId, items } = game.submissions.get(authorId);
                      return { id, templateId, items };
                    })
                : [],
            quiz: state === 'quiz' ? this.quizPublic() : null,
            review: state === 'review' ? this.reviewPublic() : null,
            impostor: impostorView,
            justePrix: game.kind === 'juste-prix' ? justePrix.justePrixPublic(this) : null,
            paint: game.kind === 'paint' ? paint.paintPublic(this, viewerId) : null,
            loupGarou: game.kind === 'loup-garou' ? lg.lgPublic(this, viewerId) : null,
            ticTacBoum: game.kind === 'tic-tac-boum' ? tb.tbPublic(this) : null,
            coqAne: game.kind === 'coq-ane' ? cc.ccPublic(this, viewerId) : null,
            result: state === 'results' || state === 'jp-reveal' ? game.result : null,
            final: state === 'finished' ? game.final : null,
          }
        : null,
      you: this.privateState(viewerId),
    };
  }

  // Infos propres à chaque joueur (son image, son meme, s'il a voté).
  privateState(viewerId) {
    const { game } = this;
    if (viewerId && game?.kind === 'impostor') return this.state === 'finished' ? null : impostor.impostorPrivate(this, viewerId);
    if (viewerId && game?.kind === 'juste-prix') return justePrix.justePrixPrivate(this, viewerId);
    if (viewerId && game?.kind === 'quiz' && this.state === 'quiz') {
      const response = game.responses[game.index].get(viewerId);
      return { answer: response?.text ?? '', locked: Boolean(response?.locked) };
    }
    if (!viewerId || game?.kind !== 'meme') return null;
    if (this.state === 'create') {
      const assignment = game.assignments.get(viewerId);
      return {
        assignment: assignment ? { ...assignment } : null,
        submission: game.submissions.get(viewerId)?.items ?? null,
      };
    }
    if (this.state === 'vote') {
      return { memeId: game.submissions.get(viewerId)?.id ?? null, voted: game.memeVotes.has(viewerId) };
    }
    return null;
  }

  // Réglages de L'Imposteur : rôles réellement utilisés avec le nombre de joueurs actuel.
  // Loup-Garou : composition (recommandée ou choisie par l'hôte) pour les joueurs connectés.
  loupGarouLimits() {
    if (!OPEN_STATES.has(this.state)) return null;
    const n = this.connectedPlayers.length;
    return {
      minPlayers: lg.MIN_PLAYERS,
      players: n,
      night: [...lg.LG_LIMITS.night],
      debate: [...lg.LG_LIMITS.debate],
      recommended: lg.composition(n, null).roles,
      composition: lg.composition(n, this.settings.loupGarou.custom),
    };
  }

  // Paint : nombre de manches = joueurs connectés × tours, seulement dans le lobby.
  paintLimits() {
    if (!OPEN_STATES.has(this.state)) return null;
    return {
      turns: { ...paint.PAINT_LIMITS.turns },
      timers: [...paint.PAINT_LIMITS.timers],
      players: this.connectedPlayers.length,
      words: this.paintWords?.counts() ?? {},
    };
  }

  // Le Juste Prix : catégories (avec le nombre de questions dispo) et chronos, seulement dans le lobby.
  justePrixLimits() {
    if (!OPEN_STATES.has(this.state)) return null;
    const counts = this.justePrixBank?.counts() ?? {};
    return {
      timers: [...QUIZ_LIMITS.timers],
      categories: justePrix.JP_CATEGORIES.map(({ id, label, emoji }) => ({ id, label, emoji, count: counts[id] ?? 0 })),
    };
  }

  impostorLimits() {
    if (!OPEN_STATES.has(this.state)) return null;
    const count = this.players.size;
    const roles = effectiveRoles(this.settings.impostor, Math.max(4, count));
    return {
      playerCount: count,
      impostors: roles.impostors,
      whites: roles.whites,
      civils: Math.max(0, count - roles.impostors - roles.whites),
      impostorsMax: Math.max(1, roles.limits.maxBad - roles.whites),
      whitesMax: Math.max(0, Math.min(roles.limits.whiteMax, roles.limits.maxBad - 1)),
    };
  }

  // Réglages M-Culture (catégories + nombre de questions dispo), seulement dans le lobby.
  quizLimits() {
    if (!OPEN_STATES.has(this.state)) return null;
    const counts = this.quizBank?.counts() ?? {};
    return {
      questions: { ...QUIZ_LIMITS.questions },
      timers: [...QUIZ_LIMITS.timers],
      categories: CATEGORIES.map(({ id, label, emoji }) => ({ id, label, emoji, count: counts[id] ?? 0 })),
    };
  }

  // La question en cours SANS la réponse.
  quizPublic() {
    const { game } = this;
    return {
      index: game.index,
      total: game.totalRounds,
      deadline: game.deadline,
      serverNow: Date.now(),
      timer: game.timer,
      question: publicQuizQuestion(game.questions[game.index]),
    };
  }

  reviewPublic() {
    const { game } = this;
    const index = game.reviewIndex;
    const question = game.questions[index];
    const responses = game.responses[index];
    return {
      index,
      total: game.totalRounds,
      question: { ...publicQuizQuestion(question), answer: question.answer, alt: question.alt },
      answers: this.playerIds.map((playerId) => ({
        playerId,
        text: responses.get(playerId)?.text ?? '',
        correct: Boolean(game.marks[index].get(playerId)),
      })),
      scores: this.quizScores(),
      // Pour la frise de navigation : combien de bonnes réponses par question.
      overview: game.questions.map((q, i) => ({ cat: q.cat, correct: [...game.marks[i].values()].filter(Boolean).length })),
    };
  }
}

function publicQuizQuestion(question) {
  const { cat, prompt, pts, flag, mapId, emoji, hint, song, letter } = question;
  return { cat, prompt, pts, flag, mapId, emoji, hint, song, letter };
}

function quizLabel(question) {
  switch (question.cat) {
    case 'drapeaux':
      return '🚩 Drapeau';
    case 'carte':
      return '🗺️ Pays sur la carte';
    case 'rebus':
      return `🧩 ${question.emoji}`;
    case 'musique':
      return `🎵 « ${question.song.title} »`;
    case 'petit-bac':
      return `✏️ ${question.prompt} en ${question.letter}`;
    default:
      return question.prompt;
  }
}
