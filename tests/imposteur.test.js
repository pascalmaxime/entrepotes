import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/game/Lobby.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { effectiveRoles, roleLimits, IMPOSTOR_POINTS } from '../src/game/modes/imposteur.js';
import { createWordBank, loadWordBank } from '../src/imposteur/wordBank.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);

function setup(count, settings = {}) {
  const lobby = new Lobby('ABCDE', { questionBank: createQuestionBank(['Q ?']), wordBank: createWordBank([['Chat', 'Chien']]) });
  const players = Array.from({ length: count }, (_, i) => lobby.addPlayer(`Joueur${i + 1}`, `s${i}`));
  const host = players[0].id;
  lobby.setMode(host, 'imposteur');
  lobby.setSettings(host, { rounds: 1, impostors: 1, whites: 1, clueMode: 'ecrit', ...settings });
  lobby.startGame(host);
  const m = lobby.game.manche;
  const byRole = (role) => players.filter((p) => m.roles.get(p.id) === role).map((p) => p.id);
  return { lobby, players, host, m, civils: byRole('civil'), impostors: byRole('impostor'), whites: byRole('white') };
}

const readyAll = (lobby, players) => players.forEach((p) => lobby.impostorReady(p.id));
const giveClues = (lobby) => {
  while (lobby.state === 'clues') {
    const speaker = lobby.publicState().game.impostor.speaker;
    lobby.impostorClue(speaker, `indice ${Math.random().toString(36).slice(2, 6)}`);
  }
};
// Chaque joueur vivant vote contre `target` (ou contre `fallback` s'il est lui-même la cible).
const voteAll = (lobby, target, fallback) => {
  for (const id of lobby.game.manche.alive) lobby.impostorVote(id, id === target ? fallback : target);
};

test('Imposteur : nombre de méchants selon le nombre de joueurs', () => {
  assert.deepEqual(roleLimits(4), { maxBad: 2, whiteMax: 1, impostorsMax: 2 });
  assert.equal(roleLimits(8).whiteMax, 2);
  const at4 = effectiveRoles({ impostors: 3, whites: 1 }, 4);
  assert.deepEqual([at4.impostors, at4.whites, at4.civils], [1, 1, 2], 'jamais plus de méchants que de civils');
  const at6 = effectiveRoles({ impostors: 5, whites: 2 }, 6);
  assert.deepEqual([at6.impostors, at6.whites, at6.civils], [2, 1, 3]);
  const at10 = effectiveRoles({ impostors: 2, whites: 2 }, 10);
  assert.deepEqual([at10.impostors, at10.whites, at10.civils], [2, 2, 6]);
  for (let n = 4; n <= 12; n += 1) {
    const r = effectiveRoles({ impostors: 12, whites: 12 }, n);
    assert.ok(r.impostors + r.whites <= r.civils, `${n} joueurs`);
    assert.ok(r.impostors >= 1);
  }
});

test('Imposteur : le fichier de mots se charge (beaucoup de paires)', () => {
  const bank = loadWordBank(new URL('../data/imposteur.json', import.meta.url));
  assert.ok(bank.size >= 300, `${bank.size} paires`);
  const used = new Set();
  const pick = bank.pick(used);
  assert.ok(pick.civil && pick.impostor && pick.civil !== pick.impostor);
  assert.equal(used.size, 1);
});

test('Imposteur : 4 joueurs minimum', () => {
  const lobby = new Lobby('ABCDE', { questionBank: createQuestionBank(['Q ?']), wordBank: createWordBank([['Chat', 'Chien']]) });
  const a = lobby.addPlayer('A', 's1');
  ['B', 'C'].forEach((n, i) => lobby.addPlayer(n, `s${i + 2}`));
  lobby.setMode(a.id, 'imposteur');
  expectError(() => lobby.startGame(a.id), 'NOT_ENOUGH_PLAYERS');
});

