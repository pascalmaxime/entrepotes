import { randomInt, randomUUID } from 'node:crypto';
import { GameError } from './errors.js';
import { sanitizeName } from './names.js';
import { assignRanks } from './ranking.js';
import { DEFAULT_MODE, getMode } from './modes/index.js';
import topMeme, { MEME_REROLLS } from './modes/topMeme.js';

export const MAX_PLAYERS = 12;
export const ROUNDS_LIMITS = Object.freeze({ min: 1, max: 20, default: 5 });

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
 */
export class Lobby {
  constructor(code, { questionBank, memeLibrary = null }) {
    this.code = code;
    this.questionBank = questionBank;
    this.memeLibrary = memeLibrary;
    this.players = new Map();
    this.hostId = null;
    this.mode = DEFAULT_MODE;
    this.settings = { rounds: ROUNDS_LIMITS.default };
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

  setSettings(playerId, { rounds } = {}) {
    this.assertHost(playerId);
    this.assertOpen('Impossible de modifier les réglages pendant une partie.');
    const value = Number.parseInt(rounds, 10);
    if (!Number.isFinite(value)) throw new GameError('INVALID_SETTINGS', 'Nombre de manches invalide.');
    this.settings.rounds = Math.min(ROUNDS_LIMITS.max, Math.max(ROUNDS_LIMITS.min, value));
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
    } else {
      throw new GameError('NOT_VOTING', 'Rien à révéler pour le moment.');
    }
  }

  nextQuestion(playerId) {
    this.assertHost(playerId);
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

    return {
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      settings: { ...this.settings },
      state,
      limits: { maxPlayers: MAX_PLAYERS, rounds: { ...ROUNDS_LIMITS } },
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
            question: this.currentQuestion,
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
            result: state === 'results' ? game.result : null,
            final: state === 'finished' ? game.final : null,
          }
        : null,
      you: this.privateState(viewerId),
    };
  }

  // Infos propres à chaque joueur (son image, son meme, s'il a voté).
  privateState(viewerId) {
    const { game } = this;
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
}
