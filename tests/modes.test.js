import { test } from 'node:test';
import assert from 'node:assert/strict';
import quiDeNous from '../src/game/modes/quiDeNous.js';
import tierList from '../src/game/modes/tierList.js';

const ids = ['a', 'b', 'c'];

test('Qui de nous : compte les votes et désigne le gagnant', () => {
  const result = quiDeNous.aggregate(new Map([['a', 'b'], ['b', 'b'], ['c', 'a']]), ids);
  assert.deepEqual(result.winners, ['b']);
  assert.equal(result.ranking[0].votes, 2);
  assert.equal(result.totalVotes, 3);
});

test('Qui de nous : gère les égalités', () => {
  const result = quiDeNous.aggregate(new Map([['a', 'b'], ['b', 'a']]), ids);
  assert.deepEqual([...result.winners].sort(), ['a', 'b']);
  const rank = Object.fromEntries(result.ranking.map((e) => [e.playerId, e.rank]));
  assert.deepEqual(rank, { a: 1, b: 1, c: 3 });
});

test('Qui de nous : refuse un vote pour un joueur inconnu', () => {
  assert.equal(quiDeNous.normalizeVote('z', { playerIds: ids }), null);
  assert.equal(quiDeNous.normalizeVote(42, { playerIds: ids }), null);
  assert.equal(quiDeNous.normalizeVote('a', { playerIds: ids }), 'a');
});

test('Tier List : agrège les classements (Top 1 = N points)', () => {
  const votes = new Map([
    ['a', ['b', 'a', 'c']],
    ['b', ['b', 'c', 'a']],
    ['c', ['a', 'b', 'c']],
  ]);
  const result = tierList.aggregate(votes, ids);
  // b : 3+3+2 = 8 · a : 2+1+3 = 6 · c : 1+2+1 = 4
  assert.deepEqual(result.ranking.map((e) => [e.playerId, e.points, e.rank]), [['b', 8, 1], ['a', 6, 2], ['c', 4, 3]]);
  assert.equal(result.ranking[0].averagePosition, 1.3);
});

test('Tier List : à points égaux, le nombre de Top 1 départage', () => {
  const result = tierList.aggregate(new Map([['a', ['a', 'b', 'c']], ['b', ['c', 'b', 'a']]]), ids);
  const rank = Object.fromEntries(result.ranking.map((e) => [e.playerId, e.rank]));
  assert.deepEqual(rank, { a: 1, c: 1, b: 3 });
});

test('Tier List : chaque joueur doit apparaître une seule fois', () => {
  assert.equal(tierList.normalizeVote(['a', 'b'], { playerIds: ids }), null);
  assert.equal(tierList.normalizeVote(['a', 'a', 'b'], { playerIds: ids }), null);
  assert.equal(tierList.normalizeVote(['a', 'b', 'z'], { playerIds: ids }), null);
  assert.deepEqual(tierList.normalizeVote(['c', 'a', 'b'], { playerIds: ids }), ['c', 'a', 'b']);
});

test('Tier List : le détail donne le classement complet de chaque joueur', () => {
  const votes = new Map([
    ['a', ['b', 'a', 'c']],
    ['c', ['c', 'b', 'a']],
  ]);
  const result = tierList.aggregate(votes, ids);
  assert.deepEqual(result.details, [
    { voterId: 'a', ranking: ['b', 'a', 'c'] },
    { voterId: 'c', ranking: ['c', 'b', 'a'] },
  ]);
});
