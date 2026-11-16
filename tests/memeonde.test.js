import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createScaleBank, getBank, pointsFor } from '../src/memeonde/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const SCALES = [{ key: 'Froid|Chaud', left: 'Froid', right: 'Chaud' }, { key: 'Nul|Génial', left: 'Nul', right: 'Génial' }];

function setup(n = 4, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.omBank = createScaleBank(SCALES);
  const players = ['Ana', 'Bob', 'Cléo', 'Dan'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'meme-onde');
  lobby.setSettings(players[0].id, { omClue: 30, omGuess: 20, ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players, om: lobby.game.om };
}
const view = (lobby, id) => lobby.publicState(id).game.memeOnde;

test('Sur la même onde : points selon la distance à la cible', () => {
  assert.equal(pointsFor(50, 50), 4);
  assert.equal(pointsFor(54, 50), 4);
  assert.equal(pointsFor(60, 50), 3);
  assert.equal(pointsFor(33, 50), 2);
  assert.equal(pointsFor(32, 50), 0);
  assert.ok(getBank().size >= 120);
});

test('Sur la même onde : cible secrète, indice, curseurs, points du médium', () => {
  const { lobby, players, om } = setup(4);
  try {
    assert.equal(lobby.state, 'om-clue');
    assert.equal(lobby.game.totalRounds, 4, '1 tour = chacun est médium une fois');
    const medium = om.medium;
    const others = players.map((p) => p.id).filter((id) => id !== medium);
    om.target = 70;
    assert.equal(view(lobby, medium).target, 70);
    for (const id of others) assert.equal(view(lobby, id).target, null, 'la cible reste secrète');
    expectError(() => lobby.omClue(others[0], { text: 'raclette' }), 'NOT_MEDIUM');
    expectError(() => lobby.omClue(medium, { text: '   ' }), 'EMPTY');
    lobby.omClue(medium, { text: 'Une raclette' });
    assert.equal(lobby.state, 'om-guess');
    assert.equal(view(lobby, others[0]).clue, 'Une raclette');
    expectError(() => lobby.omGuess(medium, { index: 0, position: 70 }), 'MEDIUM');
    expectError(() => lobby.omGuess(others[0], { index: 0, position: 140 }), 'INVALID');
    expectError(() => lobby.omGuess(others[0], { index: 1, position: 50 }), 'TOO_LATE');

    lobby.omGuess(others[0], { index: 0, position: 10 });
    lobby.omGuess(others[0], { index: 0, position: 72 }); // on peut changer d'avis → 4 pts
    lobby.omGuess(others[1], { index: 0, position: 60 }); // 3 pts
    assert.equal(lobby.state, 'om-guess');
    assert.ok(!JSON.stringify(lobby.publicState(others[2])).includes('"position"'), 'les curseurs des autres restent cachés');
    lobby.omGuess(others[2], { index: 0, position: 20 }); // 0 pt
    assert.equal(lobby.state, 'om-reveal');
    const r = lobby.publicState(medium).game.result;
    assert.equal(r.target, 70);
    assert.deepEqual(r.shots.map((s) => s.points), [4, 3, 0]);
    assert.equal(r.mediumPoints, 2, 'médium : moyenne (4 + 3 + 0) / 3 ≈ 2');
    assert.equal(lobby.game.totals[medium], 2);
    assert.equal(lobby.game.totals[others[0]], 4);

    // Tour suivant : un autre médium
    lobby.nextQuestion(lobby.hostId);
    assert.equal(lobby.state, 'om-clue');
    assert.notEqual(om.medium, medium);
  } finally {
    mock.timers.reset();
  }
});

test('Sur la même onde : chronos, médium absent, fin de partie, réglages', () => {
  const { lobby, players, om } = setup(3);
  try {
    // Chrono de l'indice écoulé : tour sauté
    mock.timers.tick(31_500);
    assert.equal(lobby.state, 'om-clue');
    assert.equal(om.index, 1);
    // Médium qui se déconnecte : tour sauté aussi
    const m = om.medium;
    lobby.markDisconnected(m, lobby.players.get(m).socketId);
    assert.equal(om.index, 2);
    // Dernier tour : indice, chrono de visée écoulé → révélation, puis fin
    lobby.omClue(om.medium, { text: 'Bof' });
    mock.timers.tick(21_500);
    assert.equal(lobby.state, 'om-reveal');
    lobby.nextQuestion(lobby.hostId);
    assert.equal(lobby.state, 'finished');
    assert.equal(lobby.publicState(lobby.hostId).game.final.recap.length, 3);

    lobby.backToLobby(lobby.hostId);
    expectError(() => lobby.setSettings(lobby.hostId, { omTurns: 5 }), 'INVALID_SETTINGS');
    lobby.setSettings(lobby.hostId, { omTurns: 2, omGuess: 45 });
    assert.deepEqual(lobby.settings.memeOnde, { turns: 2, clue: 30, guess: 45 });
    void players;
  } finally {
    mock.timers.reset();
  }
});
