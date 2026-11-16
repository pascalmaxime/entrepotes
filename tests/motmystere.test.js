import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createSecretBank, getBank, score } from '../src/motmystere/engine.js';
import { letters, loadDictionary } from '../src/tictacboum/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);

function setup(n = 3, settings = {}, words = ['chapeau', 'bateau']) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  const byLength = {};
  for (const w of words) (byLength[w.length] ??= new Map()).set(w, w);
  lobby.mmBank = createSecretBank(byLength);
  const players = ['Ana', 'Bob', 'Cléo', 'Dan'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'mot-mystere');
  lobby.setSettings(players[0].id, { mmRounds: 3, mmLength: 7, mmTimer: 60, ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players, mm: lobby.game.mm };
}
const view = (lobby, p) => lobby.publicState(p.id).game.motMystere;

test('Mot Mystère : couleurs façon Wordle, lettres en double comprises', () => {
  assert.deepEqual(score('chapeau', 'chapeau'), Array(7).fill('ok'));
  assert.deepEqual(score('abcde', 'eabcd'), ['near', 'near', 'near', 'near', 'near']);
  // « allee » contre « lapin » : un seul L est mal placé, le second est absent
  assert.deepEqual(score('allee', 'lapin'), ['near', 'near', 'no', 'no', 'no']);
  // « tasse » contre « tests » : T bien placé, S en double → les deux comptent
  assert.deepEqual(score('tasse', 'tests'), ['ok', 'no', 'ok', 'near', 'near']);
});

test('Mot Mystère : les mots à deviner existent tous dans le dictionnaire', () => {
  const bank = getBank();
  const dict = loadDictionary();
  const counts = bank.counts();
  for (const len of [5, 6, 7, 8]) assert.ok(counts[len] >= 100, `${len} lettres : ${counts[len]}`);
  const used = new Set();
  for (let i = 0; i < 300; i += 1) {
    const w = bank.pick(5 + (i % 4), used);
    assert.ok(dict.words.has(w.key), w.display);
    assert.equal(letters(w.display), w.key);
  }
});

