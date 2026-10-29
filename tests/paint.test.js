import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/game/Lobby.js';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createPaintWords, judgeGuess, loadPaintWords, maskWord } from '../src/paint/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const words = () => createPaintWords({ facile: ['chat'], moyen: ['hérisson'], difficile: ['arc-en-ciel'] });

function setup(names = ['Alice', 'Bob', 'Chloé'], settings = { paintTurns: 2, paintTimer: 60 }) {
  const lobby = new Lobby('ABCDE', { questionBank: createQuestionBank(['Q ?']), paintWords: words() });
  const players = names.map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'paint');
  lobby.setSettings(players[0].id, settings);
  return { lobby, players };
}
const drawerOf = (lobby, players) => players.find((p) => p.id === lobby.game.manche.drawerId);
const others = (lobby, players) => players.filter((p) => p.id !== lobby.game.manche.drawerId);

test('Paint : juste, proche, faux (accents et majuscules ignorés)', () => {
  assert.equal(judgeGuess('Hérisson', 'hérisson'), 'correct');
  assert.equal(judgeGuess('herisson', 'hérisson'), 'correct');
  assert.equal(judgeGuess('hèrisson', 'hérisson'), 'correct', 'mauvais accent = juste');
  assert.equal(judgeGuess('un chat', 'chat'), 'correct');
  assert.equal(judgeGuess('arc en ciel', 'arc-en-ciel'), 'correct');
  assert.equal(judgeGuess('Maxima', 'Maxime'), 'close', 'une lettre de travers = proche');
  assert.equal(judgeGuess('herison', 'hérisson'), 'close');
  assert.equal(judgeGuess('chien', 'chat'), 'wrong');
  assert.equal(judgeGuess('   ', 'chat'), 'empty');
});

test('Paint : masque du mot (petites barres) et liste de mots', () => {
  assert.deepEqual(maskWord('arc-en-ciel'), ['_', '_', '_', '-', '_', '_', '-', '_', '_', '_', '_']);
  assert.deepEqual(maskWord('feu rouge', [0]), ['f', '_', '_', ' ', '_', '_', '_', '_', '_']);
  const bank = loadPaintWords(new URL('../data/paint.json', import.meta.url));
  const counts = bank.counts();
  for (const level of ['facile', 'moyen', 'difficile']) assert.ok(counts[level] >= 80, `${level} trop court`);
});

test('Paint : nombre de manches = joueurs × tours, chacun dessine autant de fois', () => {
  const { lobby, players } = setup();
  expectError(() => lobby.setSettings(players[0].id, { paintTimer: 30 }), 'INVALID_SETTINGS');
  assert.equal(lobby.publicState(players[0].id).limits.paint.players, 3);
  lobby.startGame(players[0].id);
  assert.equal(lobby.game.totalRounds, 6);
  const count = Object.fromEntries(players.map((p) => [p.id, lobby.game.order.filter((id) => id === p.id).length]));
  assert.deepEqual(Object.values(count), [2, 2, 2]);
  lobby.backToLobby(players[0].id);
});

test('Paint : choix du mot, le mot reste caché aux autres, devinettes et chat', () => {
  const { lobby, players } = setup();
  lobby.startGame(players[0].id);
  const drawer = drawerOf(lobby, players);
  const [g1, g2] = others(lobby, players);
  assert.equal(lobby.state, 'paint-choose');
  assert.deepEqual(lobby.publicState(drawer.id).game.paint.choices, { facile: 'chat', moyen: 'hérisson', difficile: 'arc-en-ciel' });
  assert.equal(lobby.publicState(g1.id).game.paint.choices, null);
  expectError(() => lobby.paintChoose(g1.id, 'facile'), 'NOT_DRAWER');
  lobby.paintChoose(drawer.id, 'moyen');
  assert.equal(lobby.state, 'paint-draw');

  const seen = lobby.publicState(g1.id);
  assert.equal(JSON.stringify(seen).includes('risson'), false, 'le mot ne doit pas fuiter');
  assert.equal(seen.game.paint.mask.length, 8);
  assert.equal(lobby.publicState(drawer.id).game.paint.word, 'hérisson');

  expectError(() => lobby.paintGuess(drawer.id, 'c’est un hérisson'), 'NO_SPOILER');
  assert.equal(lobby.paintGuess(g1.id, 'porc-épic'), 'wrong');
  assert.equal(lobby.paintGuess(g1.id, 'herison'), 'close');
  let paint = lobby.publicState(g2.id).game.paint;
  assert.equal(paint.statuses[g1.id], 'close');
  const close = paint.chat.find((c) => c.kind === 'close');
  assert.equal(close.text, null, 'les autres ne voient pas le mot presque juste');
  assert.equal(lobby.publicState(g1.id).game.paint.chat.find((c) => c.kind === 'close').text, 'herison');
  assert.equal(lobby.publicState(drawer.id).game.paint.chat.find((c) => c.kind === 'close').text, 'herison');
  assert.equal(paint.chat.find((c) => c.kind === 'guess').text, 'porc-épic');

  assert.equal(lobby.paintGuess(g1.id, 'Hérisson'), 'correct');
  paint = lobby.publicState(g2.id).game.paint;
  assert.equal(paint.statuses[g1.id], 'found');
  assert.equal(JSON.stringify(paint).includes('risson'), false, 'trouvé ≠ mot affiché aux autres');
  assert.equal(lobby.publicState(g1.id).game.paint.word, 'hérisson');
  // Ceux qui ont trouvé discutent sans être vus des autres.
  lobby.paintGuess(g1.id, 'trop facile');
  assert.equal(lobby.publicState(g2.id).game.paint.chat.some((c) => c.text === 'trop facile'), false);
  assert.equal(lobby.publicState(drawer.id).game.paint.chat.some((c) => c.text === 'trop facile'), true);

  lobby.paintGuess(g2.id, 'herisson');
  assert.equal(lobby.state, 'paint-end');
  const { result } = lobby.publicState(g2.id).game.paint;
  assert.equal(result.word, 'hérisson');
  assert.equal(result.points[g1.id], 6, '1er : 3 × difficulté moyenne (2)');
  assert.equal(result.points[g2.id], 4, '2e : 2 × 2');
  assert.equal(result.points[drawer.id], 4, 'dessinateur : 2 par joueur qui trouve');
  lobby.backToLobby(players[0].id);
});

