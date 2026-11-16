import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createGeoBank, distanceKm, distanceTo, getBank, pointsFor } from '../src/geopin/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const PARIS = { key: 'monde:Paris', cat: 'monde', name: 'Paris', hint: 'France', lat: 48.86, lon: 2.35, view: 'monde' };
const SAINTE = { key: 'france:Saint-Étienne', cat: 'france', name: 'Saint-Étienne', hint: 'Loire', lat: 45.44, lon: 4.39, view: 'france' };

function setup(n = 3, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.geoBank = createGeoBank([PARIS, SAINTE]);
  const players = ['Ana', 'Bob', 'Cléo'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'geo-pin');
  lobby.setSettings(players[0].id, { rounds: 2, gpTimer: 20, gpCategories: ['monde', 'france'], ...settings });
  lobby.startGame(players[0].id);
  lobby.game.geoPin.questions = [PARIS, SAINTE]; // ordre fixe pour les tests
  return { lobby, players };
}

test('Géo Pin : distances et barème', () => {
  assert.ok(Math.abs(distanceKm({ lat: 48.86, lon: 2.35 }, { lat: 45.76, lon: 4.84 }) - 392) < 5, 'Paris-Lyon ≈ 392 km');
  assert.ok(Math.abs(distanceKm({ lat: 48.86, lon: 2.35 }, { lat: 40.71, lon: -74.01 }) - 5837) < 30, 'Paris-New York ≈ 5 837 km');
  assert.equal(pointsFor(0, 'monde'), 1000);
  assert.ok(pointsFor(500, 'monde') > pointsFor(2000, 'monde'));
  assert.ok(pointsFor(150, 'france') < pointsFor(150, 'monde'), 'la France est notée plus serré');
});

test('Géo Pin : la banque fournie est valide', () => {
  const bank = getBank();
  assert.ok(bank.size >= 200);
  const counts = bank.counts();
  for (const id of ['monde', 'pays', 'monuments', 'europe', 'asie', 'amerique', 'afrique', 'france']) assert.ok(counts[id] >= 30, id);
  // Les lieux « france » sont bien en France métropolitaine (Corse comprise).
  for (const q of bank.pick({ categories: ['france'], count: 500 })) {
    assert.ok(q.lat > 41 && q.lat < 51.5 && q.lon > -5.5 && q.lon < 10, q.name);
  }
});

test('Géo Pin : partie complète, points selon la distance', () => {
  const { lobby, players } = setup(3);
  const [ana, bob, cleo] = players;
  const view = (p) => lobby.publicState(p.id).game.geoPin;
  try {
    assert.equal(lobby.state, 'gp-guess');
    const sent = JSON.stringify(lobby.publicState(ana.id));
    assert.ok(!sent.includes('48.86'), 'la position ne part jamais avant la révélation');
    assert.equal(view(ana).question.hint, 'France');
    expectError(() => lobby.gpGuess(ana.id, { index: 0, lat: 'x', lon: 2 }), 'INVALID_GUESS');
    expectError(() => lobby.gpGuess(ana.id, { index: 0, lat: 95, lon: 2 }), 'INVALID_GUESS');
    expectError(() => lobby.gpGuess(ana.id, { index: 1, lat: 48, lon: 2 }), 'TOO_LATE');
    lobby.gpGuess(ana.id, { index: 0, lat: 48.86, lon: 2.35 }); // pile dessus
    expectError(() => lobby.gpGuess(ana.id, { index: 0, lat: 0, lon: 0 }), 'ALREADY_DONE');
    assert.deepEqual(view(ana).myGuess, { lat: 48.86, lon: 2.35 });
    assert.equal(view(bob).myGuess, null);
    lobby.gpGuess(bob.id, { index: 0, lat: 45.76, lon: 4.84 }); // Lyon
    lobby.gpGuess(cleo.id, { index: 0, lat: 40.71, lon: -74.01 }); // New York
    assert.equal(lobby.state, 'gp-reveal');
    const r = lobby.publicState(bob.id).game.result;
    assert.equal(r.place.lat, 48.86);
    assert.deepEqual(r.entries.map((e) => e.playerId), [ana.id, bob.id, cleo.id]);
    assert.equal(r.entries[0].points, 1000);
    assert.ok(r.entries[1].points > 700 && r.entries[1].points < 900);
    assert.ok(r.entries[2].points < 100);

    lobby.nextQuestion(ana.id);
    assert.equal(lobby.state, 'gp-guess');
    assert.equal(view(ana).question.view, 'france');
    lobby.gpGuess(bob.id, { index: 1, lat: 45.76, lon: 4.84 }); // Lyon : ~50 km de Sainté
    lobby.forceReveal(ana.id); // l'hôte n'attend pas
    assert.equal(lobby.state, 'gp-reveal');
    const r2 = lobby.game.result;
    assert.equal(r2.entries[0].playerId, bob.id);
    assert.ok(r2.entries[0].km > 40 && r2.entries[0].km < 60);
    assert.equal(r2.entries.find((e) => e.playerId === cleo.id).km, null);
    lobby.nextQuestion(ana.id);
    assert.equal(lobby.state, 'finished');
    assert.equal(lobby.game.final.ranking[0].playerId, bob.id);
    assert.equal(lobby.game.final.geoPin.best.km, 0);
    assert.equal(lobby.game.final.recap.length, 2);
  } finally {
    lobby.dispose();
    mock.timers.reset();
  }
});

