import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/game/Lobby.js';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { JP_CATEGORY_IDS, createJustePrixBank, loadJustePrixBank, parseNumber } from '../src/justeprix/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);

test('Juste Prix : lecture des nombres avec virgules, espaces et unités', () => {
  assert.equal(parseNumber('1 234,5'), 1234.5);
  assert.equal(parseNumber('1.234,5'), 1234.5);
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('0,05'), 0.05);
  assert.equal(parseNumber('42.195'), 42.195);
  assert.equal(parseNumber('1 000 000'), 1000000);
  assert.equal(parseNumber('12k'), 12000);
  assert.equal(parseNumber('3 millions'), 3000000);
  assert.equal(parseNumber('2,5 milliards'), 2500000000);
  assert.equal(parseNumber('99 €'), 99);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber(''), null);
});

test('Juste Prix : le fichier de questions se charge et chaque catégorie est remplie', () => {
  const bank = loadJustePrixBank(new URL('../data/justeprix.json', import.meta.url));
  const counts = bank.counts();
  for (const id of JP_CATEGORY_IDS) assert.ok(counts[id] >= 15, `catégorie ${id} trop petite`);
  const picked = bank.pick({ categories: ['classements'], count: 3 });
  for (const q of picked) {
    assert.equal(q.kind, 'ranking');
    assert.deepEqual([...q.shuffled].sort(), q.items.map((i) => i.label).sort());
  }
});

const bank = () =>
  createJustePrixBank([
    { key: 'a', cat: 'distances', kind: 'estimate', prompt: 'Hauteur de la tour Eiffel ?', answer: 330, unit: 'm', info: null },
    { key: 'b', cat: 'temps', kind: 'estimate', prompt: 'Prise de la Bastille ?', answer: 1789, unit: 'année', info: null },
    {
      key: 'c',
      cat: 'classements',
      kind: 'ranking',
      theme: 'Monuments',
      prompt: 'Du plus haut au moins haut',
      unit: 'm',
      items: [
        { label: 'Burj Khalifa', value: 828 },
        { label: 'Tour Eiffel', value: 330 },
        { label: 'Arc de Triomphe', value: 50 },
      ],
    },
  ]);

function setup(names = ['Alice', 'Bob', 'Chloé']) {
  const lobby = new Lobby('ABCDE', { questionBank: createQuestionBank(['Q ?']), justePrixBank: bank() });
  const players = names.map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'juste-prix');
  lobby.setSettings(players[0].id, { rounds: 3, jpTimer: 0 });
  return { lobby, players };
}

const play = (lobby, players, answers) => players.forEach((p, i) => answers[i] !== undefined && lobby.justePrixAnswer(p.id, { index: lobby.game.index, value: answers[i] }));

test('Juste Prix : réglages des catégories et du chrono', () => {
  const { lobby, players } = setup();
  expectError(() => lobby.setSettings(players[1].id, { jpTimer: 15 }), 'NOT_HOST');
  expectError(() => lobby.setSettings(players[0].id, { jpCategories: [] }), 'INVALID_SETTINGS');
  lobby.setSettings(players[0].id, { jpCategories: ['poids', 'classements', 'bidon'], jpTimer: 45 });
  assert.deepEqual(lobby.settings.justePrix, { categories: ['poids', 'classements'], timer: 45 });
  assert.equal(lobby.publicState(players[0].id).limits.justePrix.categories.length, JP_CATEGORY_IDS.length);
});

test('Juste Prix : estimation — le plus proche gagne, bonus si pile, réponse cachée avant la révélation', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.startGame(a.id);
  while (lobby.game.questions[lobby.game.index].key !== 'a') {
    lobby.forceReveal(a.id);
    lobby.nextQuestion(a.id);
  }
  const before = lobby.publicState(b.id);
  assert.equal(before.state, 'jp-question');
  assert.equal(JSON.stringify(before).includes('330'), false, 'la réponse ne doit pas fuiter');

  expectError(() => lobby.justePrixAnswer(a.id, { index: lobby.game.index, value: 'beaucoup' }), 'INVALID_ANSWER');
  play(lobby, players, ['331', '300,5', undefined]);
  assert.equal(lobby.state, 'jp-question');
  assert.deepEqual(lobby.publicState(a.id).you, { answered: true, answer: 331 });
  lobby.justePrixAnswer(c.id, { index: lobby.game.index, value: '1 000' });
  assert.equal(lobby.state, 'jp-reveal');

  const { result } = lobby.publicState(c.id).game;
  assert.equal(result.answer, 330);
  const byId = Object.fromEntries(result.entries.map((e) => [e.playerId, e]));
  assert.equal(byId[a.id].rank, 1);
  assert.equal(byId[a.id].exact, true, 'à moins de 1 % : pile !');
  assert.equal(byId[a.id].points, 5);
  assert.equal(byId[b.id].points, 2);
  assert.equal(byId[c.id].points, 1);
  assert.equal(byId[c.id].percent, 203);
});

