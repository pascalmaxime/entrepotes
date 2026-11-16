import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { clashes, createWordBank, getBank, norm } from '../src/nomdecode/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const WORDS = Array.from({ length: 30 }, (_, i) => `mot${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);

function setup(n = 4, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  lobby.cnBank = createWordBank(WORDS);
  const players = ['Ana', 'Bob', 'Cléo', 'Dan', 'Eva', 'Fred'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'nom-de-code');
  if (Object.keys(settings).length) lobby.setSettings(players[0].id, settings);
  lobby.startGame(players[0].id);
  return { lobby, players, cn: lobby.game.cn };
}
const view = (lobby, id) => lobby.publicState(id).game.nomDeCode;
const roles = (cn, team) => {
  const members = [...cn.teamOf].filter(([, t]) => t === team).map(([id]) => id);
  return { spy: cn.spies[team], agents: members.filter((id) => id !== cn.spies[team]) };
};
const cardOf = (cn, type) => cn.board.findIndex((c) => c.type === type && !c.revealed);
const other = (t) => (t === 'rouge' ? 'bleu' : 'rouge');

test('Nom de code : un indice ne peut pas être (une forme d’)un mot de la grille', () => {
  assert.equal(clashes('Chevaux', 'cheval'), true);
  assert.equal(clashes('étoiles', 'Étoile'), true);
  assert.equal(clashes('pommier', 'pomme'), true);
  assert.equal(clashes('million', 'lion'), false);
  assert.equal(clashes('mercure', 'mer'), false);
  assert.equal(norm('Bœuf'), 'boeuf');
});

test('Nom de code : la liste de mots fournie est valide', () => {
  const bank = getBank();
  assert.ok(bank.size >= 400);
  const used = new Set();
  const a = bank.pick(25, used);
  const b = bank.pick(25, used);
  assert.equal(new Set([...a, ...b].map(norm)).size, 50, 'pas de mot répété d’une grille à l’autre');
  for (const w of a) assert.ok(!/\s/.test(w), w);
});

test('Nom de code : équipes, clé secrète, indice, votes à la majorité', () => {
  const { lobby, players, cn } = setup(5, { cnRounds: 1 });
  try {
    assert.equal(lobby.state, 'cn-clue');
    const starter = cn.starter;
    assert.equal(cn.turn, starter);
    // 9 mots pour l'équipe qui commence, 8 pour l'autre, 7 neutres, 1 assassin
    const count = (t) => cn.board.filter((c) => c.type === t).length;
    assert.deepEqual([count(starter), count(other(starter)), count('neutre'), count('assassin')], [9, 8, 7, 1]);
    // 5 joueurs : 2 dans l'équipe qui commence, 3 dans l'autre
    const S = roles(cn, starter);
    const O = roles(cn, other(starter));
    assert.equal(S.agents.length, 1);
    assert.equal(O.agents.length, 2);

    // La clé n'est envoyée qu'aux espions.
    const agentView = view(lobby, S.agents[0]);
    assert.ok(agentView.board.every((c) => c.type === null));
    assert.ok(!JSON.stringify(lobby.publicState(O.agents[0])).includes('assassin'));
    assert.ok(view(lobby, S.spy).board.every((c) => c.type !== null));
    assert.ok(view(lobby, O.spy).mySpy);

    // Indices refusés
    expectError(() => lobby.cnClue(S.agents[0], { word: 'mer', count: 2 }), 'NOT_SPY');
    expectError(() => lobby.cnClue(O.spy, { word: 'mer', count: 2 }), 'NOT_SPY');
    expectError(() => lobby.cnClue(S.spy, { word: 'deux mots', count: 2 }), 'ONE_WORD');
    expectError(() => lobby.cnClue(S.spy, { word: '42', count: 2 }), 'INVALID_CLUE');
    expectError(() => lobby.cnClue(S.spy, { word: 'mer', count: 0 }), 'INVALID_COUNT');
    expectError(() => lobby.cnClue(S.spy, { word: cn.board[0].word.toUpperCase(), count: 1 }), 'CLUE_ON_BOARD');
    expectError(() => lobby.cnPick(S.agents[0], { card: 0 }), 'NOT_NOW');

    lobby.cnClue(S.spy, { word: 'Océan', count: 1 });
    assert.equal(lobby.state, 'cn-guess');
    assert.equal(view(lobby, S.agents[0]).clue.word, 'Océan');
    assert.equal(cn.guessesLeft, 2);
    expectError(() => lobby.cnPick(S.spy, { card: 0 }), 'SPY_NO_TOUCH');
    expectError(() => lobby.cnPick(O.agents[0], { card: 0 }), 'NOT_YOUR_TURN');

    // Un seul agent : son choix suffit. Bon mot → il continue (droit à 2 mots).
    lobby.cnPick(S.agents[0], { card: cardOf(cn, starter) });
    assert.equal(lobby.state, 'cn-guess');
    assert.equal(cn.guessesLeft, 1);
    assert.equal(view(lobby, O.agents[0]).remaining[starter], 8);
    // Un mot neutre : fin du tour
    lobby.cnPick(S.agents[0], { card: cardOf(cn, 'neutre') });
    assert.equal(lobby.state, 'cn-clue');
    assert.equal(cn.turn, other(starter));

    // Équipe de 2 agents : il faut qu'ils soient d'accord.
    lobby.cnClue(O.spy, { word: 'Forêt', count: 3 });
    const target = cardOf(cn, other(starter));
    lobby.cnPick(O.agents[0], { card: target });
    assert.equal(cn.board[target].revealed, false, 'un seul vote sur deux ne suffit pas');
    assert.deepEqual(view(lobby, S.spy).votes, [{ playerId: O.agents[0], card: target }]);
    lobby.cnPick(O.agents[0], { card: target }); // retoucher = annuler
    assert.equal(cn.votes.size, 0);
    lobby.cnPick(O.agents[0], { card: 'pass' });
    lobby.cnPick(O.agents[1], { card: target });
    assert.equal(cn.board[target].revealed, false, 'désaccord : rien ne se passe');
    lobby.cnPick(O.agents[0], { card: target });
    assert.equal(cn.board[target].revealed, true);
    // Les deux votent pour finir le tour
    lobby.cnPick(O.agents[0], { card: 'pass' });
    lobby.cnPick(O.agents[1], { card: 'pass' });
    assert.equal(lobby.state, 'cn-clue');
    assert.equal(cn.turn, starter);
    assert.equal(cn.log.length, 2);
    assert.deepEqual(cn.log[1].picks.map((p) => p.type), [other(starter)]);
  } finally {
    mock.timers.reset();
  }
});