test('Imposteur : chacun ne voit que son mot, rôles secrets', () => {
  const { lobby, civils, impostors, whites, m } = setup(5);
  assert.equal(lobby.state, 'reveal');
  assert.deepEqual(m.composition, { civils: 3, impostors: 1, whites: 1 });
  const civilView = lobby.publicState(civils[0]);
  assert.equal(civilView.you.word, m.words.civil);
  assert.equal(civilView.you.isWhite, false);
  assert.equal(JSON.stringify(civilView).includes(m.words.impostor), false);
  const impostorView = lobby.publicState(impostors[0]);
  assert.equal(impostorView.you.word, m.words.impostor);
  assert.equal(impostorView.you.isWhite, false, 'l’imposteur ne sait pas qu’il est imposteur');
  const whiteView = lobby.publicState(whites[0]);
  assert.equal(whiteView.you.word, null);
  assert.equal(whiteView.you.isWhite, true);
  for (const view of [civilView, impostorView, whiteView]) {
    assert.equal(JSON.stringify(view.game).includes('"role"'), false, 'aucun rôle visible avant élimination');
  }
});

test('Imposteur : partie complète (Mr. White éliminé puis l’imposteur → victoire des civils)', () => {
  const { lobby, players, host, civils, impostors, whites, m } = setup(5);
  readyAll(lobby, players);
  assert.equal(lobby.state, 'clues');
  const order = lobby.publicState().game.impostor.order;
  assert.notEqual(m.roles.get(order[0]), 'white', 'Mr. White ne commence jamais');

  const speaker = order[0];
  const other = order[1];
  expectError(() => lobby.impostorClue(other, 'coucou'), 'NOT_YOUR_TURN');
  if (m.roles.get(speaker) === 'civil') expectError(() => lobby.impostorClue(speaker, `  ${m.words.civil.toUpperCase()} `), 'CLUE_IS_WORD');
  giveClues(lobby);
  assert.equal(lobby.state, 'ballot');
  assert.equal(lobby.publicState().game.impostor.clues[0].entries.length, 5);

  expectError(() => lobby.impostorVote(civils[0], civils[0]), 'INVALID_VOTE');
  voteAll(lobby, whites[0], civils[0]);
  assert.equal(lobby.state, 'elimination');
  const elim = lobby.publicState().game.impostor.elimination;
  assert.equal(elim.playerId, whites[0]);
  assert.equal(elim.role, 'white');
  assert.equal(elim.awaitingGuess, true);
  expectError(() => lobby.impostorNext(host), 'WAIT_GUESS');
  expectError(() => lobby.impostorGuess(civils[0], 'x'), 'NOT_WHITE');
  lobby.impostorGuess(whites[0], 'pas du tout ça');
  assert.equal(lobby.publicState().game.impostor.outcome, null);

  lobby.impostorNext(host);
  assert.equal(lobby.state, 'clues');
  assert.equal(lobby.game.manche.tour, 2);
  giveClues(lobby);
  voteAll(lobby, impostors[0], civils[0]);
  assert.equal(lobby.publicState().game.impostor.outcome.winner, 'civils');
  lobby.impostorNext(host);
  assert.equal(lobby.state, 'round-end');
  const reveal = lobby.publicState().game.impostor.reveal;
  assert.deepEqual(reveal.words, m.words);
  assert.equal(reveal.roles.length, 5);
  for (const id of civils) assert.equal(lobby.game.totals[id], IMPOSTOR_POINTS.civil);
  assert.equal(lobby.game.totals[impostors[0]] ?? 0, 0);

  lobby.impostorNext(host);
  assert.equal(lobby.state, 'finished');
  assert.equal(lobby.game.final.recap.length, 1);
});

test('Imposteur : Mr. White qui trouve le mot gagne seul', () => {
  const { lobby, players, civils, whites, m } = setup(5);
  readyAll(lobby, players);
  giveClues(lobby);
  voteAll(lobby, whites[0], civils[0]);
  lobby.impostorGuess(whites[0], m.words.civil.toLowerCase());
  const view = lobby.publicState().game.impostor;
  assert.equal(view.outcome.winner, 'white');
  assert.equal(lobby.game.totals[whites[0]], IMPOSTOR_POINTS.whiteGuess);
});

