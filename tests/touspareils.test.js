import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createQuestionBank as createTpBank, gainsFor, getBank, groupAnswers } from '../src/touspareils/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);

function setup(n = 5, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.tpBank = createTpBank(['Un fruit rouge', 'Une couleur', 'Un animal', 'Un sport', 'Un pays', 'Un dessert']);
  const players = ['Ana', 'Bob', 'Cléo', 'Dan', 'Eva'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'tous-pareils');
  lobby.setSettings(players[0].id, { tpRounds: 5, tpTimer: 20, ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players: players.map((p) => p.id), t: lobby.game.tp };
}

test('Tous pareils ! : les réponses identiques sont regroupées (accents, articles, pluriels, une faute)', () => {
  const groups = groupAnswers([
    ['a', 'Fraise'],
    ['b', 'une fraise'],
    ['c', 'FRAISES'],
    ['d', 'fraize'],
    ['e', 'Cerise'],
    ['f', 'Tomate'],
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].members.length, 4);
  assert.equal(groups[0].label.toLowerCase().includes('fraise'), true);
  // 1 pt par joueur qui a la même réponse, +2 pour le groupe le plus populaire
  const gains = gainsFor(groups);
  assert.equal(gains.a, 3 + 2);
  assert.equal(gains.e, undefined);
  // Égalité en tête : les deux groupes ont le bonus ; personne en double : pas de bonus
  assert.deepEqual(gainsFor(groupAnswers([['a', 'Bleu'], ['b', 'bleu'], ['c', 'Rouge'], ['d', 'rouge']])), { a: 3, b: 3, c: 3, d: 3 });
  assert.deepEqual(gainsFor(groupAnswers([['a', 'Bleu'], ['b', 'Vert'], ['c', 'Rouge']])), {});
  assert.ok(getBank().size >= 150);
});

test('Tous pareils ! : réponses secrètes, révélation, fusion par l’hôte, fin', () => {
  const { lobby, players, t } = setup(5);
  try {
    const [a, b, c, d, e] = players;
    assert.equal(lobby.state, 'tp-answer');
    assert.equal(lobby.game.totalRounds, 5);
    expectError(() => lobby.tpAnswer(a, { index: 0, text: '  ' }), 'EMPTY');
    expectError(() => lobby.tpAnswer(a, { index: 1, text: 'Fraise' }), 'TOO_LATE');
    lobby.tpAnswer(a, { index: 0, text: 'Fraise' });
    lobby.tpAnswer(a, { index: 0, text: 'Pomme' }); // on peut changer d'avis
    assert.ok(!JSON.stringify(lobby.publicState(b)).includes('Pomme'), 'les réponses restent secrètes');
    assert.equal(lobby.publicState(a).game.tousPareils.myAnswer, 'Pomme');
    lobby.tpAnswer(b, { index: 0, text: 'pomme' });
    lobby.tpAnswer(c, { index: 0, text: 'Pomme rouge' });
    lobby.tpAnswer(d, { index: 0, text: 'Cerise' });
    lobby.tpAnswer(e, { index: 0, text: 'Pommes' });
    assert.equal(lobby.state, 'tp-reveal');
    let r = lobby.publicState(a).game.result;
    assert.deepEqual(r.groups.map((g) => g.members.length), [3, 1, 1]);
    assert.equal(lobby.game.totals[a], 2 + 2);
    assert.equal(lobby.game.totals[c] ?? 0, 0);

    // L'hôte juge que « Pomme rouge » = « Pomme »
    const solo = r.groups.find((g) => g.label === 'Pomme rouge');
    const big = r.groups[0];
    expectError(() => lobby.tpMerge(b, { from: solo.id, into: big.id }), 'NOT_HOST');
    lobby.tpMerge(lobby.hostId, { from: solo.id, into: big.id });
    r = lobby.publicState(a).game.result;
    assert.deepEqual(r.groups.map((g) => g.members.length), [4, 1]);
    assert.equal(lobby.game.totals[a], 3 + 2, 'points recalculés, pas cumulés');
    assert.equal(lobby.game.totals[c], 5);
    assert.equal(lobby.game.history.length, 1);
    expectError(() => lobby.tpMerge(lobby.hostId, { from: big.id, into: big.id }), 'INVALID_MERGE');

    // Le chrono, l'hôte, puis la fin
    lobby.nextQuestion(lobby.hostId);
    assert.equal(lobby.state, 'tp-answer');
    lobby.tpAnswer(a, { index: 1, text: 'Bleu' });
    mock.timers.tick(21_500);
    assert.equal(lobby.state, 'tp-reveal');
    for (let i = 2; i < 5; i += 1) {
      lobby.nextQuestion(lobby.hostId);
      lobby.forceReveal(lobby.hostId);
    }
    lobby.nextQuestion(lobby.hostId);
    assert.equal(lobby.state, 'finished');
    assert.equal(lobby.publicState(a).game.final.recap.length, 5);

    lobby.backToLobby(lobby.hostId);
    expectError(() => lobby.setSettings(lobby.hostId, { tpRounds: 7 }), 'INVALID_SETTINGS');
    lobby.setSettings(lobby.hostId, { tpRounds: 10, tpTimer: 45 });
    assert.deepEqual(lobby.settings.tousPareils, { rounds: 10, timer: 45 });
    void t;
  } finally {
    mock.timers.reset();
  }
});

test('Tous pareils ! : un joueur qui part ne bloque pas la manche', () => {
  const { lobby, players } = setup(3);
  try {
    const [a, b, c] = players;
    lobby.tpAnswer(a, { index: 0, text: 'Rouge' });
    lobby.tpAnswer(b, { index: 0, text: 'Rouge' });
    lobby.removePlayer(c);
    assert.equal(lobby.state, 'tp-reveal');
  } finally {
    mock.timers.reset();
  }
});