test('Juste Prix : une date doit être exacte pour le bonus', () => {
  const { lobby, players } = setup();
  const [a] = players;
  lobby.startGame(a.id);
  while (lobby.game.questions[lobby.game.index].key !== 'b') {
    lobby.forceReveal(a.id);
    lobby.nextQuestion(a.id);
  }
  play(lobby, players, ['1790', '1789', '1500']);
  const byId = Object.fromEntries(lobby.game.result.entries.map((e) => [e.playerId, e]));
  assert.equal(byId[players[0].id].exact, false);
  assert.equal(byId[players[1].id].exact, true);
  assert.equal(byId[players[1].id].points, 5);
});

test('Juste Prix : classement — 1 point par bonne place, bonus si tout est juste', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.startGame(a.id);
  while (lobby.game.questions[lobby.game.index].key !== 'c') {
    lobby.forceReveal(a.id);
    lobby.nextQuestion(a.id);
  }
  const { choices } = lobby.publicState(a.id).game.justePrix.question;
  assert.equal(choices.length, 3);
  expectError(() => lobby.justePrixAnswer(a.id, { index: lobby.game.index, value: ['Tour Eiffel'] }), 'INVALID_ANSWER');
  play(lobby, players, [
    ['Burj Khalifa', 'Tour Eiffel', 'Arc de Triomphe'],
    ['Burj Khalifa', 'Arc de Triomphe', 'Tour Eiffel'],
    ['Arc de Triomphe', 'Tour Eiffel', 'Burj Khalifa'],
  ]);
  const byId = Object.fromEntries(lobby.game.result.entries.map((e) => [e.playerId, e]));
  assert.equal(byId[a.id].points, 5);
  assert.equal(byId[b.id].points, 1);
  assert.equal(byId[c.id].points, 1);
  assert.deepEqual(byId[b.id].marks, [true, false, false]);
});

test('Juste Prix : partie complète jusqu’au classement final', () => {
  const { lobby, players } = setup();
  const [a] = players;
  lobby.startGame(a.id);
  for (let i = 0; i < 3; i += 1) {
    const q = lobby.game.questions[lobby.game.index];
    const value = q.kind === 'ranking' ? q.items.map((x) => x.label) : String(q.answer);
    lobby.justePrixAnswer(a.id, { index: i, value });
    lobby.forceReveal(a.id);
    lobby.nextQuestion(a.id);
  }
  assert.equal(lobby.state, 'finished');
  assert.equal(lobby.game.final.ranking[0].playerId, a.id);
  assert.equal(lobby.game.final.ranking[0].total, 15);
  assert.equal(lobby.game.final.recap.length, 3);
});

test('Juste Prix : la fin du chrono révèle la réponse', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']), justePrixBank: bank() });
    let changes = 0;
    manager.onLobbyChange = () => {
      changes += 1;
    };
    const lobby = manager.create();
    const a = lobby.addPlayer('Alice', 's1');
    lobby.addPlayer('Bob', 's2');
    lobby.setMode(a.id, 'juste-prix');
    lobby.setSettings(a.id, { jpTimer: 15 });
    lobby.startGame(a.id);
    mock.timers.tick(15_000);
    assert.equal(lobby.state, 'jp-question');
    mock.timers.tick(1000);
    assert.equal(lobby.state, 'jp-reveal');
    assert.equal(changes, 1);
  } finally {
    mock.timers.reset();
  }
});

test('Juste Prix : un joueur déconnecté ne bloque pas la question', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.startGame(a.id);
  lobby.markDisconnected(c.id, 's2');
  const q = lobby.game.questions[0];
  const value = q.kind === 'ranking' ? q.items.map((x) => x.label) : '10';
  lobby.justePrixAnswer(a.id, { index: 0, value });
  lobby.justePrixAnswer(b.id, { index: 0, value });
  assert.equal(lobby.state, 'jp-reveal');
});
