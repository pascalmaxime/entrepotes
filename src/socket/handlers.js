import { GameError } from '../game/errors.js';
import { sanitizeName } from '../game/names.js';
import { getMode } from '../game/modes/index.js';

const room = (code) => `lobby:${code}`;

/**
 * Événements Socket.io. Chaque événement répond via un "ack" :
 *   { ok: true, ...données }  ou  { ok: false, error: 'CODE', message: 'Texte pour le joueur' }
 * Après chaque changement, chaque joueur reçoit 'lobby:state' : l'état commun + ses infos
 * personnelles (son image et son meme en Top Meme), d'où un envoi joueur par joueur.
 */
export function registerSocketHandlers(io, manager) {
  const broadcast = (lobby) => {
    for (const player of lobby.players.values()) {
      if (player.connected) io.to(player.socketId).emit('lobby:state', lobby.publicState(player.id));
    }
  };
  // Changements qui ne viennent pas d'un joueur (fin du chrono M-Culture).
  manager.onLobbyChange = (lobby) => {
    if (manager.get(lobby.code) === lobby) broadcast(lobby);
  };

  io.on('connection', (socket) => {
    const on = (event, handler) => {
      socket.on(event, (payload, ack) => {
        if (typeof payload === 'function') {
          ack = payload;
          payload = {};
        }
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          const result = handler(payload && typeof payload === 'object' ? payload : {});
          reply({ ok: true, ...(result ?? {}) });
        } catch (error) {
          if (error instanceof GameError) {
            reply({ ok: false, error: error.code, message: error.message });
          } else {
            console.error(`[socket] ${event} :`, error);
            reply({ ok: false, error: 'INTERNAL', message: 'Erreur interne du serveur.' });
          }
        }
      });
    };

    const context = () => {
      const { code, playerId } = socket.data;
      const lobby = code ? manager.get(code) : null;
      if (!lobby || !lobby.players.has(playerId)) throw new GameError('NOT_IN_LOBBY', 'Tu n’es dans aucune partie.');
      return { lobby, playerId };
    };

    const attach = (lobby, player) => {
      socket.join(room(lobby.code));
      socket.data.code = lobby.code;
      socket.data.playerId = player.id;
    };

    // Quitte proprement le lobby actuel (si on en a un).
    const detach = () => {
      const { code, playerId } = socket.data;
      if (!code) return;
      socket.leave(room(code));
      socket.data.code = null;
      socket.data.playerId = null;
      const lobby = manager.get(code);
      if (!lobby) return;
      lobby.removePlayer(playerId);
      if (!manager.deleteIfEmpty(lobby)) broadcast(lobby);
    };

    const session = (lobby, player) => ({ code: lobby.code, playerId: player.id, token: player.token });

    on('lobby:create', ({ name, mode }) => {
      const cleanName = sanitizeName(name);
      if (mode !== undefined && !getMode(mode)) {
        throw new GameError('INVALID_MODE', 'Ce mode de jeu n’existe pas.');
      }
      detach();
      const lobby = manager.create();
      const player = lobby.addPlayer(cleanName, socket.id);
      if (mode) lobby.setMode(player.id, mode);
      attach(lobby, player);
      broadcast(lobby);
      console.log(`[lobby ${lobby.code}] créé par ${player.name}`);
      return session(lobby, player);
    });

    on('lobby:join', ({ code, name }) => {
      const lobby = manager.get(code);
      if (!lobby) throw new GameError('LOBBY_NOT_FOUND', 'Aucune partie avec ce code.');
      if (socket.data.code === lobby.code && lobby.players.has(socket.data.playerId)) {
        throw new GameError('ALREADY_IN_LOBBY', 'Tu es déjà dans cette partie.');
      }
      const player = lobby.addPlayer(name, socket.id);
      detach();
      attach(lobby, player);
      broadcast(lobby);
      return session(lobby, player);
    });

    on('lobby:rejoin', ({ code, playerId, token }) => {
      const lobby = manager.get(code);
      if (!lobby) throw new GameError('LOBBY_NOT_FOUND', 'Cette partie n’existe plus.');
      if (socket.data.code && (socket.data.code !== lobby.code || socket.data.playerId !== playerId)) detach();
      const { player, previousSocketId } = lobby.reconnect(playerId, token, socket.id);
      // Même joueur ouvert ailleurs (autre onglet / appareil) : l'ancienne fenêtre est déconnectée de la partie.
      if (previousSocketId && previousSocketId !== socket.id) {
        const previous = io.sockets.sockets.get(previousSocketId);
        if (previous) {
          previous.leave(room(lobby.code));
          previous.data.code = null;
          previous.data.playerId = null;
          previous.emit('session:replaced');
        }
      }
      attach(lobby, player);
      broadcast(lobby);
      return session(lobby, player);
    });

    on('lobby:leave', () => {
      detach();
    });

    const lobbyAction = (event, action) =>
      on(event, (payload) => {
        const { lobby, playerId } = context();
        action(lobby, playerId, payload);
        broadcast(lobby);
      });

    lobbyAction('lobby:set-mode', (lobby, playerId, { mode }) => lobby.setMode(playerId, mode));
    lobbyAction('lobby:set-settings', (lobby, playerId, settings) => lobby.setSettings(playerId, settings));
    lobbyAction('game:start', (lobby, playerId) => lobby.startGame(playerId));
    lobbyAction('game:vote', (lobby, playerId, { vote }) => lobby.submitVote(playerId, vote));
    lobbyAction('game:reveal', (lobby, playerId) => lobby.forceReveal(playerId));
    lobbyAction('game:next', (lobby, playerId) => lobby.nextQuestion(playerId));
    lobbyAction('game:back-to-lobby', (lobby, playerId) => lobby.backToLobby(playerId));
    lobbyAction('meme:reroll', (lobby, playerId) => lobby.rerollTemplate(playerId));
    lobbyAction('meme:submit', (lobby, playerId, { items }) => lobby.submitMeme(playerId, items));
    lobbyAction('meme:votes', (lobby, playerId, { votes }) => lobby.submitMemeVotes(playerId, votes));
    lobbyAction('jp:answer', (lobby, playerId, payload) => lobby.justePrixAnswer(playerId, payload));
    lobbyAction('paint:choose', (lobby, playerId, { difficulty }) => lobby.paintChoose(playerId, difficulty));
    lobbyAction('paint:guess', (lobby, playerId, { text }) => lobby.paintGuess(playerId, text));

    // Dessin en direct : les traits sont relayés aux autres joueurs SANS renvoyer tout l'état du lobby
    // (trop lourd à chaque coup de crayon). « Annuler » renvoie la liste complète des traits.
    on('paint:draw', ({ op }) => {
      const { lobby, playerId } = context();
      const { op: added, reset } = lobby.paintDraw(playerId, op);
      const key = lobby.game.index;
      if (reset) io.to(room(lobby.code)).emit('paint:reset', { key, ops: reset });
      else socket.to(room(lobby.code)).emit('paint:op', { key, op: added });
    });
    // Récupère tout le dessin en cours (arrivée sur l'écran, reconnexion).
    on('paint:sync', () => {
      const { lobby } = context();
      return lobby.paintSync();
    });
    lobbyAction('quiz:answer', (lobby, playerId, payload) => lobby.submitAnswer(playerId, payload));
    lobbyAction('quiz:mark', (lobby, playerId, payload) => lobby.markAnswer(playerId, payload));
    lobbyAction('quiz:review', (lobby, playerId, payload) => lobby.goToReview(playerId, payload));
    lobbyAction('quiz:finish', (lobby, playerId) => lobby.finishQuiz(playerId));
    lobbyAction('imp:ready', (lobby, playerId) => lobby.impostorReady(playerId));
    lobbyAction('imp:clue', (lobby, playerId, { text }) => lobby.impostorClue(playerId, text));
    lobbyAction('imp:vote', (lobby, playerId, { target }) => lobby.impostorVote(playerId, target));
    lobbyAction('imp:guess', (lobby, playerId, { text }) => lobby.impostorGuess(playerId, text));
    lobbyAction('imp:next', (lobby, playerId) => lobby.impostorNext(playerId));

    socket.on('disconnect', () => {
      const { code, playerId } = socket.data;
      const lobby = code ? manager.get(code) : null;
      if (lobby && lobby.markDisconnected(playerId, socket.id)) broadcast(lobby);
    });
  });

  return { broadcast };
}
