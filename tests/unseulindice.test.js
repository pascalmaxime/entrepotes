import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createWordBank } from '../src/nomdecode/engine.js';
import { isFound } from '../src/unseulindice/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);

function setup(n = 5, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.ujBank = createWordBank(Array.from({ length: 30 }, (_, i) => (i === 0 ? 'cheval' : `motzz${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`)));
  const players = ['Ana', 'Bob', 'Cléo', 'Dan', 'Eva'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'un-seul-indice');
  lobby.setSettings(players[0].id, { ujTurns: 1, ujClue: 30, ujGuess: 30, ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players: players.map((p) => p.id), u: lobby.game.uj };
}
const view = (lobby, id) => lobby.publicState(id).game.unSeulIndice;

test('Un seul indice : l’essai du devineur pardonne articles, accents, pluriel et une faute', () => {
  assert.equal(isFound('les éléphans', 'Éléphant'), true);
  assert.equal(isFound('Chevaux', 'cheval'), true);
  assert.equal(isFound('pommier', 'pomme'), false);
  assert.equal(isFound('chat', 'château'), false);
});

test('Un seul indice : mot caché au devineur, doublons annulés, essai réussi, points', () => {
  const { lobby, players, u } = setup(5);
  try {
    u.word = 'cheval';
    const g = u.guesser;
    const [a, b, c, d] = players.filter((id) => id !== g);
    assert.equal(lobby.state, 'uj-clue');
    assert.equal(lobby.game.totalRounds, 5);
    assert.equal(view(lobby, g).word, null, 'le devineur ne voit pas le mot');
    assert.equal(view(lobby, a).word, 'cheval');
    expectError(() => lobby.ujClue(g, { index: 0, text: 'Selle' }), 'GUESSER');
    expectError(() => lobby.ujClue(a, { index: 0, text: 'deux mots' }), 'ONE_WORD');
    expectError(() => lobby.ujClue(a, { index: 0, text: 'Chevaux' }), 'TOO_CLOSE');
    lobby.ujClue(a, { index: 0, text: 'Selle' });
    lobby.ujClue(b, { index: 0, text: 'selles' }); // doublon de « Selle »
    lobby.ujClue(c, { index: 0, text: 'Galop' });
    assert.ok(!JSON.stringify(lobby.publicState(g)).includes('Galop'), 'le devineur ne voit rien avant la vérification');
    lobby.ujClue(d, { index: 0, text: 'Écurie' });
    assert.equal(lobby.state, 'uj-check');
    let clues = view(lobby, a).clues;
    assert.deepEqual(clues.filter((x) => x.cancelled).map((x) => x.playerId).sort(), [a, b].sort());
    assert.deepEqual(view(lobby, g).clues, [], 'le devineur ne voit pas la vérification');
    // On barre aussi « Écurie » à la main, puis on le rétablit
    expectError(() => lobby.ujToggle(g, { author: d }), 'GUESSER');
    lobby.ujToggle(c, { author: d });
    assert.ok(u.cancelled.has(d));
    lobby.ujToggle(c, { author: d });
    lobby.ujConfirm(d);
    assert.equal(lobby.state, 'uj-guess');
    clues = view(lobby, g).clues;
    assert.deepEqual(clues.map((x) => x.text).sort(), ['Galop', 'Écurie'].sort(), 'le devineur ne voit que les indices gardés');
    expectError(() => lobby.ujGuess(a, { index: 0, text: 'cheval' }), 'NOT_GUESSER');
    lobby.ujGuess(g, { index: 0, text: 'Un cheval' });
    assert.equal(lobby.state, 'uj-reveal');
    const r = lobby.publicState(g).game.result;
    assert.equal(r.found, true);
    assert.deepEqual(r.gains, { [g]: 3, [c]: 1, [d]: 1 });
    assert.deepEqual(r.team, { found: 1, played: 1 });
  } finally {
    mock.timers.reset();
  }
});

test('Un seul indice : raté, l’hôte accepte quand même, passe, chronos, fin', () => {
  const { lobby, players, u } = setup(3);
  try {
    // Manche 1 : raté, puis l'hôte accepte
    let g = u.guesser;
    let writers = players.filter((id) => id !== g);
    for (const id of writers) lobby.ujClue(id, { index: 0, text: id === writers[0] ? 'Indice' : 'Autre' });
    lobby.ujConfirm(writers[0]);
    lobby.ujGuess(g, { index: 0, text: 'synonyme' });
    assert.equal(lobby.game.result.found, false);
    const host = lobby.hostId;
    const notHost = players.find((id) => id !== host);
    expectError(() => lobby.ujAccept(notHost), 'NOT_HOST');
    lobby.ujAccept(host);
    assert.equal(lobby.game.result.found, true);
    assert.equal(lobby.game.result.team.found, 1);
    assert.equal(lobby.game.totals[g], 3);
    assert.equal(lobby.game.history.length, 1);
    expectError(() => lobby.ujAccept(host), 'INVALID');

    // Manche 2 : chrono des indices → vérification ; l'hôte passe → essai ; le devineur passe
    lobby.nextQuestion(host);
    g = u.guesser;
    writers = players.filter((id) => id !== g);
    lobby.ujClue(writers[0], { index: 1, text: 'Seul' });
    mock.timers.tick(31_500);
    assert.equal(lobby.state, 'uj-check');
    lobby.forceReveal(host);
    assert.equal(lobby.state, 'uj-guess');
    lobby.ujGuess(g, { index: 1, pass: true });
    assert.equal(lobby.game.result.found, false);

    // Manche 3 : chrono de l'essai écoulé, puis fin
    lobby.nextQuestion(host);
    lobby.forceReveal(host);
    lobby.forceReveal(host);
    mock.timers.tick(31_500);
    assert.equal(lobby.state, 'uj-reveal');
    lobby.nextQuestion(host);
    assert.equal(lobby.state, 'finished');
    const final = lobby.publicState(host).game.final;
    assert.deepEqual(final.uj, { found: 1, played: 3 });

    lobby.backToLobby(host);
    expectError(() => lobby.setSettings(host, { ujTurns: 4 }), 'INVALID_SETTINGS');
    lobby.setSettings(host, { ujTurns: 3, ujGuess: 60 });
    assert.deepEqual(lobby.settings.unSeulIndice, { turns: 3, clue: 30, guess: 60 });
  } finally {
    mock.timers.reset();
  }
});

test('Un seul indice : le devineur part → manche suivante', () => {
  const { lobby, u } = setup(4);
  try {
    const g = u.guesser;
    lobby.markDisconnected(g, lobby.players.get(g).socketId);
    assert.equal(lobby.state, 'uj-clue');
    assert.equal(u.index, 1);
    assert.notEqual(u.guesser, g);
  } finally {
    mock.timers.reset();
  }
});
