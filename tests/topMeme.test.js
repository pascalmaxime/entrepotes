import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/game/Lobby.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';

// Fausse bibliothèque : tire toujours la première image disponible (tests reproductibles).
const fakeLibrary = (ids = ['t1', 't2', 't3', 't4', 't5', 't6']) => ({
  get count() {
    return ids.length;
  },
  randomId(exclude = new Set()) {
    return ids.find((id) => !exclude.has(id)) ?? null;
  },
});

function setup({ library = fakeLibrary(), rounds = 1 } = {}) {
  const lobby = new Lobby('ABCDE', { questionBank: createQuestionBank(['Q ?']), memeLibrary: library });
  const players = ['Alice', 'Bob', 'Chloé'].map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'top-meme');
  lobby.setSettings(players[0].id, { rounds });
  return { lobby, players };
}

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const memeIdOf = (lobby, player) => lobby.game.submissions.get(player.id).id;

test('Top Meme : impossible de lancer sans image dans la bibliothèque', () => {
  const { lobby, players } = setup({ library: fakeLibrary([]) });
  expectError(() => lobby.startGame(players[0].id), 'NO_TEMPLATES');
  assert.equal(lobby.state, 'lobby');
});

test('Top Meme : manche complète, vote anonyme, points et classement', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.startGame(a.id);
  assert.equal(lobby.state, 'create');

  // Chacun reçoit une image différente, visible seulement par lui.
  const templates = players.map((p) => lobby.publicState(p.id).you.assignment.templateId);
  assert.equal(new Set(templates).size, 3);
  assert.equal(lobby.publicState(null).you, null);

  // Changer d'image : 2 fois maximum.
  lobby.rerollTemplate(b.id);
  lobby.rerollTemplate(b.id);
  expectError(() => lobby.rerollTemplate(b.id), 'NO_REROLL');

  expectError(() => lobby.submitMeme(a.id, [{ text: '   ' }]), 'EMPTY_MEME');
  lobby.submitMeme(a.id, [
    { text: 'Quand le lundi arrive', x: 0.5, y: 0.1, size: 0.08, color: '#FFFFFF' },
    { text: '<script>', x: 9, y: -3, size: 99, color: 'red' },
  ]);
  // Les valeurs farfelues sont ramenées dans les limites, le texte reste du texte.
  assert.deepEqual(lobby.game.submissions.get(a.id).items[1], { text: '<script>', x: 1, y: 0, size: 0.25, color: '#ffffff' });
  lobby.submitMeme(b.id, [{ text: '😂' }]);
  expectError(() => lobby.rerollTemplate(b.id), 'ALREADY_SUBMITTED');
  assert.equal(lobby.state, 'create');
  lobby.submitMeme(c.id, [{ text: 'Moi' }]);
  assert.equal(lobby.state, 'vote');

  // Pendant le vote, les memes sont anonymes.
  const view = lobby.publicState(a.id);
  assert.equal(view.game.memes.length, 3);
  assert.ok(!JSON.stringify(view.game.memes).includes(b.id));
  assert.equal(view.you.memeId, memeIdOf(lobby, a));

  const [ma, mb, mc] = [a, b, c].map((p) => memeIdOf(lobby, p));
  expectError(() => lobby.submitMemeVotes(a.id, { [mb]: 1 }), 'INVALID_VOTE'); // il manque un meme
  lobby.submitMemeVotes(a.id, { [mb]: 1, [mc]: -1 });
  lobby.submitMemeVotes(b.id, { [ma]: 1, [mc]: 0 });
  assert.equal(lobby.state, 'vote');
  lobby.submitMemeVotes(c.id, { [ma]: 1, [mb]: 1 });
  assert.equal(lobby.state, 'results');

  // a : +1 +1 = 2 · b : +1 +1 = 2 · c : −1 + 0 = −1
  const { memes } = lobby.game.result;
  assert.deepEqual(
    memes.map((m) => [m.authorId, m.score, m.rank]),
    [
      [memes[0].authorId, 2, 1],
      [memes[1].authorId, 2, 1],
      [c.id, -1, 3],
    ],
  );
  assert.deepEqual(memes.find((m) => m.authorId === c.id).down, 1);

  lobby.nextQuestion(a.id);
  assert.equal(lobby.state, 'finished');
  const { final } = lobby.publicState(a.id).game;
  assert.equal(final.ranking.at(-1).playerId, c.id);
  assert.equal(final.recap.length, 1);
  assert.ok(final.recap[0].best.items.length > 0);
});

test('Top Meme : l’hôte peut passer au vote puis révéler sans attendre tout le monde', () => {
  const { lobby, players } = setup({ rounds: 2 });
  const [a, b] = players;
  lobby.startGame(a.id);
  expectError(() => lobby.forceReveal(a.id), 'NO_MEMES');
  lobby.submitMeme(a.id, [{ text: 'Seul' }]);
  lobby.submitMeme(b.id, [{ text: 'Duo' }]);
  expectError(() => lobby.forceReveal(b.id), 'NOT_HOST');
  lobby.forceReveal(a.id);
  assert.equal(lobby.state, 'vote');
  lobby.submitMemeVotes(a.id, { [memeIdOf(lobby, b)]: 1 });
  lobby.forceReveal(a.id);
  assert.equal(lobby.state, 'results');

  lobby.nextQuestion(a.id);
  assert.equal(lobby.state, 'create');
  assert.equal(lobby.publicState(a.id).game.round, 2);
});

test('Top Meme : un joueur déconnecté ne bloque pas la manche', () => {
  const { lobby, players } = setup();
  const [a, b, c] = players;
  lobby.startGame(a.id);
  lobby.submitMeme(a.id, [{ text: 'A' }]);
  lobby.submitMeme(b.id, [{ text: 'B' }]);
  lobby.markDisconnected(c.id, 's2');
  assert.equal(lobby.state, 'vote');
});
