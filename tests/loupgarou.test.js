import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../src/game/Lobby.js';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { composition, recommend } from '../src/loupgarou/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const NAMES = ['Ana', 'Bob', 'Cléo', 'Dan', 'Eva', 'Fab', 'Gus', 'Hugo'];

// Partie avec des rôles imposés (dans l'ordre des joueurs) pour des tests prévisibles.
function setup(roles, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']) });
  const lobby = manager.create();
  const players = roles.map((_, i) => lobby.addPlayer(NAMES[i], `s${i}`));
  lobby.setMode(players[0].id, 'loup-garou');
  lobby.setSettings(players[0].id, { lgMayor: false, lgNight: 20, lgDebate: 60, ...settings });
  lobby.startGame(players[0].id);
  const lg = lobby.game.lg;
  lg.roles = new Map(players.map((p, i) => [p.id, roles[i]]));
  lg.composition = roles.reduce((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
  const by = Object.fromEntries(roles.map((r, i) => [r + (roles.slice(0, i).filter((x) => x === r).length || ''), players[i]]));
  return { lobby, players, lg, by };
}
const view = (lobby, p) => lobby.publicState(p.id).game.loupGarou;
const act = (lobby, p, payload) => lobby.lgAct(p.id, payload);
const tick = (ms) => mock.timers.tick(ms);

test('Loup-Garou : recommandations et composition', () => {
  assert.deepEqual(recommend(5), { loup: 1, voyante: 1, sorciere: 1, chasseur: 1 });
  assert.equal(recommend(8).loup, 2);
  assert.equal(recommend(12).loup, 3);
  for (let n = 5; n <= 18; n += 1) {
    const { roles, problem } = composition(n, null);
    assert.equal(problem, null, `composition recommandée invalide pour ${n}`);
    assert.equal(Object.values(roles).reduce((a, b) => a + b, 0), n);
  }
  assert.match(composition(4, null).problem, /au moins 5/);
  assert.match(composition(6, { loup: 3 }).problem, /Trop de loups/);
  assert.match(composition(5, { loup: 1, voyante: 1, sorciere: 1, chasseur: 1, cupidon: 1, salvateur: 1 }).problem, /Trop de rôles/);
});

test('Loup-Garou : réglages de l’hôte et lancement refusé si la composition est mauvaise', () => {
  const lobby = new Lobby('ABCDE', { questionBank: createQuestionBank(['Q ?']) });
  const players = NAMES.slice(0, 5).map((n, i) => lobby.addPlayer(n, `s${i}`));
  lobby.setMode(players[0].id, 'loup-garou');
  const limits = lobby.publicState(players[0].id).limits.loupGarou;
  assert.equal(limits.players, 5);
  assert.deepEqual(limits.recommended, { loup: 1, voyante: 1, sorciere: 1, chasseur: 1, villageois: 1 });
  expectError(() => lobby.setSettings(players[1].id, { lgMayor: false }), 'NOT_HOST');
  lobby.setSettings(players[0].id, { lgCustom: { loup: 3 } });
  expectError(() => lobby.startGame(players[0].id), 'INVALID_COMPOSITION');
  lobby.setSettings(players[0].id, { lgCustom: null });
  lobby.startGame(players[0].id);
  assert.equal(lobby.state, 'lg-reveal');
  lobby.backToLobby(players[0].id);
});

test('Loup-Garou : chacun ne voit que son rôle, les loups se connaissent', () => {
  const { lobby, by } = setup(['loup', 'loup', 'voyante', 'villageois', 'villageois', 'sorciere']);
  try {
    const v = view(lobby, by.villageois);
    assert.deepEqual(Object.keys(v.known), [by.villageois.id]);
    assert.equal(v.me.role, 'villageois');
    const w = view(lobby, by.loup);
    assert.equal(w.known[by.loup1.id], 'loup');
    assert.deepEqual(w.me.teammates, [by.loup1.id]);
    assert.equal(JSON.stringify(view(lobby, by.villageois)).includes('"loup"'), true, 'la composition est publique');
    assert.equal(Object.values(view(lobby, by.villageois).known).includes('voyante'), false);
  } finally {
    mock.timers.reset();
  }
});

test('Loup-Garou : une nuit complète (voyante, loups, sorcière qui sauve), puis le jour', () => {
  const { lobby, lg, by } = setup(['loup', 'voyante', 'sorciere', 'villageois', 'villageois']);
  try {
    tick(10_000); // révélation des rôles
    assert.equal(lobby.state, 'lg-night');
    assert.equal(lg.step, 'voyante');
    expectError(() => act(lobby, by.loup, { type: 'wolf-vote', target: by.villageois.id }), 'NOT_YOUR_TURN');
    act(lobby, by.voyante, { type: 'see', target: by.loup.id });
    assert.equal(view(lobby, by.voyante).known[by.loup.id], 'loup');
    assert.equal(view(lobby, by.villageois).known[by.loup.id], undefined);
    tick(4_000);
    assert.equal(lg.step, 'loups');
    expectError(() => act(lobby, by.loup, { type: 'wolf-vote', target: by.loup.id }), 'INVALID_TARGET');
    act(lobby, by.loup, { type: 'wolf-vote', target: by.villageois.id });
    assert.equal(lg.step, 'sorciere', 'loup unique d’accord avec lui-même : on passe');
    assert.equal(view(lobby, by.sorciere).me.witch.victim, by.villageois.id);
    assert.equal(view(lobby, by.villageois).me.witch, null);
    act(lobby, by.sorciere, { type: 'witch', save: true });
    assert.equal(lobby.state, 'lg-dawn');
    assert.deepEqual(lg.announce.deaths, []);
    expectError(() => act(lobby, by.sorciere, { type: 'witch', save: true }), 'NOT_YOUR_TURN');
    tick(8_000);
    assert.equal(lobby.state, 'lg-debate');
    tick(60_000);
    assert.equal(lobby.state, 'lg-vote');
  } finally {
    mock.timers.reset();
  }
});

test('Loup-Garou : vote du village, victoire du village', () => {
  const { lobby, lg, players, by } = setup(['loup', 'voyante', 'villageois', 'villageois', 'villageois']);
  try {
    tick(10_000);
    act(lobby, by.voyante, { type: 'see', target: by.loup.id });
    tick(4_000);
    act(lobby, by.loup, { type: 'wolf-vote', target: by.villageois.id });
    assert.equal(lobby.state, 'lg-dawn');
    assert.equal(lg.announce.deaths[0].id, by.villageois.id);
    assert.equal(view(lobby, by.villageois1).known[by.villageois.id], 'villageois', 'rôle du mort révélé');
    expectError(() => lobby.lgChat(by.villageois.id, { channel: 'village', text: 'coucou' }), 'CHAT_CLOSED');
    lobby.lgChat(by.villageois.id, { channel: 'dead', text: 'je suis mort' });
    assert.equal(view(lobby, by.voyante).chats.dead, undefined);
    tick(8_000);
    lobby.lgChat(by.voyante.id, { channel: 'village', text: 'Ana est loup !' });
    lobby.forceReveal(players[0].id); // l'hôte écourte le débat
    assert.equal(lobby.state, 'lg-vote');
    for (const p of players) if (lg.alive.has(p.id)) act(lobby, p, { type: 'vote', target: p === by.loup ? by.voyante.id : by.loup.id });
    assert.equal(lobby.state, 'lg-verdict');
    tick(8_000);
    assert.equal(lobby.state, 'finished');
    assert.equal(lobby.game.final.lg.winner, 'village');
    assert.equal(lobby.game.final.ranking[0].total, 1);
  } finally {
    mock.timers.reset();
  }
});

test('Loup-Garou : Cupidon, amoureux qui meurent ensemble, chasseur qui tire', () => {
  const { lobby, lg, by } = setup(['loup', 'cupidon', 'chasseur', 'villageois', 'villageois', 'loup']);
  try {
    tick(10_000);
    assert.equal(lg.step, 'cupidon');
    act(lobby, by.cupidon, { type: 'cupid', targets: [by.chasseur.id, by.villageois.id] });
    assert.deepEqual(view(lobby, by.chasseur).lovers, [by.chasseur.id, by.villageois.id]);
    assert.equal(view(lobby, by.villageois1).lovers, null);
    assert.equal(lg.step, 'loups');
    act(lobby, by.loup, { type: 'wolf-vote', target: by.villageois.id });
    assert.equal(lg.step, 'loups', 'il faut l’accord des deux loups');
    act(lobby, by.loup1, { type: 'wolf-vote', target: by.villageois.id });
    assert.equal(lobby.state, 'lg-dawn');
    assert.deepEqual(lg.lastDeaths.map((d) => d.cause), ['loups', 'chagrin']);
    tick(8_000);
    assert.equal(lobby.state, 'lg-hunter');
    assert.deepEqual(view(lobby, by.loup).actors, [by.chasseur.id]);
    act(lobby, by.chasseur, { type: 'shoot', target: by.loup.id });
    assert.equal(lg.alive.has(by.loup.id), false);
    assert.equal(lobby.state, 'lg-debate');
  } finally {
    mock.timers.reset();
  }
});

test('Loup-Garou : salvateur, ancien coriace, idiot du village, maire à voix double', () => {
  const { lobby, lg, players, by } = setup(['loup', 'salvateur', 'ancien', 'idiot', 'villageois', 'villageois', 'loup'], { lgMayor: true });
  try {
    tick(10_000);
    act(lobby, by.salvateur, { type: 'protect', target: by.villageois.id });
    act(lobby, by.loup, { type: 'wolf-vote', target: by.villageois.id });
    act(lobby, by.loup1, { type: 'wolf-vote', target: by.villageois.id });
    assert.deepEqual(lg.announce.deaths, [], 'protégé par le salvateur');
    tick(8_000);
    assert.equal(lobby.state, 'lg-mayor');
    for (const p of players) act(lobby, p, { type: 'vote', target: by.idiot.id });
    assert.equal(lg.mayorId, by.idiot.id);
    assert.equal(lobby.state, 'lg-debate');
    lobby.forceReveal(players[0].id);
    // Le maire (l'idiot) vote, sa voix compte double ; égalité 2-2 sinon.
    act(lobby, by.idiot, { type: 'vote', target: by.villageois1.id });
    act(lobby, by.loup, { type: 'vote', target: by.idiot.id });
    act(lobby, by.loup1, { type: 'vote', target: by.idiot.id });
    act(lobby, by.salvateur, { type: 'vote', target: by.villageois1.id });
    act(lobby, by.ancien, { type: 'vote', target: by.idiot.id });
    act(lobby, by.villageois, { type: 'vote', target: by.idiot.id });
    act(lobby, by.villageois1, { type: 'vote', target: by.idiot.id });
    assert.equal(lobby.state, 'lg-verdict');
    assert.equal(lg.announce.idiot, true, 'l’idiot est épargné');
    assert.equal(lg.alive.has(by.idiot.id), true);
    assert.equal(view(lobby, by.villageois).known[by.idiot.id], 'idiot');
    tick(8_000);
    // Nuit 2 : le salvateur ne peut pas protéger deux fois le même
    expectError(() => act(lobby, by.salvateur, { type: 'protect', target: by.villageois.id }), 'INVALID_TARGET');
    act(lobby, by.salvateur, { type: 'skip' });
    act(lobby, by.loup, { type: 'wolf-vote', target: by.ancien.id });
    act(lobby, by.loup1, { type: 'wolf-vote', target: by.ancien.id });
    assert.equal(lg.alive.has(by.ancien.id), true, 'l’ancien survit à la 1re attaque');
    tick(8_000);
    lobby.forceReveal(players[0].id);
    expectError(() => act(lobby, by.idiot, { type: 'vote', target: by.loup.id }), 'NO_VOTE');
  } finally {
    mock.timers.reset();
  }
});

test('Loup-Garou : chat des loups secret, petite fille sans les pseudos, vidé chaque nuit', () => {
  const { lobby, lg, by } = setup(['loup', 'petite-fille', 'villageois', 'villageois', 'villageois']);
  try {
    tick(10_000);
    assert.equal(lg.step, 'loups');
    lobby.lgChat(by.loup.id, { channel: 'wolves', text: 'on mange Cléo ?' });
    expectError(() => lobby.lgChat(by.villageois.id, { channel: 'wolves', text: 'je triche' }), 'CHAT_CLOSED');
    expectError(() => lobby.lgChat(by.villageois.id, { channel: 'village', text: 'la nuit' }), 'CHAT_CLOSED');
    assert.equal(view(lobby, by.villageois).chats.wolves, undefined);
    const spy = view(lobby, by['petite-fille']).chats.wolves;
    assert.equal(spy[0].text, 'on mange Cléo ?');
    assert.equal(spy[0].from, null, 'la petite fille ne voit pas qui écrit');
    assert.equal(view(lobby, by.loup).chats.wolves[0].from, by.loup.id);
    act(lobby, by.loup, { type: 'wolf-vote', target: by.villageois.id });
    tick(8_000);
    lobby.forceReveal(lobby.hostId);
    lobby.forceReveal(lobby.hostId); // vote sans voix : personne ne sort
    tick(8_000);
    assert.equal(lobby.state, 'lg-night');
    assert.equal(lg.chat.wolves.length, 0, 'chat des loups vidé à la nouvelle nuit');
  } finally {
    mock.timers.reset();
  }
});

test('Loup-Garou : les loups gagnent quand il n’y a plus de villageois ; rôles morts = faux tour', () => {
  const { lobby, lg, by } = setup(['loup', 'voyante', 'villageois', 'villageois', 'loup']);
  try {
    tick(10_000);
    act(lobby, by.voyante, { type: 'see', target: by.loup.id });
    tick(4_000);
    act(lobby, by.loup, { type: 'wolf-vote', target: by.voyante.id });
    act(lobby, by.loup1, { type: 'wolf-vote', target: by.voyante.id });
    tick(8_000);
    lobby.forceReveal(lobby.hostId);
    act(lobby, by.loup, { type: 'vote', target: by.villageois.id });
    act(lobby, by.loup1, { type: 'vote', target: by.villageois.id });
    act(lobby, by.villageois, { type: 'vote', target: by.loup.id });
    act(lobby, by.villageois1, { type: 'vote', target: by.villageois.id });
    tick(8_000);
    assert.equal(lg.step, 'voyante', 'la voyante morte : faux tour quand même');
    assert.deepEqual(lg.actors, []);
    tick(7_000);
    act(lobby, by.loup, { type: 'wolf-vote', target: by.villageois1.id });
    act(lobby, by.loup1, { type: 'wolf-vote', target: by.villageois1.id });
    tick(8_000);
    assert.equal(lobby.state, 'finished');
    assert.equal(lobby.game.final.lg.winner, 'loups');
  } finally {
    mock.timers.reset();
  }
});
