import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { checkWord, letters, loadDictionary } from '../src/tictacboum/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const dict = loadDictionary();

test('Tic Tac Boum : dictionnaire, accents ignorés, mots en plus, positions', () => {
  assert.ok(dict.words.size > 300_000);
  assert.equal(letters('Saint-Étienne'), 'saintetienne');
  const ass = { text: 'ass', position: 'debut' };
  assert.equal(checkWord(dict, 'Assiette', ass).ok, true);
  assert.equal(checkWord(dict, 'ASSE', ass).ok, true);
  assert.equal(checkWord(dict, 'Assxyz', ass).reason, 'pas dans le dictionnaire');
  assert.equal(checkWord(dict, 'casse', ass).reason, 'ne commence pas par ASS');
  assert.equal(checkWord(dict, 'casse', { text: 'ass', position: 'milieu' }).ok, true);
  assert.equal(checkWord(dict, 'tasse', { text: 'sse', position: 'fin' }).ok, true);
  assert.equal(checkWord(dict, 'ÉLÉPHANT', { text: 'ele', position: 'debut' }).ok, true, 'accents ignorés');
  assert.equal(checkWord(dict, 'saint-étienne', { text: 'eti', position: 'milieu' }).ok, true, 'mot en plus');
  assert.equal(checkWord(dict, 'assiette', ass, new Set(['assiette'])).reason, 'déjà utilisé');
  // Chaque niveau propose des syllabes, et elles existent vraiment dans le dictionnaire.
  for (const p of ['debut', 'milieu', 'fin']) {
    for (const l of ['facile', 'moyen', 'difficile']) assert.ok(dict.syllables[p][l].length > 20, `${p}/${l}`);
  }
});

function setup(n = 3, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  let changes = 0;
  manager.onLobbyChange = () => {
    changes += 1;
  };
  const lobby = manager.create();
  const players = ['Ana', 'Bob', 'Cléo', 'Dan'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'tic-tac-boum');
  lobby.setSettings(players[0].id, { tbLives: 1, tbFuse: 'courte', ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players, tb: lobby.game.tb, changes: () => changes };
}

// Trouve un mot valide pour la syllabe en cours (pour simuler un bon joueur).
function goodWord(tb) {
  const { text, position } = tb.syllable;
  for (const w of tb.dict.words) {
    if (w === text || tb.usedWords.has(w) || w.length > 12) continue;
    if (position === 'debut' ? w.startsWith(text) : position === 'fin' ? w.endsWith(text) : w.includes(text)) return w;
  }
  return null;
}

test('Tic Tac Boum : réglages de l’hôte', () => {
  const { lobby, players } = setup();
  try {
    lobby.backToLobby(players[0].id);
    expectError(() => lobby.setSettings(players[0].id, { tbPositions: [] }), 'INVALID_SETTINGS');
    expectError(() => lobby.setSettings(players[0].id, { tbFuse: 'eternelle' }), 'INVALID_SETTINGS');
    lobby.setSettings(players[0].id, { tbLives: 9, tbPositions: ['fin', 'nimporte'], tbDifficulty: 'difficile' });
    assert.deepEqual(lobby.settings.ticTacBoum, { lives: 5, fuse: 'courte', difficulty: 'difficile', positions: ['fin'] });
  } finally {
    mock.timers.reset();
  }
});

test('Tic Tac Boum : mot juste → la bombe passe, faux → elle reste, la mèche reste secrète', () => {
  const { lobby, tb } = setup();
  try {
    assert.equal(lobby.state, 'tb-ready');
    const holder = tb.holderId;
    expectError(() => lobby.tbWord(holder, 'test'), 'NOT_NOW');
    mock.timers.tick(3_000);
    assert.equal(lobby.state, 'tb-play');
    const other = lobby.playerIds.find((id) => id !== holder);
    expectError(() => lobby.tbWord(other, 'test'), 'NOT_YOUR_TURN');
    const wrong = lobby.tbWord(holder, 'zzzz');
    assert.equal(wrong.ok, false);
    assert.equal(tb.holderId, holder, 'faux : la bombe reste');
    const word = goodWord(tb);
    assert.equal(lobby.tbWord(holder, word).ok, true);
    assert.notEqual(tb.holderId, holder, 'juste : la bombe passe');
    assert.equal(lobby.tbWord(tb.holderId, word).reason, 'déjà utilisé');
    const view = lobby.publicState(holder).game.ticTacBoum;
    assert.equal(Object.keys(view).some((k) => /fuse|explode|deadline|ends/i.test(k) && k !== 'readyEndsAt'), false, 'pas de mèche dans l’état');
    assert.equal(lobby.publicState(holder).game.ticTacBoum.feed.length, 3);
  } finally {
    mock.timers.reset();
  }
});

test('Tic Tac Boum : explosion, perte de vie, dernier survivant', () => {
  const { lobby, tb, changes } = setup(3, { tbLives: 1, tbFuse: 'courte' });
  try {
    mock.timers.tick(3_000);
    const first = tb.holderId;
    mock.timers.tick(21_000); // mèche courte : 10 à 20 s
    assert.equal(lobby.state, 'tb-boom');
    assert.equal(tb.boom.playerId, first);
    assert.equal(tb.boom.eliminated, true);
    assert.equal(tb.alive.has(first), false);
    mock.timers.tick(4_000);
    assert.equal(lobby.state, 'tb-ready');
    assert.notEqual(tb.holderId, first);
    mock.timers.tick(3_000);
    mock.timers.tick(21_000);
    assert.equal(lobby.state, 'tb-boom');
    mock.timers.tick(4_000);
    assert.equal(lobby.state, 'finished');
    const winner = [...tb.alive][0];
    assert.equal(lobby.game.final.ranking[0].playerId, winner);
    assert.equal(lobby.game.final.tb.winner, winner);
    assert.ok(changes() >= 4);
  } finally {
    mock.timers.reset();
  }
});

test('Tic Tac Boum : plusieurs vies, porteur déconnecté, hôte qui fait passer la bombe', () => {
  const { lobby, tb, players } = setup(3, { tbLives: 2 });
  try {
    mock.timers.tick(3_000);
    const first = tb.holderId;
    mock.timers.tick(21_000);
    assert.equal(tb.lives.get(first), 1);
    assert.equal(tb.alive.has(first), true);
    mock.timers.tick(4_000);
    mock.timers.tick(3_000);
    assert.equal(tb.holderId, first, 'celui qui a explosé repart avec la bombe');
    lobby.forceReveal(lobby.hostId);
    assert.notEqual(tb.holderId, first);
    const holder = tb.holderId;
    const p = players.find((x) => x.id === holder);
    lobby.markDisconnected(holder, `s${players.indexOf(p)}`);
    assert.notEqual(tb.holderId, holder);
  } finally {
    mock.timers.reset();
  }
});
