import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Lobby } from '../src/game/Lobby.js';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { CATEGORY_IDS, createQuizBank, loadQuizBank } from '../src/mculture/quizBank.js';
import { isCloseEnough, normalize, suggestCorrect } from '../src/mculture/match.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const ROOT = new URL('../', import.meta.url);

// --- Pré-correction -----------------------------------------------------------

test('M-Culture : normalisation (accents, articles, ponctuation)', () => {
  assert.equal(normalize('  Le Roi Lion ! '), 'roi lion');
  assert.equal(normalize('Édith Piaf'), 'edith piaf');
  assert.equal(normalize('L’Été indien'), 'ete indien');
  assert.equal(normalize('Mettre tous ses œufs'), 'mettre tous ses oeufs');
});

test('M-Culture : tolère les petites fautes mais pas les mauvaises réponses', () => {
  assert.ok(isCloseEnough('madrid', 'Madrid'));
  assert.ok(isCloseEnough('Spiderman', 'Spider-Man'));
  assert.ok(isCloseEnough('Azerbaidjan', 'Azerbaïdjan'));
  assert.ok(isCloseEnough('Michael Jakson', 'Michael Jackson'));
  assert.ok(!isCloseEnough('Lyon', 'Paris'));
  assert.ok(!isCloseEnough('1790', '1789'), 'une date doit être exacte');
  assert.ok(!isCloseEnough('', 'Paris'));
});

test('M-Culture : suggestions avec variantes et petit bac', () => {
  assert.ok(suggestCorrect({ cat: 'drapeaux', answer: 'Royaume-Uni', alt: ['Angleterre'] }, 'angleterre'));
  assert.ok(suggestCorrect({ cat: 'petit-bac', letter: 'B' }, 'Belgique'));
  assert.ok(!suggestCorrect({ cat: 'petit-bac', letter: 'B' }, 'France'));
  assert.ok(!suggestCorrect({ cat: 'culture', answer: 'Paris' }, '   '));
});

// --- Fichiers de questions ----------------------------------------------------------

test('M-Culture : toutes les catégories se chargent et les drapeaux / pays existent', () => {
  const bank = loadQuizBank(new URL('data/mculture/', ROOT));
  const counts = bank.counts();
  for (const id of CATEGORY_IDS) assert.ok(counts[id] > 0, `catégorie ${id} vide`);

  const topo = JSON.parse(readFileSync(new URL('public/mculture/world-110m.json', ROOT), 'utf8'));
  const mapIds = new Set(topo.objects.countries.geometries.map((g) => g.id));
  for (const q of bank.data.get('carte')) assert.ok(mapIds.has(q.mapId), `pays ${q.answer} absent de la carte`);
  for (const q of bank.data.get('drapeaux')) {
    assert.ok(existsSync(new URL(`public/mculture/flags/${q.flag}.svg`, ROOT)), `drapeau ${q.flag} manquant`);
  }
  // Une bonne réponse doit toujours être reconnue par la pré-correction.
  for (const id of ['culture', 'drapeaux', 'carte', 'rebus', 'musique']) {
    for (const q of bank.data.get(id)) assert.ok(suggestCorrect(q, q.answer), `${id} : « ${q.answer} » non reconnu`);
  }
});

test('M-Culture : tirage réparti entre catégories, sans répétition', () => {
  const make = (cat, n) => Array.from({ length: n }, (_, i) => ({ key: `${cat}:${i}`, cat, prompt: `${cat} ${i}`, answer: 'x', alt: [], pts: 1 }));
  const bank = createQuizBank({ culture: make('culture', 10), drapeaux: make('drapeaux', 10), rebus: make('rebus', 2) });
  const used = new Set();
  const first = bank.pick({ categories: ['culture', 'drapeaux', 'rebus'], count: 9 }, used);
  assert.equal(first.length, 9);
  const byCat = Object.groupBy(first, (q) => q.cat);
  assert.equal(byCat.rebus.length, 2);
  assert.ok(byCat.culture.length >= 3 && byCat.drapeaux.length >= 3);
  const second = bank.pick({ categories: ['culture'], count: 5 }, used);
  assert.ok(second.every((q) => !first.some((f) => f.key === q.key)));
  assert.deepEqual(bank.pick({ categories: ['carte'], count: 5 }, used), []);
});

// --- Déroulé d'une partie -----------------------------------------------------------

const quizBank = () =>
  createQuizBank({
    culture: [
      { key: 'c1', cat: 'culture', prompt: 'Capitale de l’Espagne ?', answer: 'Madrid', alt: [], pts: 1 },
      { key: 'c2', cat: 'culture', prompt: 'Planète rouge ?', answer: 'Mars', alt: [], pts: 2 },
    ],
    drapeaux: [{ key: 'd1', cat: 'drapeaux', prompt: 'De quel pays est ce drapeau ?', flag: 'fr', answer: 'France', alt: [], pts: 3 }],
  });

function setup() {
  const lobby = new Lobby('ABCDE', { questionBank: createQuestionBank(['Q ?']), quizBank: quizBank() });
  const players = ['Alice', 'Bob', 'Chloé'].map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'm-culture');
  lobby.setSettings(players[0].id, { questions: 5, timer: 0, categories: ['culture', 'drapeaux'] });
  return { lobby, players };
}

