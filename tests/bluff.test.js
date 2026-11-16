import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createBluffBank, getBank, isTruth } from '../src/bluff/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const Q1 = { key: 'histoire:1', cat: 'histoire', prompt: 'Napoléon a été attaqué par une horde de _____.', answer: 'lapins', alt: ['lapin'], fake: ['canards', 'sangliers', 'moutons'] };
const Q2 = { key: 'animaux:2', cat: 'animaux', prompt: 'Le poulpe possède _____ cœurs.', answer: 'trois', alt: ['3'], fake: ['deux', 'huit', 'neuf'] };

function setup(n = 4, settings = {}, questions = [Q1, Q2]) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.bluffBank = createBluffBank(questions);
  const players = ['Ana', 'Bob', 'Cléo', 'Dan', 'Eva'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'bluff');
  lobby.setSettings(players[0].id, { rounds: questions.length, blWrite: 45, blVote: 20, ...settings });
  lobby.startGame(players[0].id);
  lobby.game.bluff.questions = [...questions]; // ordre fixe pour les tests (le jeu les mélange)
  return { lobby, players, bl: lobby.game.bluff };
}
const view = (lobby, p) => lobby.publicState(p.id).game.bluff;
const choiceOf = (lobby, p, text) => view(lobby, p).choices.find((c) => c.text === text);
const truthChoice = (lobby, p) => view(lobby, p).choices.find((c) => !['canards', 'sangliers', 'moutons', 'des écureuils', 'des poules', 'Des Poules !', 'un ours', 'des chats'].includes(c.text));

test('Bluff : la vraie réponse (ou presque) est refusée comme mensonge', () => {
  const q = { answer: 'lapins', alt: ['lapin'] };
  assert.equal(isTruth('Des LAPINS', q), true);
  assert.equal(isTruth('lapain', q), true);
  assert.equal(isTruth('des lapins géants', q), true);
  assert.equal(isTruth('des lapereaux', q), false);
  assert.equal(isTruth('2004', { answer: '2006', alt: [] }), false);
  assert.equal(isTruth('deux tiers', { answer: 'un tiers', alt: [] }), false);
  assert.equal(isTruth('Dé', { answer: 'dé', alt: [] }), true);
});

test('Bluff : la banque fournie est valide (les leurres ne sont jamais la vraie réponse)', () => {
  const bank = getBank();
  assert.ok(bank.size >= 150);
  const all = bank.pick({ categories: Object.keys(bank.counts()), count: 1000 });
  for (const q of all) {
    assert.ok(q.prompt.includes('_____'), q.prompt);
    assert.ok(q.fake.length >= 2, q.prompt);
    for (const f of q.fake) assert.equal(isTruth(f, q), false, `${q.prompt} → ${f}`);
  }
});