test('Nom de code : l’assassin fait perdre, points et fin de partie', () => {
  const { lobby, players, cn } = setup(4, { cnRounds: 2 });
  try {
    const starter = cn.starter;
    const S = roles(cn, starter);
    const O = roles(cn, other(starter));
    lobby.cnClue(S.spy, { word: 'Mystère', count: 2 });
    lobby.cnPick(S.agents[0], { card: cardOf(cn, starter) });
    lobby.cnPick(S.agents[0], { card: cardOf(cn, 'assassin') });
    assert.equal(lobby.state, 'cn-end');
    const result = view(lobby, S.agents[0]).result;
    assert.equal(result.winner, other(starter));
    assert.equal(result.reason, 'assassin');
    // Fin de manche : tout le monde voit la clé
    assert.ok(view(lobby, S.agents[0]).board.every((c) => c.type !== null));
    // Perdants : 1 mot trouvé → 1 pt ; gagnants : 0 mot + 5 de victoire
    assert.equal(lobby.game.totals[S.agents[0]], 1);
    assert.equal(lobby.game.totals[O.agents[0]], 5);
    const firstSpies = new Set([S.spy, O.spy]);

    // Manche 2 : nouvelle grille, l'autre équipe commence, les espions changent
    lobby.nextQuestion(players[0].id);
    assert.equal(lobby.state, 'cn-clue');
    assert.equal(cn.starter, other(starter));
    assert.equal(lobby.publicState(players[0].id).game.round, 2);
    const spies2 = new Set([cn.spies.rouge, cn.spies.bleu]);
    assert.equal([...spies2].filter((id) => firstSpies.has(id)).length, 0, 'chacun son tour d’être espion');

    // Victoire en trouvant tous ses mots (l'équipe adverse peut aussi donner le dernier mot)
    const T = roles(cn, cn.starter);
    for (const card of cn.board) if (card.type === cn.starter) card.revealed = true;
    cn.board.find((c) => c.type === cn.starter).revealed = false;
    lobby.cnClue(T.spy, { word: 'Final', count: 1 });
    lobby.cnPick(T.agents[0], { card: cardOf(cn, cn.starter) });
    assert.equal(lobby.state, 'cn-end');
    assert.equal(cn.result.reason, 'all');
    lobby.nextQuestion(players[0].id);
    assert.equal(lobby.state, 'finished');
    const final = lobby.publicState(players[0].id).game.final;
    assert.equal(final.recap.length, 2);
    assert.equal(final.ranking.length, 4);
  } finally {
    mock.timers.reset();
  }
});

test('Nom de code : chrono, hôte, déconnexions et réglages', () => {
  const { lobby, players, cn } = setup(4, { cnTimer: 60 });
  try {
    const host = players[0];
    const starter = cn.starter;
    // Chrono écoulé sans indice : la main passe
    assert.ok(view(lobby, host.id).deadline);
    mock.timers.tick(61_500);
    assert.equal(cn.turn, other(starter));
    // L'hôte fait passer le tour
    lobby.forceReveal(host.id);
    assert.equal(cn.turn, starter);
    // L'espion se déconnecte : un coéquipier devient espion
    const S = roles(cn, starter);
    lobby.markDisconnected(S.spy, lobby.players.get(S.spy).socketId);
    assert.equal(cn.spies[starter], S.agents[0]);
    // L'équipe n'a plus d'agent : après l'indice, le tour passe tout seul
    lobby.cnClue(S.agents[0], { word: 'Solo', count: 1 });
    assert.equal(lobby.state, 'cn-clue');
    assert.equal(cn.turn, other(starter));

    // Réglages (l'hôte a pu changer si c'est lui qui s'est déconnecté)
    const hostId = lobby.hostId;
    lobby.backToLobby(hostId);
    expectError(() => lobby.setSettings(hostId, { cnRounds: 9 }), 'INVALID_SETTINGS');
    expectError(() => lobby.setSettings(hostId, { cnTimer: 45 }), 'INVALID_SETTINGS');
    lobby.setSettings(hostId, { cnRounds: 3, cnTimer: 0 });
    assert.deepEqual(lobby.settings.nomDeCode, { rounds: 3, timer: 0 });
    assert.equal(lobby.publicState(hostId).limits.nomDeCode.minPlayers, 4);
  } finally {
    mock.timers.reset();
  }
});

test('Nom de code : il faut 4 joueurs', () => {
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  const players = ['Ana', 'Bob', 'Cléo'].map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'nom-de-code');
  expectError(() => lobby.startGame(players[0].id), 'NOT_ENOUGH_PLAYERS');
});