test('Géo Pin : le chrono révèle tout seul, réglages vérifiés', () => {
  const { lobby, players } = setup(2, { gpHint: false });
  try {
    let changes = 0;
    lobby.onChange = () => (changes += 1);
    assert.equal(lobby.publicState(players[0].id).game.geoPin.question.hint, '');
    mock.timers.tick(21_500);
    assert.equal(lobby.state, 'gp-reveal');
    assert.equal(changes, 1);
    assert.ok(lobby.game.result.entries.every((e) => e.points === 0));
    lobby.backToLobby?.(players[0].id);
    expectError(() => lobby.setSettings(players[0].id, { gpTimer: 7 }), 'INVALID_SETTINGS');
    expectError(() => lobby.setSettings(players[0].id, { gpCategories: [] }), 'INVALID_SETTINGS');
  } finally {
    lobby.dispose();
    mock.timers.reset();
  }
});

test('Géo Pin : mode Pays (dans le pays = 0 km) et régions notées plus serré', () => {
  const bank = getBank();
  const pays = bank.pick({ categories: ['pays'], count: 500 });
  const find = (name) => pays.find((p) => p.name === name);
  const france = find('France');
  assert.equal(distanceTo({ lat: 45.44, lon: 4.39 }, france), 0, 'Saint-Étienne est en France');
  const fromMadrid = distanceTo({ lat: 40.42, lon: -3.7 }, france);
  assert.ok(fromMadrid > 250 && fromMadrid < 450, `Madrid → frontière française : ${Math.round(fromMadrid)} km`);
  assert.equal(distanceTo({ lat: -15.8, lon: -47.9 }, find('Brésil')), 0);
  assert.equal(distanceTo({ lat: 61, lon: 100 }, find('Russie')), 0);
  assert.ok(Math.abs(france.lat - 46.5) < 3 && Math.abs(france.lon - 2.5) < 4, 'repère au centre de la métropole');
  assert.ok(pointsFor(500, 'europe') < pointsFor(500, 'asie') && pointsFor(500, 'asie') < pointsFor(500, 'monde'));
  // Une ville « bonus » de région ne sort pas dans Villes du monde.
  const monde = bank.pick({ categories: ['monde'], count: 500 }).map((p) => p.name);
  assert.ok(monde.includes('Tokyo') && !monde.includes('Bamako'));
  assert.ok(bank.pick({ categories: ['afrique'], count: 500 }).some((p) => p.name === 'Bamako'));
});
