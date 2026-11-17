import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const SHEET = (name) => ({ statements: [`${name} a sauté en parachute`, `${name} parle japonais`, `${name} a un chat`], lie: 1 });

function setup(n = 4, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  const players = ['Ana', 'Bob', 'Cléo', 'Dan'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'menteur');
  lobby.setSettings(players[0].id, { mtWrite: 90, mtVote: 20, ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players: players.map((p) => p.id), names: players.map((p) => p.name), m: lobby.game.mt };
}
const view = (lobby, id) => lobby.publicState(id).game.menteur;

test('Menteur ! : écriture, mensonge secret, vote, points, fin', () => {
  const { lobby, players, names, m } = setup(4);
  try {
    assert.equal(lobby.state, 'mt-write');
    const [a] = players;
    expectError(() => lobby.mtSheet(a, { statements: ['x', '', 'z'], lie: 0 }), 'INCOMPLETE');
    expectError(() => lobby.mtSheet(a, { statements: ['Chat', 'chat !', 'Chien'], lie: 0 }), 'DUPLICATE');
    expectError(() => lobby.mtSheet(a, { statements: ['A', 'B', 'C'], lie: 3 }), 'NO_LIE');
    players.forEach((id, i) => lobby.mtSheet(id, SHEET(names[i])));
    assert.equal(lobby.state, 'mt-vote');
    assert.equal(lobby.game.totalRounds, 4);

    const subject = m.subject;
    const others = players.filter((id) => id !== subject);
    const v = view(lobby, others[0]);
    assert.equal(v.cards.length, 3);
    assert.ok(v.cards.every((c) => c.lie === undefined), 'les autres ne savent pas laquelle est fausse');
    assert.equal(view(lobby, subject).cards.filter((c) => c.lie).length, 1);
    assert.ok(!JSON.stringify(lobby.publicState(others[0])).includes('"lie":true'));

    const lieId = m.cards.find((c) => c.lie).id;
    const truthId = m.cards.find((c) => !c.lie).id;
    expectError(() => lobby.mtVote(subject, { cardId: lieId }), 'SUBJECT');
    lobby.mtVote(others[0], { cardId: lieId });
    lobby.mtVote(others[1], { cardId: truthId });
    lobby.mtVote(others[2], { cardId: truthId });
    assert.equal(lobby.state, 'mt-reveal');
    const r = lobby.publicState(subject).game.result;
    assert.deepEqual(r.gains, { [others[0]]: 2, [subject]: 2 });
    assert.equal(r.cards.find((c) => c.lie).voters[0], others[0]);

    // Les 3 autres joueurs passent sur la sellette (chrono du vote écoulé à chaque fois)
    for (let i = 1; i < 4; i += 1) {
      lobby.nextQuestion(lobby.hostId);
      assert.equal(lobby.state, 'mt-vote');
      assert.notEqual(m.subject, subject);
      mock.timers.tick(21_500);
      assert.equal(lobby.state, 'mt-reveal');
    }
    lobby.nextQuestion(lobby.hostId);
    assert.equal(lobby.state, 'finished');
    const final = lobby.publicState(a).game.final;
    assert.equal(final.recap.length, 4);
    assert.deepEqual(final.mt.bestLiar, { playerId: subject, fooled: 2 });
  } finally {
    mock.timers.reset();
  }
});

test('Menteur ! : chrono d’écriture, ceux qui n’ont pas écrit sont sautés, hôte, réglages', () => {
  const { lobby, players, names, m } = setup(4);
  try {
    lobby.mtSheet(players[0], SHEET(names[0]));
    lobby.mtSheet(players[1], SHEET(names[1]));
    mock.timers.tick(91_500);
    assert.equal(lobby.state, 'mt-vote');
    assert.equal(lobby.game.totalRounds, 2, 'seuls ceux qui ont écrit passent sur la sellette');
    assert.ok([players[0], players[1]].includes(m.subject));
    lobby.forceReveal(lobby.hostId);
    assert.equal(lobby.state, 'mt-reveal');
    lobby.nextQuestion(lobby.hostId);
    lobby.forceReveal(lobby.hostId);
    lobby.nextQuestion(lobby.hostId);
    assert.equal(lobby.state, 'finished');

    lobby.backToLobby(lobby.hostId);
    expectError(() => lobby.setSettings(lobby.hostId, { mtWrite: 100 }), 'INVALID_SETTINGS');
    lobby.setSettings(lobby.hostId, { mtWrite: 240, mtVote: 45 });
    assert.deepEqual(lobby.settings.menteur, { write: 240, vote: 45 });
  } finally {
    mock.timers.reset();
  }
});

test('Menteur ! : moins de 2 joueurs ont écrit → partie terminée ; départ pendant le vote', () => {
  const a = setup(3);
  try {
    a.lobby.mtSheet(a.players[0], SHEET('Ana'));
    a.lobby.forceReveal(a.lobby.hostId);
    assert.equal(a.lobby.state, 'finished');
  } finally {
    mock.timers.reset();
  }
  const b = setup(3);
  try {
    b.players.forEach((id, i) => b.lobby.mtSheet(id, SHEET(b.names[i])));
    const others = b.players.filter((id) => id !== b.m.subject);
    b.lobby.mtVote(others[0], { cardId: b.m.cards[0].id });
    b.lobby.removePlayer(others[1]);
    assert.equal(b.lobby.state, 'mt-reveal', 'le dernier votant est parti : révélation');
  } finally {
    mock.timers.reset();
  }
});