test('Mot Mystère : essais, secret jamais envoyé, course et points', () => {
  const { lobby, players, mm } = setup(3);
  const [ana, bob, cleo] = players;
  try {
    assert.equal(lobby.state, 'mm-play');
    assert.equal(mm.secret.key, 'chapeau');
    const v = view(lobby, ana);
    assert.equal(v.length, 7);
    assert.equal(v.first, 'c');
    assert.ok(!JSON.stringify(lobby.publicState(ana.id)).includes('chapeau'), 'le mot ne part jamais pendant la manche');

    expectError(() => lobby.mmGuess(ana.id, { index: 0, word: 'chat' }), 'BAD_LENGTH');
    expectError(() => lobby.mmGuess(ana.id, { index: 0, word: 'bateaux' }), 'BAD_FIRST');
    expectError(() => lobby.mmGuess(ana.id, { index: 0, word: 'cxzqwvk' }), 'NOT_A_WORD');
    expectError(() => lobby.mmGuess(ana.id, { index: 1, word: 'chameau' }), 'TOO_LATE');

    const first = lobby.mmGuess(ana.id, { index: 0, word: 'Chameau' });
    assert.deepEqual(first.colors, ['ok', 'ok', 'ok', 'no', 'ok', 'ok', 'ok']);
    expectError(() => lobby.mmGuess(ana.id, { index: 0, word: 'CHAMEAU' }), 'ALREADY_TRIED');
    // Les autres voient les couleurs d'Ana, jamais ses lettres
    const seen = view(lobby, bob).others.find((o) => o.playerId === ana.id);
    assert.deepEqual(seen.colors, [first.colors]);
    assert.ok(!JSON.stringify(view(lobby, bob)).includes('chameau'));
    assert.deepEqual(view(lobby, ana).myRows[0].word, 'chameau');

    // Bob trouve du premier coup, Ana au 2e essai, Cléo ne trouve pas (6 essais)
    assert.equal(lobby.mmGuess(bob.id, { index: 0, word: 'chapeau' }).found, true);
    expectError(() => lobby.mmGuess(bob.id, { index: 0, word: 'chameau' }), 'DONE');
    lobby.mmGuess(ana.id, { index: 0, word: 'chapeau' });
    for (const w of ['chameau', 'chandel', 'chaleur', 'charnue', 'chassee', 'chatier']) {
      try {
        lobby.mmGuess(cleo.id, { index: 0, word: w });
      } catch (e) {
        if (e.code !== 'NOT_A_WORD') throw e;
      }
    }
    while (lobby.state === 'mm-play') {
      // compléter les essais de Cléo avec des mots valides
      const tried = new Set(view(lobby, cleo).myRows.map((r) => r.word));
      const next = ['chameau', 'chaleur', 'chatier', 'chanter', 'chasser', 'chemise', 'cheveux', 'chevaux'].find((w) => !tried.has(w));
      lobby.mmGuess(cleo.id, { index: 0, word: next });
    }
    assert.equal(lobby.state, 'mm-reveal');
    const result = lobby.publicState(ana.id).game.result;
    assert.equal(result.word, 'chapeau');
    // Bob : 10 + 2×5 + 5 (1er) = 25 ; Ana : 10 + 2×4 + 3 (2e) = 21 ; Cléo : 0
    assert.equal(result.gains[bob.id], 25);
    assert.equal(result.gains[ana.id], 21);
    assert.equal(result.gains[cleo.id], undefined);
    assert.equal(result.boards.find((b) => b.playerId === cleo.id).rows.length, 6);
    assert.equal(result.boards.find((b) => b.playerId === bob.id).rank, 1);

    lobby.nextQuestion(ana.id);
    assert.equal(lobby.state, 'mm-play');
    assert.equal(mm.secret.key, 'chapeau', 'un seul mot de 7 lettres dans ce test : il revient');
    assert.equal(view(lobby, ana).myRows.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('Mot Mystère : chrono, hôte, départ d’un joueur, réglages', () => {
  const { lobby, players, mm } = setup(3, { mmFirst: false, mmRounds: 3 });
  const [ana, bob, cleo] = players;
  try {
    assert.equal(view(lobby, ana).first, null);
    mock.timers.tick(61_500);
    assert.equal(lobby.state, 'mm-reveal', 'fin du chrono → révélation');
    lobby.nextQuestion(ana.id);
    lobby.forceReveal(ana.id);
    assert.equal(lobby.state, 'mm-reveal', 'l’hôte peut révéler');
    lobby.nextQuestion(ana.id);
    // Ana et Bob ont fini, Cléo s'en va : la manche se termine
    lobby.mmGuess(ana.id, { index: 2, word: mm.secret.key });
    lobby.mmGuess(bob.id, { index: 2, word: mm.secret.key });
    assert.equal(lobby.state, 'mm-play');
    lobby.removePlayer(cleo.id);
    assert.equal(lobby.state, 'mm-reveal');
    lobby.nextQuestion(ana.id);
    assert.equal(lobby.state, 'finished');
    assert.equal(lobby.publicState(ana.id).game.final.recap.length, 3);

    lobby.backToLobby(ana.id);
    expectError(() => lobby.setSettings(ana.id, { mmLength: 4 }), 'INVALID_SETTINGS');
    expectError(() => lobby.setSettings(ana.id, { mmTimer: 30 }), 'INVALID_SETTINGS');
    lobby.setSettings(ana.id, { mmLength: 0, mmRounds: 8 });
    assert.equal(lobby.settings.motMystere.rounds, 8);
    assert.ok(lobby.publicState(ana.id).limits.motMystere.words['7'] >= 1);
  } finally {
    mock.timers.reset();
  }
});