test('Bluff : mensonges, vote, points et révélation', () => {
  const { lobby, players, bl } = setup(4);
  const [ana, bob, cleo, dan] = players;
  try {
    assert.equal(lobby.state, 'bl-write');
    const state = JSON.stringify(lobby.publicState(ana.id));
    assert.ok(!state.includes('lapins'), 'la réponse ne part jamais pendant l’écriture');
    expectError(() => lobby.blLie(ana.id, { index: 0, text: 'Des lapins' }), 'IS_TRUTH');
    expectError(() => lobby.blLie(ana.id, { index: 0, text: '   ' }), 'EMPTY');
    expectError(() => lobby.blLie(ana.id, { index: 1, text: 'des chats' }), 'TOO_LATE');
    lobby.blLie(ana.id, { index: 0, text: 'des écureuils' });
    lobby.blLie(ana.id, { index: 0, text: 'des poules' }); // on peut changer d'avis
    lobby.blLie(bob.id, { index: 0, text: 'Des Poules !' }); // même mensonge : fusionné
    lobby.blLie(cleo.id, { index: 0, text: 'un ours' });
    assert.equal(view(lobby, ana).myLie, 'des poules');
    assert.deepEqual(view(lobby, dan).doneIds.length, 3);
    const idea = lobby.blSuggest(dan.id);
    assert.ok(Q1.fake.includes(idea));
    lobby.blLie(dan.id, { index: 0, text: idea });

    // Vote : vérité + 3 mensonges distincts (poules fusionnées) = 4 choix, pas de leurre du jeu.
    assert.equal(lobby.state, 'bl-vote');
    const choices = view(lobby, ana).choices;
    assert.equal(choices.length, 4);
    assert.ok(!JSON.stringify(choices).includes('authors'));
    assert.equal(choices.filter((c) => c.mine).length, 1);
    const poules = choiceOf(lobby, ana, 'des poules');
    assert.ok(poules.mine);
    assert.ok(choiceOf(lobby, bob, 'des poules').mine, 'Bob est aussi auteur');
    expectError(() => lobby.blVote(ana.id, { index: 0, choiceId: poules.id }), 'OWN_LIE');
    const truth = truthChoice(lobby, ana);
    assert.equal(truth.text, 'lapins');

    lobby.blVote(ana.id, { index: 0, choiceId: truth.id }); // +2
    lobby.blVote(bob.id, { index: 0, choiceId: choiceOf(lobby, bob, 'un ours').id }); // Cléo +1
    lobby.blVote(cleo.id, { index: 0, choiceId: poules.id }); // Ana +1, Bob +1
    lobby.blVote(dan.id, { index: 0, choiceId: poules.id }); // Ana +1, Bob +1

    assert.equal(lobby.state, 'bl-reveal');
    const result = lobby.publicState(ana.id).game.result;
    assert.equal(result.answer, 'lapins');
    assert.equal(result.choices.at(-1).truth, true, 'la vérité en dernier');
    assert.deepEqual(lobby.game.totals, { [ana.id]: 4, [bob.id]: 2, [cleo.id]: 1 });
    assert.equal(result.mult, 1);

    // Dernière question : points doublés.
    lobby.nextQuestion(ana.id);
    assert.equal(lobby.state, 'bl-write');
    assert.equal(view(lobby, ana).mult, 2);
    assert.equal(bl.index, 1);
    lobby.forceReveal(ana.id); // l'hôte passe : personne n'a écrit → le jeu complète avec ses leurres
    assert.equal(lobby.state, 'bl-vote');
    assert.equal(view(lobby, ana).choices.length, 4);
    const t2 = view(lobby, bob).choices.find((c) => c.text === 'trois');
    lobby.blVote(bob.id, { index: 1, choiceId: t2.id });
    lobby.forceReveal(ana.id);
    assert.equal(lobby.state, 'bl-reveal');
    assert.equal(lobby.game.totals[bob.id], 2 + 4);
    assert.deepEqual(lobby.game.result.noVote.sort(), [ana.id, cleo.id, dan.id].sort());

    lobby.nextQuestion(ana.id);
    assert.equal(lobby.state, 'finished');
    assert.equal(lobby.game.final.ranking[0].playerId, bob.id);
    assert.equal(lobby.game.final.bluff.bestLie.text, 'des poules');
    assert.equal(lobby.game.final.recap.length, 2);
  } finally {
    lobby.dispose();
    mock.timers.reset();
  }
});

test('Bluff : les chronos font avancer la partie tout seuls', () => {
  const { lobby, players } = setup(3, {}, [Q1]);
  try {
    let changes = 0;
    lobby.onChange = () => (changes += 1);
    lobby.blLie(players[0].id, { index: 0, text: 'des chats' });
    mock.timers.tick(46_000);
    assert.equal(lobby.state, 'bl-vote');
    assert.equal(view(lobby, players[1]).choices.length, 4, 'chats + vérité + 2 leurres');
    mock.timers.tick(21_000);
    assert.equal(lobby.state, 'bl-reveal');
    assert.equal(changes, 2);
    assert.equal(lobby.game.result.mult, 1, 'une seule question : pas de double');
  } finally {
    lobby.dispose();
    mock.timers.reset();
  }
});

test('Bluff : réglages et minimum de joueurs', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  const [a, b] = ['Ana', 'Bob'].map((name, i) => lobby.addPlayer(name, `s${i}`));
  try {
    lobby.setMode(a.id, 'bluff');
    expectError(() => lobby.setSettings(a.id, { blWrite: 7 }), 'INVALID_SETTINGS');
    expectError(() => lobby.setSettings(a.id, { blCategories: [] }), 'INVALID_SETTINGS');
    lobby.setSettings(a.id, { blCategories: ['sport', 'nimporte'], blDouble: false, blVote: 45 });
    assert.deepEqual(lobby.settings.bluff.categories, ['sport']);
    assert.equal(lobby.settings.bluff.double, false);
    assert.ok(lobby.publicState(a.id).limits.bluff.categories.find((c) => c.id === 'sport').count > 0);
    expectError(() => lobby.startGame(a.id), 'NOT_ENOUGH_PLAYERS');
    assert.ok(b);
  } finally {
    lobby.dispose();
    mock.timers.reset();
  }
});