test('Imposteur : à 4 joueurs, éliminer un civil fait gagner les infiltrés', () => {
  const { lobby, players, host, civils, impostors, whites } = setup(4);
  readyAll(lobby, players);
  giveClues(lobby);
  voteAll(lobby, civils[0], civils[1]);
  assert.equal(lobby.publicState().game.impostor.outcome.winner, 'infiltres');
  assert.equal(lobby.game.totals[impostors[0]], IMPOSTOR_POINTS.impostor);
  assert.equal(lobby.game.totals[whites[0]], IMPOSTOR_POINTS.white);
  lobby.impostorNext(host);
  assert.equal(lobby.state, 'round-end');
});

test('Imposteur : égalité → revote entre ex aequo, puis personne n’est éliminé', () => {
  const { lobby, players, host, civils, impostors } = setup(6, { whites: 0 });
  readyAll(lobby, players);
  giveClues(lobby);
  const [a, b] = [civils[0], civils[1]];
  const others = [...lobby.game.manche.alive].filter((id) => id !== a && id !== b);
  const splitVote = () => {
    lobby.impostorVote(a, b);
    lobby.impostorVote(b, a);
    others.forEach((id, i) => lobby.impostorVote(id, i < 2 ? a : b));
  };
  splitVote();
  assert.equal(lobby.state, 'ballot', 'égalité : on revote');
  const view = lobby.publicState().game.impostor;
  assert.equal(view.revote, true);
  assert.deepEqual([...view.candidates].sort(), [a, b].sort());
  assert.deepEqual(view.votedIds, [], 'les votes repartent de zéro');
  expectError(() => lobby.impostorVote(impostors[0], civils[2]), 'INVALID_VOTE');
  splitVote();
  assert.equal(lobby.state, 'elimination');
  assert.equal(lobby.publicState().game.impostor.elimination.tie, true);
  assert.equal(lobby.game.manche.alive.size, 6);
  lobby.impostorNext(host);
  assert.equal(lobby.state, 'clues');
});

test('Imposteur : mode oral, l’hôte lance le vote', () => {
  const { lobby, players, host } = setup(4, { clueMode: 'oral' });
  readyAll(lobby, players);
  assert.equal(lobby.state, 'clues');
  expectError(() => lobby.impostorClue(lobby.publicState().game.impostor.speaker ?? host, 'x'), 'ORAL_MODE');
  lobby.forceReveal(host);
  assert.equal(lobby.state, 'ballot');
});

test('Imposteur : joueurs déconnectés passés, imposteur qui quitte = victoire des civils', () => {
  const { lobby, players, impostors, civils } = setup(6, { whites: 0 });
  readyAll(lobby, players);
  const speaker = lobby.publicState().game.impostor.speaker;
  lobby.markDisconnected(speaker, players.find((p) => p.id === speaker).socketId);
  assert.notEqual(lobby.publicState().game.impostor.speaker, speaker, 'joueur absent passé');
  lobby.removePlayer(impostors[0]);
  assert.equal(lobby.state, 'round-end');
  assert.equal(lobby.game.totals[civils[0]], IMPOSTOR_POINTS.civil);
});

test('Imposteur : réglages limités par le nombre de joueurs', () => {
  const lobby = new Lobby('ABCDE', { questionBank: createQuestionBank(['Q ?']), wordBank: createWordBank([['Chat', 'Chien']]) });
  const host = lobby.addPlayer('A', 's1').id;
  ['B', 'C', 'D', 'E'].forEach((n, i) => lobby.addPlayer(n, `s${i + 2}`));
  lobby.setMode(host, 'imposteur');
  lobby.setSettings(host, { impostors: 4, whites: 3 });
  const limits = lobby.publicState(host).limits.impostor;
  assert.deepEqual([limits.impostors, limits.whites, limits.civils], [1, 1, 3]);
  expectError(() => lobby.setSettings(host, { clueMode: 'mime' }), 'INVALID_SETTINGS');
});
