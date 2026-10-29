import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager } from '../src/game/LobbyManager.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { GameError } from '../src/game/errors.js';
import { createPaintWords } from '../src/paint/engine.js';
import { carnetIndex, sanitizeOps, stepCount } from '../src/coqane/engine.js';

const expectError = (fn, code) => assert.throws(fn, (err) => err instanceof GameError && err.code === code);
const words = () => createPaintWords({ facile: ['chat', 'chien', 'vache', 'lion', 'poule'], moyen: ['hérisson', 'castor', 'koala', 'panda', 'loup'], difficile: ['nostalgie', 'jalousie', 'ennui', 'rêve', 'secret'] });
const stroke = (id) => ({ t: 's', id, tool: 'pen', color: '#000000', size: 8, pts: [10, 10, 50, 50] });

function setup(n = 4, settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const manager = new LobbyManager({ questionBank: createQuestionBank(['Q ?']), paintWords: words() });
  const lobby = manager.create();
  const players = ['Ana', 'Bob', 'Cléo', 'Dan', 'Eva'].slice(0, n).map((name, i) => lobby.addPlayer(name, `s${i}`));
  lobby.setMode(players[0].id, 'coq-ane');
  lobby.setSettings(players[0].id, { ccDraw: 45, ccGuess: 20, ccDifficulty: 'facile', ...settings });
  lobby.startGame(players[0].id);
  return { lobby, players, cc: lobby.game.cc };
}
const task = (lobby, p) => lobby.publicState(p.id).game.coqAne.task;

test('Du coq à l’âne : nombre d’étapes (on finit toujours par une devinette)', () => {
  assert.equal(stepCount(4), 4);
  assert.equal(stepCount(5), 4);
  assert.equal(stepCount(3), 2);
  assert.deepEqual(sanitizeOps([{ t: 's', id: 'a', tool: 'laser', color: '#000000', pts: [1, 2] }, { t: 'c' }, { t: 'f', x: 9999, y: 1, color: '#FF0000' }]), [{ t: 'c' }, { t: 'f', x: 799, y: 1, color: '#ff0000' }]);
});

test('Du coq à l’âne : les carnets tournent, chacun ne voit que la page d’avant', () => {
  const { lobby, players, cc } = setup(4);
  try {
    // Étape 0 : chacun dessine le mot de son propre carnet.
    for (const p of players) {
      const t = task(lobby, p);
      assert.equal(t.kind, 'draw');
      assert.equal(t.word, cc.carnets[carnetIndex(cc, p.id)].word);
      assert.equal(cc.carnets[carnetIndex(cc, p.id)].ownerId, p.id);
    }
    const words = cc.carnets.map((c) => c.word);
    const seen = JSON.stringify(lobby.publicState(players[0].id));
    assert.equal(words.filter((w) => seen.includes(`"${w}"`)).length, 1, 'je ne vois que mon mot');
    expectError(() => lobby.ccSubmit(players[0].id, { step: 1, ops: [] }), 'TOO_LATE');
    players.forEach((p, i) => lobby.ccSubmit(p.id, { step: 0, ops: [stroke(`s${i}`)] }));
    assert.equal(cc.step, 1);

    // Étape 1 : on devine le dessin du voisin (sans voir le mot).
    for (const p of players) {
      const t = task(lobby, p);
      assert.equal(t.kind, 'guess');
      assert.equal(t.word, null);
      assert.equal(t.ops.length, 1);
      assert.notEqual(t.fromId, p.id);
      assert.notEqual(cc.carnets[carnetIndex(cc, p.id)].ownerId, p.id, 'carnet du voisin');
    }
    expectError(() => lobby.ccSubmit(players[0].id, { step: 1, text: '  ' }), 'EMPTY');
    // Chacun devine juste le mot du carnet qu'il tient.
    for (const p of players) lobby.ccSubmit(p.id, { step: 1, text: cc.carnets[carnetIndex(cc, p.id)].word.toUpperCase() });
    expectError(() => lobby.ccSubmit(players[0].id, { step: 1, text: 'x' }), 'TOO_LATE');

    // Étape 2 : on dessine la devinette précédente.
    const t2 = task(lobby, players[0]);
    assert.equal(t2.kind, 'draw');
    assert.equal(t2.text, cc.carnets[carnetIndex(cc, players[0].id)].word.toUpperCase());
    players.forEach((p, i) => lobby.ccSubmit(p.id, { step: 2, ops: [stroke(`t${i}`)] }));
    // Étape 3 (dernière) : devinette finale, la moitié se trompe.
    players.forEach((p, i) => lobby.ccSubmit(p.id, { step: 3, text: i % 2 ? 'raté' : cc.carnets[carnetIndex(cc, p.id)].word }));
    assert.equal(lobby.state, 'cc-reveal');
    assert.equal(cc.carnets.every((c) => c.pages.length === 4), true);
    assert.equal(cc.carnets.filter((c) => c.success).length, 2);
  } finally {
    mock.timers.reset();
  }
});

test('Du coq à l’âne : révélation page par page, points, fin', () => {
  const { lobby, players, cc } = setup(3);
  try {
    players.forEach((p, i) => lobby.ccSubmit(p.id, { step: 0, ops: [stroke(`s${i}`)] }));
    players.forEach((p) => lobby.ccSubmit(p.id, { step: 1, text: cc.carnets[carnetIndex(cc, p.id)].word }));
    assert.equal(lobby.state, 'cc-reveal');
    let r = lobby.publicState(players[1].id).game.coqAne.reveal;
    assert.equal(r.shown, 0);
    assert.equal(r.visible.length, 0, 'aucune page envoyée avant d’être dévoilée');
    expectError(() => lobby.nextQuestion(players[1].id), 'NOT_HOST');
    lobby.nextQuestion(players[0].id);
    r = lobby.publicState(players[1].id).game.coqAne.reveal;
    assert.equal(r.visible.length, 1);
    assert.equal(r.visible[0].kind, 'draw');
    lobby.ccRevealAll(players[0].id);
    r = lobby.publicState(players[1].id).game.coqAne.reveal;
    assert.equal(r.success, true);
    // 3 carnets : on les termine tous
    for (let i = 0; i < 10 && lobby.state === 'cc-reveal'; i += 1) lobby.nextQuestion(players[0].id);
    assert.equal(lobby.state, 'finished');
    // Chaque devinette juste : 1 pt au devineur + 1 pt au dessinateur → 2 pts chacun ici
    assert.deepEqual(lobby.game.final.ranking.map((e) => e.total), [2, 2, 2]);
    assert.equal(lobby.game.final.cc.success, 3);
  } finally {
    mock.timers.reset();
  }
});

test('Du coq à l’âne : chrono écoulé et joueur absent → pages « … », la partie continue', () => {
  const { lobby, players, cc } = setup(4);
  try {
    lobby.markDisconnected(players[3].id, 's3');
    players.slice(0, 3).forEach((p, i) => lobby.ccSubmit(p.id, { step: 0, ops: [stroke(`s${i}`)] }));
    assert.equal(cc.step, 1, 'on n’attend pas le joueur déconnecté');
    assert.equal(cc.carnets[carnetIndex(cc, players[3].id, 0)].pages[0].missed, true);
    mock.timers.tick(20_000 + 2_000);
    assert.equal(cc.step, 2, 'chrono écoulé : les carnets tournent quand même');
    assert.equal(cc.carnets.every((c) => c.pages[1].text === '…'), true);
    lobby.forceReveal(players[0].id);
    assert.equal(cc.step, 3);
  } finally {
    mock.timers.reset();
  }
});
