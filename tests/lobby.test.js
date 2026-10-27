import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/game/Lobby.js';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';

const bank = () => createQuestionBank(['Q1 ?', 'Q2 ?', 'Q3 ?', 'Q4 ?']);

function setup(names = ['Alice', 'Bob', 'Chloé']) {
  const lobby = new Lobby('ABCDE', { questionBank: bank() });
  const players = names.map((name, i) => lobby.addPlayer(name, `socket-${i}`));
  return { lobby, players };
}

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);

test('le premier joueur devient hôte', () => {
  const { lobby, players } = setup();
  assert.equal(lobby.hostId, players[0].id);
});

test('pseudo déjà pris (sans tenir compte des majuscules) ou vide : refusé', () => {
  const { lobby } = setup();
  expectError(() => lobby.addPlayer('alice', 's'), 'NAME_TAKEN');
  expectError(() => lobby.addPlayer('   ', 's'), 'INVALID_NAME');
});

test('seul l’hôte peut lancer la partie', () => {
  const { lobby, players } = setup();
  expectError(() => lobby.startGame(players[1].id), 'NOT_HOST');
});

test('Tier List exige 3 joueurs connectés', () => {
  const { lobby, players } = setup(['Alice', 'Bob']);
  lobby.setMode(players[0].id, 'tier-list');
  expectError(() => lobby.startGame(players[0].id), 'NOT_ENOUGH_PLAYERS');
});

test('partie complète Qui de nous : révélation auto puis classement final', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.setSettings(a.id, { rounds: 2 });
  lobby.startGame(a.id);
  lobby.submitVote(a.id, b.id);
  lobby.submitVote(b.id, b.id);
  assert.equal(lobby.state, 'question');
  lobby.submitVote(c.id, a.id);
  assert.equal(lobby.state, 'results');
  assert.deepEqual(lobby.game.result.winners, [b.id]);

  lobby.nextQuestion(a.id);
  assert.equal(lobby.publicState().game.round, 2);
  [a, b, c].forEach((p) => lobby.submitVote(p.id, c.id));
  lobby.nextQuestion(a.id);

  assert.equal(lobby.state, 'finished');
  const { final } = lobby.publicState().game;
  // c : 0 + 3 = 3 · b : 2 + 0 = 2 · a : 1 + 0 = 1
  assert.deepEqual(final.ranking.map((e) => [e.playerId, e.total]), [[c.id, 3], [b.id, 2], [a.id, 1]]);
  assert.equal(final.recap.length, 2);
});

test('les votes ne sont jamais envoyés avant la révélation', () => {
  const { lobby, players } = setup();
  lobby.startGame(players[0].id);
  lobby.submitVote(players[0].id, players[1].id);
  const { game } = lobby.publicState();
  assert.deepEqual(game.votedIds, [players[0].id]);
  assert.equal(game.result, null);
  assert.ok(!JSON.stringify(lobby.publicState()).includes(players[0].token));
});

test('un joueur déconnecté ne bloque pas le vote', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.startGame(a.id);
  lobby.submitVote(a.id, b.id);
  lobby.submitVote(b.id, a.id);
  lobby.markDisconnected(c.id, 'socket-2');
  assert.equal(lobby.state, 'results');
});

test('l’hôte est transféré quand il se déconnecte', () => {
  const { lobby, players } = setup();
  lobby.markDisconnected(players[0].id, 'socket-0');
  assert.equal(lobby.hostId, players[1].id);
});

test('reconnexion : bon jeton accepté, mauvais refusé, ancienne socket ignorée', () => {
  const { lobby, players } = setup();
  const [a] = players;
  expectError(() => lobby.reconnect(a.id, 'faux', 's'), 'RECONNECT_FAILED');
  lobby.reconnect(a.id, a.token, 'socket-new');
  assert.equal(lobby.markDisconnected(a.id, 'socket-0'), false);
  assert.equal(lobby.players.get(a.id).connected, true);
});

test('impossible de rejoindre une partie en cours', () => {
  const { lobby, players } = setup();
  lobby.startGame(players[0].id);
  expectError(() => lobby.addPlayer('Dan', 's'), 'GAME_IN_PROGRESS');
});

test('nettoyage : joueur parti trop longtemps retiré, lobby vide supprimé', () => {
  const manager = new LobbyManager({ questionBank: bank(), graceMs: 1000 });
  const lobby = manager.create();
  const player = lobby.addPlayer('Solo', 's1');
  lobby.markDisconnected(player.id, 's1');
  manager.sweep(Date.now() + 500);
  assert.equal(manager.size, 1);
  manager.sweep(Date.now() + 2000);
  assert.equal(manager.size, 0);
});

test('codes de lobby uniques et sans caractères ambigus', () => {
  const manager = new LobbyManager({ questionBank: bank() });
  const codes = new Set(Array.from({ length: 200 }, () => manager.create().code));
  assert.equal(codes.size, 200);
  for (const code of codes) assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
});

test('la banque de questions évite les répétitions', () => {
  const questions = bank();
  const used = new Set();
  const all = [...questions.pick(2, used), ...questions.pick(2, used)];
  assert.equal(new Set(all).size, 4);
});