test('M-Culture : réglages (catégories, chrono, nombre de questions)', () => {
  const { lobby, players } = setup();
  const [a, b] = players;
  expectError(() => lobby.setSettings(b.id, { timer: 30 }), 'NOT_HOST');
  expectError(() => lobby.setSettings(a.id, { categories: [] }), 'INVALID_SETTINGS');
  expectError(() => lobby.setSettings(a.id, { timer: 7 }), 'INVALID_SETTINGS');
  lobby.setSettings(a.id, { questions: 99, categories: ['rebus', 'culture', 'nimporte'] });
  assert.equal(lobby.settings.questions, 40);
  assert.deepEqual(lobby.settings.categories, ['culture', 'rebus']);
  const limits = lobby.publicState(a.id).limits.quiz;
  assert.equal(limits.categories.find((c) => c.id === 'culture').count, 2);
});

test('M-Culture : réponses, passage automatique, correction par l’hôte, scores', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.startGame(a.id);
  assert.equal(lobby.state, 'quiz');
  assert.equal(lobby.game.totalRounds, 3);

  const questions = lobby.game.questions;
  const state = lobby.publicState(b.id);
  assert.equal(state.game.question, null);
  assert.equal(state.game.quiz.question.answer, undefined, 'la réponse ne doit jamais fuiter');
  assert.equal(JSON.stringify(state).includes(questions[0].answer), false);

  const good = (q) => q.answer;
  // Q1 : Alice juste, Bob faux, Chloé brouillon juste (pas validé) → l'hôte passe
  lobby.submitAnswer(a.id, { index: 0, text: good(questions[0]) });
  lobby.submitAnswer(b.id, { index: 0, text: 'Lyon' });
  lobby.submitAnswer(c.id, { index: 0, text: good(questions[0]), final: false });
  assert.equal(lobby.game.index, 0);
  assert.deepEqual(lobby.publicState(a.id).game.votedIds.sort(), [a.id, b.id].sort());
  assert.equal(lobby.publicState(c.id).you.answer, good(questions[0]));
  expectError(() => lobby.forceReveal(b.id), 'NOT_HOST');
  lobby.forceReveal(a.id);
  assert.equal(lobby.game.index, 1);
  expectError(() => lobby.submitAnswer(a.id, { index: 0, text: 'x' }), 'TOO_LATE');
  expectError(() => lobby.submitAnswer(a.id, { index: 1, text: '  ' }), 'EMPTY_ANSWER');

  // Q2 et Q3 : tout le monde valide → passage automatique
  for (const index of [1, 2]) {
    for (const p of players) lobby.submitAnswer(p.id, { index, text: p === b ? good(questions[index]) : 'Je sais pas' });
  }
  assert.equal(lobby.state, 'review');
  const review = lobby.publicState(c.id).game.review;
  assert.equal(review.question.answer, questions[0].answer);
  const marks = Object.fromEntries(review.answers.map((r) => [r.playerId, r.correct]));
  assert.deepEqual(marks, { [a.id]: true, [b.id]: false, [c.id]: true }, 'le brouillon de Chloé compte');

  // L'hôte corrige : Bob avait « Lyon », on lui accorde quand même (pour le test).
  expectError(() => lobby.markAnswer(b.id, { index: 0, playerId: b.id, correct: true }), 'NOT_HOST');
  lobby.markAnswer(a.id, { index: 0, playerId: b.id, correct: true });
  lobby.goToReview(a.id, { index: 2 });
  assert.equal(lobby.publicState(b.id).game.review.index, 2);
  lobby.finishQuiz(a.id);

  assert.equal(lobby.state, 'finished');
  const pts = questions.map((q) => q.pts);
  const totals = Object.fromEntries(lobby.game.final.ranking.map((e) => [e.playerId, e.total]));
  assert.equal(totals[b.id], pts[0] + pts[1] + pts[2]);
  assert.equal(totals[a.id], pts[0]);
  assert.equal(totals[c.id], pts[0]);
  assert.equal(lobby.game.final.recap.length, 3);
  assert.ok(lobby.game.final.recap[0].answer);
});

test('M-Culture : la fin du chrono passe à la question suivante et prévient les joueurs', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']), quizBank: quizBank() });
    const changes = [];
    manager.onLobbyChange = (lobby) => changes.push(lobby.state);
    const lobby = manager.create();
    const a = lobby.addPlayer('Alice', 's1');
    lobby.addPlayer('Bob', 's2');
    lobby.setMode(a.id, 'm-culture');
    lobby.setSettings(a.id, { timer: 15, questions: 5 });
    lobby.startGame(a.id);
    const deadline = lobby.publicState(a.id).game.quiz.deadline;
    assert.equal(deadline - Date.now(), 15_000);
    mock.timers.tick(15_000);
    assert.equal(lobby.game.index, 0, 'petite marge après le chrono');
    mock.timers.tick(1000);
    assert.equal(lobby.game.index, 1);
    assert.equal(changes.length, 1);
    mock.timers.tick(16_000);
    mock.timers.tick(16_000);
    assert.equal(lobby.state, 'review');

    // Lobby supprimé : plus aucun chrono actif.
    lobby.backToLobby(a.id);
    lobby.startGame(a.id);
    lobby.removePlayer(a.id);
    lobby.removePlayer(lobby.playerIds[0]);
    manager.deleteIfEmpty(lobby);
    assert.equal(lobby.quizTimer, null);
  } finally {
    mock.timers.reset();
  }
});

test('M-Culture : un joueur déconnecté ne bloque pas la question', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.startGame(a.id);
  lobby.markDisconnected(c.id, 's2');
  lobby.submitAnswer(a.id, { index: 0, text: 'x' });
  lobby.submitAnswer(b.id, { index: 0, text: 'y' });
  assert.equal(lobby.game.index, 1);
});
