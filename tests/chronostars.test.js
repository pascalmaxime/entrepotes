import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createCardBank, getBank } from '../src/chronostars/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const CARDS = ['Zidane', 'Napoléon', 'Astérix', 'Mozart', 'Batman', 'Cléopâtre', 'Shrek', 'Mbappé'].map((name, i) => ({ key: `x:${name}`, cat: ['stars', 'histoire', 'fiction'][i % 3], name }));

function setup(n = 4, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.csBank = createCardBank(CARDS);
  const players = ['Ana', 'Bob', 'Cléo', 'Dan', 'Eva'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'chrono-stars');
  lobby.setSettings(players[0].id, { csCards: 20, csTimer: 30, ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players, cs: lobby.game.cs };
}
const view = (lobby, id) => lobby.publicState(id).game.chronoStars;
const teammate = (cs, id) => cs.order[cs.turnTeam].find((x) => x !== id);
const opponent = (cs) => cs.order[cs.turnTeam === 'rouge' ? 'bleu' : 'rouge'][0];

test('Chrono Stars : la liste de personnalités est valide', () => {
  const bank = getBank();
  const counts = bank.counts();
  for (const cat of ['stars', 'histoire', 'fiction']) assert.ok(counts[cat] >= 100, `${cat} : ${counts[cat]}`);
  const used = new Set();
  const a = bank.pick({ categories: ['stars', 'histoire', 'fiction'], count: 50 }, used);
  const b = bank.pick({ categories: ['stars', 'histoire', 'fiction'], count: 50 }, used);
  assert.equal(new Set([...a, ...b].map((c) => c.key)).size, 100, 'pas de carte répétée d’une partie à l’autre');
  const fiction = a.filter((c) => c.cat === 'fiction').length;
  assert.ok(fiction === 16 || fiction === 17, 'thèmes répartis équitablement (50 / 3)');
});

test('Chrono Stars : qui voit la carte, trouvé / passer, fin du chrono', () => {
  const { lobby, cs } = setup(4);
  try {
    assert.equal(lobby.state, 'cs-ready');
    assert.equal(cs.cards.length, 8, 'seulement 8 cartes dans ce test');
    assert.equal(cs.order.rouge.length + cs.order.bleu.length, 4);
    const clueur = cs.clueur;
    const mate = teammate(cs, clueur);
    const opp = opponent(cs);
    assert.ok(cs.order[cs.turnTeam].includes(clueur));
    expectError(() => lobby.csGo(mate), 'NOT_YOUR_TURN');
    lobby.csGo(clueur);
    assert.equal(lobby.state, 'cs-play');

    // La carte : pour celui qui fait deviner et pour l'équipe adverse, jamais pour ses coéquipiers.
    const card = view(lobby, clueur).card;
    assert.ok(card?.name);
    assert.equal(view(lobby, opp).card.id, card.id);
    assert.equal(view(lobby, mate).card, null);
    assert.ok(!JSON.stringify(lobby.publicState(mate)).includes(card.name));

    expectError(() => lobby.csPass(clueur, { cardId: card.id }), 'NO_PASS'); // manche 1
    expectError(() => lobby.csFound(mate, { cardId: card.id }), 'NOT_YOUR_TURN');
    lobby.csFound(clueur, { cardId: card.id });
    expectError(() => lobby.csFound(clueur, { cardId: card.id }), 'STALE'); // double appui
    const second = view(lobby, clueur).card;
    lobby.csFound(clueur, { cardId: second.id });
    assert.equal(view(lobby, mate).turnFound.length, 2);
    assert.equal(view(lobby, mate).deckLeft, 6);

    // Fin du chrono : la carte en cours retourne dans le paquet, c'est à l'autre équipe
    const team = cs.turnTeam;
    mock.timers.tick(31_600);
    assert.equal(lobby.state, 'cs-ready');
    assert.notEqual(cs.turnTeam, team);
    assert.equal(view(lobby, mate).lastTurn.found.length, 2);
    assert.equal(cs.deck.length, 6);
  } finally {
    mock.timers.reset();
  }
});

test('Chrono Stars : 3 manches avec le même paquet, points d’équipe, classement', () => {
  const { lobby, players, cs } = setup(5);
  try {
    const host = players[0].id;
    const firstTeam = cs.turnTeam;
    const playTurn = (n) => {
      lobby.csGo(cs.clueur);
      for (let i = 0; i < n && lobby.state === 'cs-play'; i += 1) lobby.csFound(cs.clueur, { cardId: cs.current });
      if (lobby.state === 'cs-play') lobby.forceReveal(host); // l'hôte arrête le tour
    };
    // Manche 1 : 5 cartes pour la 1re équipe, 3 pour l'autre → paquet vide
    playTurn(5);
    playTurn(3);
    assert.equal(lobby.state, 'cs-manche-end');
    const r1 = view(lobby, host).result;
    assert.equal(r1.counts[firstTeam], 5);
    assert.equal(r1.found[firstTeam].length, 5);
    const member = cs.order[firstTeam][0];
    assert.equal(lobby.game.totals[member], 5);

    // Manche 2 : même paquet, l'équipe qui n'a pas fini commence ; on peut passer
    lobby.nextQuestion(host);
    assert.equal(lobby.state, 'cs-ready');
    assert.equal(cs.deck.length, 8);
    assert.equal(cs.turnTeam, firstTeam, 'l’équipe qui n’a pas joué le dernier tour commence');
    lobby.csGo(cs.clueur);
    const before = cs.current;
    lobby.csPass(cs.clueur, { cardId: before });
    assert.notEqual(cs.current, before);
    assert.equal(cs.deck.at(-1), before, 'la carte passée va sous le paquet');
    while (lobby.state === 'cs-play') lobby.csFound(cs.clueur, { cardId: cs.current });
    assert.equal(lobby.state, 'cs-manche-end');

    // Manche 3 : l'autre équipe commence (la 1re a joué le dernier tour), puis fin
    lobby.nextQuestion(host);
    assert.notEqual(cs.turnTeam, firstTeam);
    playTurn(8);
    assert.equal(lobby.state, 'cs-manche-end');
    lobby.nextQuestion(host);
    assert.equal(lobby.state, 'finished');
    const final = lobby.publicState(host).game.final;
    assert.equal(final.recap.length, 3);
    assert.equal(final.cs.totals[firstTeam], 5 + 8);
    assert.equal(final.cs.totals[firstTeam === 'rouge' ? 'bleu' : 'rouge'], 3 + 0 + 8);
    assert.equal(final.cs.winner, firstTeam);
  } finally {
    mock.timers.reset();
  }
});

test('Chrono Stars : rotation, joueur absent, hôte et réglages', () => {
  const { lobby, players, cs } = setup(4);
  try {
    const host = lobby.hostId;
    const team = cs.turnTeam;
    const first = cs.clueur;
    // Celui qui doit faire deviner se déconnecte : son coéquipier le remplace
    lobby.markDisconnected(first, lobby.players.get(first).socketId);
    assert.equal(lobby.state, 'cs-ready');
    assert.equal(cs.turnTeam, team);
    assert.notEqual(cs.clueur, first);
    const hostNow = lobby.hostId;
    // L'hôte passe un joueur
    lobby.forceReveal(hostNow);
    assert.equal(lobby.state, 'cs-ready');
    // En plein tour, celui qui fait deviner part : le tour s'arrête
    lobby.csGo(cs.clueur);
    const leaving = cs.clueur;
    lobby.markDisconnected(leaving, lobby.players.get(leaving).socketId);
    assert.equal(lobby.state, 'cs-ready');
    assert.equal(cs.lastTurn.reason, 'left');

    lobby.backToLobby(lobby.hostId);
    const h2 = lobby.hostId;
    expectError(() => lobby.setSettings(h2, { csCards: 25 }), 'INVALID_SETTINGS');
    expectError(() => lobby.setSettings(h2, { csCategories: [] }), 'INVALID_SETTINGS');
    lobby.setSettings(h2, { csCards: 40, csTimer: 60, csCategories: ['fiction'] });
    assert.deepEqual(lobby.settings.chronoStars, { cards: 40, timer: 60, categories: ['fiction'] });
    void host;
    void players;
  } finally {
    mock.timers.reset();
  }
});