test('Paint : dessin en direct, annuler, garde-fous', () => {
  const { lobby, players } = setup();
  lobby.startGame(players[0].id);
  const drawer = drawerOf(lobby, players);
  const [g1] = others(lobby, players);
  lobby.paintChoose(drawer.id, 'facile');
  expectError(() => lobby.paintDraw(g1.id, { t: 'c' }), 'NOT_DRAWER');
  expectError(() => lobby.paintDraw(drawer.id, { t: 's', id: 'a', tool: 'laser', color: '#000000', size: 5, pts: [1, 2] }), 'INVALID_DRAW');
  lobby.paintDraw(drawer.id, { t: 's', id: 'a', tool: 'pen', color: '#FF0000', size: 999, pts: [10, 10, 20, 20] });
  lobby.paintDraw(drawer.id, { t: 's', id: 'a', tool: 'pen', color: '#ff0000', size: 8, pts: [30, 30] });
  const { op } = lobby.paintDraw(drawer.id, { t: 'f', x: 5000, y: 3, color: '#00ff00' });
  assert.equal(op.x, 799);
  assert.equal(lobby.paintSync().ops.length, 3);
  assert.equal(lobby.paintSync().ops[0].size, 80);
  let { reset } = lobby.paintDraw(drawer.id, { t: 'u' });
  assert.equal(reset.length, 2, 'annuler retire le remplissage');
  ({ reset } = lobby.paintDraw(drawer.id, { t: 'u' }));
  assert.equal(reset.length, 0, 'annuler retire le trait entier (2 morceaux)');
  lobby.backToLobby(players[0].id);
});

test('Paint : chrono, indices, choix automatique et enchaînement des manches', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']), paintWords: words() });
    let changes = 0;
    manager.onLobbyChange = () => {
      changes += 1;
    };
    const lobby = manager.create();
    const a = lobby.addPlayer('Alice', 's1');
    lobby.addPlayer('Bob', 's2');
    lobby.setMode(a.id, 'paint');
    lobby.setSettings(a.id, { paintTurns: 1, paintTimer: 60 });
    lobby.startGame(a.id);
    assert.equal(lobby.game.totalRounds, 2);
    mock.timers.tick(16_000); // personne ne choisit : mot tiré au hasard
    assert.equal(lobby.state, 'paint-draw');
    const guesser = lobby.playerIds.find((id) => id !== lobby.game.manche.drawerId);
    const word = lobby.game.manche.word;
    const masked = () => lobby.publicState(guesser).game.paint.mask.filter((c) => c !== '_' && /\p{L}/u.test(c)).length;
    assert.equal(masked(), 0);
    mock.timers.tick(45_000);
    if (word.replace(/[^\p{L}]/gu, '').length >= 6) assert.ok(masked() >= 1, 'au moins un indice après 75 %');
    mock.timers.tick(16_000);
    assert.equal(lobby.state, 'paint-end');
    mock.timers.tick(7_000);
    assert.equal(lobby.state, 'paint-choose');
    assert.equal(lobby.game.manche.drawerId, guesser, 'l’autre joueur dessine à son tour');
    lobby.paintChoose(guesser, 'facile');
    mock.timers.tick(61_000);
    mock.timers.tick(7_000);
    assert.equal(lobby.state, 'finished');
    assert.ok(changes >= 4);
  } finally {
    mock.timers.reset();
  }
});

test('Paint : le dessinateur qui part termine la manche, l’hôte peut passer', () => {
  const { lobby, players } = setup();
  lobby.startGame(players[0].id);
  const drawer = drawerOf(lobby, players);
  lobby.paintChoose(drawer.id, 'difficile');
  lobby.markDisconnected(drawer.id, `s${players.indexOf(drawer)}`);
  assert.equal(lobby.state, 'paint-end');
  assert.equal(lobby.game.manche.result.reason, 'drawer-left');
  const host = lobby.players.get(lobby.hostId);
  lobby.nextQuestion(host.id);
  assert.equal(lobby.state, 'paint-choose');
  lobby.forceReveal(host.id);
  assert.equal(lobby.state, 'paint-end');
  lobby.backToLobby(host.id);
});
