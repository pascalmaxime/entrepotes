import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);

// Fausse bibliothèque : juste ce que le jeu utilise (list, count).
const fakeLibrary = (n) => {
  const ids = Array.from({ length: n }, (_, i) => `img${String(i).padStart(3, '0')}`);
  return { get count() { return ids.length; }, list: () => ids.map((id) => ({ id, url: `/memes/${id}.jpg` })), ids };
};

function setup(n = 4, images = 40, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.memeLibrary = fakeLibrary(images);
  const players = ['Ana', 'Bob', 'Cléo', 'Dan', 'Eva'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'image-mystere');
  lobby.setSettings(players[0].id, { imTimer: 60, ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players, im: lobby.game.im };
}
const view = (lobby, id) => lobby.publicState(id).game.imageMystere;
const handOf = (lobby, id) => view(lobby, id).hand.map((c) => c.id);

test('Image Mystère : il faut assez d’images dans la bibliothèque', () => {
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.memeLibrary = fakeLibrary(10);
  const players = ['Ana', 'Bob', 'Cléo'].map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'image-mystere');
  assert.equal(lobby.publicState(players[0].id).limits.imageMystere.imagesNeeded, 18);
  expectError(() => lobby.startGame(players[0].id), 'NO_TEMPLATES');
});

test('Image Mystère : mains, phrase, cartes posées, vote, points façon Dixit', () => {
  const { lobby, players, im } = setup(4);
  try {
    assert.equal(lobby.state, 'im-tell');
    const all = players.map((p) => p.id);
    // 5 images chacun, toutes différentes
    const hands = all.map((id) => handOf(lobby, id));
    assert.ok(hands.every((h) => h.length === 5));
    assert.equal(new Set(hands.flat()).size, 20);
    const teller = im.teller;
    const [x, y, z] = all.filter((id) => id !== teller);
    const tellerCard = handOf(lobby, teller)[0];
    expectError(() => lobby.imTell(x, { cardId: handOf(lobby, x)[0], phrase: 'Lundi' }), 'NOT_TELLER');
    expectError(() => lobby.imTell(teller, { cardId: handOf(lobby, x)[0], phrase: 'Lundi' }), 'NOT_IN_HAND');
    expectError(() => lobby.imTell(teller, { cardId: tellerCard, phrase: '  ' }), 'EMPTY');
    lobby.imTell(teller, { cardId: tellerCard, phrase: 'Lundi matin' });
    assert.equal(lobby.state, 'im-play');
    assert.equal(view(lobby, x).phrase, 'Lundi matin');
    assert.equal(view(lobby, x).myCard, null);
    expectError(() => lobby.imPlay(teller, { cardId: handOf(lobby, teller)[1] }), 'TELLER');

    const cardOf = { [teller]: tellerCard };
    for (const id of [x, y, z]) {
      cardOf[id] = handOf(lobby, id)[2];
      lobby.imPlay(id, { cardId: cardOf[id] });
    }
    assert.equal(lobby.state, 'im-vote');
    const choices = view(lobby, x).choices;
    assert.equal(choices.length, 4);
    assert.ok(!JSON.stringify(lobby.publicState(x)).includes('"owner"'), 'personne ne sait à qui sont les images');
    const choiceOf = (cardId) => im.choices.find((c) => c.cardId === cardId).id;
    expectError(() => lobby.imVote(x, { choiceId: choiceOf(cardOf[x]) }), 'OWN_CARD');
    expectError(() => lobby.imVote(teller, { choiceId: choiceOf(cardOf[x]) }), 'TELLER');

    // x trouve, y et z votent pour l'image de x → conteur 3, x 3 + 2 votes reçus = 5
    lobby.imVote(x, { choiceId: choiceOf(tellerCard) });
    lobby.imVote(y, { choiceId: choiceOf(cardOf[x]) });
    lobby.imVote(z, { choiceId: choiceOf(cardOf[x]) });
    assert.equal(lobby.state, 'im-reveal');
    const r = lobby.publicState(x).game.result;
    assert.equal(r.allOrNone, false);
    assert.deepEqual(r.gains, { [teller]: 3, [x]: 5 });
    assert.equal(r.cards.find((c) => c.teller).voters[0], x);
    // Les images jouées quittent les mains, qui sont recomplétées à la manche suivante
    assert.equal(handOf(lobby, x).length, 4);
    lobby.nextQuestion(lobby.hostId);
    assert.equal(lobby.state, 'im-tell');
    assert.notEqual(im.teller, teller);
    assert.ok(all.every((id) => handOf(lobby, id).length === 5));
    assert.ok(!handOf(lobby, x).includes(cardOf[x]));
  } finally {
    mock.timers.reset();
  }
});

test('Image Mystère : tout le monde (ou personne) trouve → le conteur ne marque rien', () => {
  const { lobby, players, im } = setup(3);
  try {
    const teller = im.teller;
    const [x, y] = players.map((p) => p.id).filter((id) => id !== teller);
    const tc = handOf(lobby, teller)[0];
    lobby.imTell(teller, { cardId: tc, phrase: 'Trop facile' });
    lobby.imPlay(x, { cardId: handOf(lobby, x)[0] });
    lobby.imPlay(y, { cardId: handOf(lobby, y)[0] });
    const choiceOf = (cardId) => im.choices.find((c) => c.cardId === cardId).id;
    lobby.imVote(x, { choiceId: choiceOf(tc) });
    lobby.imVote(y, { choiceId: choiceOf(tc) });
    const r = lobby.game.result;
    assert.equal(r.allOrNone, true);
    assert.deepEqual(r.gains, { [x]: 2, [y]: 2 });
  } finally {
    mock.timers.reset();
  }
});

test('Image Mystère : chronos, conteur absent, hôte, fin et réglages', () => {
  const { lobby, players, im } = setup(4);
  try {
    // Chrono de la phrase écoulé : manche sautée
    mock.timers.tick(61_500);
    assert.equal(im.index, 1);
    assert.equal(lobby.state, 'im-tell');
    // Le conteur se déconnecte : manche sautée
    const t = im.teller;
    lobby.markDisconnected(t, lobby.players.get(t).socketId);
    assert.equal(im.index, 2);
    // L'hôte fait avancer : pose → vote → révélation
    const teller = im.teller;
    lobby.imTell(teller, { cardId: handOf(lobby, teller)[0], phrase: 'Hop' });
    const someone = players.map((p) => p.id).find((id) => id !== teller && lobby.players.get(id).connected);
    lobby.imPlay(someone, { cardId: handOf(lobby, someone)[0] });
    lobby.forceReveal(lobby.hostId);
    assert.equal(lobby.state, 'im-vote');
    assert.equal(im.choices.length, 2);
    lobby.forceReveal(lobby.hostId);
    assert.equal(lobby.state, 'im-reveal');
    lobby.nextQuestion(lobby.hostId);
    // Manche 4 (la dernière) : l'hôte saute la phrase du conteur → fin de partie
    assert.equal(lobby.state, 'im-tell');
    assert.equal(im.index, 3);
    lobby.forceReveal(lobby.hostId);
    assert.equal(lobby.state, 'finished');
    assert.ok(lobby.publicState(lobby.hostId).game.final.recap.length >= 3);

    lobby.backToLobby(lobby.hostId);
    expectError(() => lobby.setSettings(lobby.hostId, { imTurns: 3 }), 'INVALID_SETTINGS');
    lobby.setSettings(lobby.hostId, { imTurns: 2, imTimer: 90 });
    assert.deepEqual(lobby.settings.imageMystere, { turns: 2, timer: 90 });
  } finally {
    mock.timers.reset();
  }
});
