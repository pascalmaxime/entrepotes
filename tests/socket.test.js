import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { createQuestionBank } from '../src/game/questionBank.js';
import { gradient, makeJpeg, tempLibrary } from './helpers.js';

const ADMIN = { user: 'admin', password: 'secret-de-test' };
let server;
let url;

before(async () => {
  server = createApp({
    questionBank: createQuestionBank(['Question A ?', 'Question B ?', 'Question C ?']),
    memeLibrary: tempLibrary(),
    admin: ADMIN,
  });
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(() => new Promise((resolve) => server.io.close(resolve)));

function client() {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.states = [];
  socket.on('lobby:state', (state) => socket.states.push(state));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const call = (socket, event, payload = {}) => socket.timeout(2000).emitWithAck(event, payload);
const last = (socket) => socket.states.at(-1);

async function waitFor(predicate, timeout = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Délai dépassé');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('HTTP : santé, version et modes', async () => {
  assert.equal((await (await fetch(`${url}/health`)).json()).status, 'ok');
  const version = await (await fetch(`${url}/api/version`)).json();
  assert.equal(typeof version.version, 'string');
  assert.ok(Array.isArray(version.notes));
  const modes = await (await fetch(`${url}/api/modes`)).json();
  assert.deepEqual(modes.map((m) => m.id), ['qui-de-nous', 'tier-list', 'top-meme', 'm-culture', 'imposteur', 'juste-prix', 'paint', 'loup-garou', 'tic-tac-boum', 'coq-ane']);
  assert.ok(modes.every((m) => m.available));
});

test('partie complète Tier List à 3 joueurs', async () => {
  const sockets = await Promise.all([client(), client(), client()]);
  const [alice, bob, chloe] = sockets;
  try {
    const created = await call(alice, 'lobby:create', { name: 'Alice', mode: 'tier-list' });
    assert.equal(created.ok, true);
    const joinBob = await call(bob, 'lobby:join', { code: created.code.toLowerCase(), name: 'Bob' });
    const joinChloe = await call(chloe, 'lobby:join', { code: created.code, name: 'Chloé' });
    assert.ok(joinBob.ok && joinChloe.ok);

    assert.equal((await call(bob, 'game:start')).error, 'NOT_HOST');
    assert.equal((await call(alice, 'lobby:set-settings', { rounds: 1 })).ok, true);
    assert.equal((await call(alice, 'game:start')).ok, true);
    await waitFor(() => last(chloe)?.state === 'question');

    const [a, b, c] = [created.playerId, joinBob.playerId, joinChloe.playerId];
    assert.equal((await call(bob, 'game:vote', { vote: [a] })).error, 'INVALID_VOTE');
    await call(alice, 'game:vote', { vote: [b, a, c] });
    await call(bob, 'game:vote', { vote: [b, c, a] });
    await call(chloe, 'game:vote', { vote: [a, b, c] });

    await waitFor(() => last(alice)?.state === 'results');
    assert.equal(last(alice).game.result.ranking[0].playerId, b);

    await call(alice, 'game:next');
    await waitFor(() => last(bob)?.state === 'finished');
    assert.equal(last(bob).game.final.ranking[0].playerId, b);
  } finally {
    sockets.forEach((s) => s.disconnect());
  }
});

test('reconnexion avec le jeton après une coupure', async () => {
  const host = await client();
  const guest = await client();
  let again;
  try {
    const created = await call(host, 'lobby:create', { name: 'Hôte' });
    const joined = await call(guest, 'lobby:join', { code: created.code, name: 'Invité' });
    const guestState = () => last(host)?.players.find((p) => p.id === joined.playerId);

    guest.disconnect();
    await waitFor(() => guestState()?.connected === false);

    again = await client();
    const res = await call(again, 'lobby:rejoin', { code: created.code, playerId: joined.playerId, token: joined.token });
    assert.equal(res.ok, true);
    await waitFor(() => guestState()?.connected === true);

    const bad = await call(again, 'lobby:rejoin', { code: created.code, playerId: joined.playerId, token: 'mauvais' });
    assert.equal(bad.error, 'RECONNECT_FAILED');
  } finally {
    host.disconnect();
    again?.disconnect();
  }
});

test('le dernier joueur qui quitte supprime la partie', async () => {
  const solo = await client();
  try {
    const created = await call(solo, 'lobby:create', { name: 'Solo' });
    assert.ok(server.manager.get(created.code));
    await call(solo, 'lobby:leave');
    assert.equal(server.manager.get(created.code), null);
    assert.equal((await call(solo, 'lobby:join', { code: created.code, name: 'Solo' })).error, 'LOBBY_NOT_FOUND');
  } finally {
    solo.disconnect();
  }
});

test('envoi d’images réservé aux joueurs d’une partie', async () => {
  const player = await client();
  try {
    const created = await call(player, 'lobby:create', { name: 'Uploader', mode: 'top-meme' });
    const image = makeJpeg(160, 120, gradient());
    const send = (headers) => fetch(`${url}/api/memes`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...headers }, body: image });

    assert.equal((await send({})).status, 401);
    assert.equal((await send({ 'X-Lobby-Code': created.code, 'X-Player-Id': created.playerId, 'X-Player-Token': 'faux' })).status, 401);

    const auth = { 'X-Lobby-Code': created.code, 'X-Player-Id': created.playerId, 'X-Player-Token': created.token };
    const uploaded = await (await send(auth)).json();
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.duplicate, null);
    assert.equal((await (await send(auth)).json()).duplicate, 'exact');

    const served = await fetch(`${url}/memes/${uploaded.id}.jpg`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
    await waitFor(() => last(player)?.library?.count === server.memeLibrary.count);
  } finally {
    player.disconnect();
  }
});

test('espace admin : connexion obligatoire, puis catalogue et suppression', async () => {
  const page = await fetch(`${url}/admin`, { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/admin/login');
  assert.equal((await fetch(`${url}/admin/api/library`)).status, 401);

  const login = (password) =>
    fetch(`${url}/admin/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ADMIN.user, password }),
    });
  assert.equal((await login('mauvais')).headers.get('location'), '/admin/login?error=1');

  const ok = await login(ADMIN.password);
  assert.equal(ok.headers.get('location'), '/admin');
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);

  const library = await (await fetch(`${url}/admin/api/library`, { headers: { cookie } })).json();
  assert.ok(library.images.length >= 1);
  const [first] = library.images;

  const forged = await fetch(`${url}/admin/api/images/${first.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(forged.status, 403);
  const before = server.memeLibrary.count;
  const removed = await fetch(`${url}/admin/api/images/${first.id}`, { method: 'DELETE', headers: { cookie, 'X-Admin-Request': '1' } });
  assert.equal(removed.status, 200);
  assert.equal(server.memeLibrary.count, before - 1);
  assert.equal((await fetch(`${url}/memes/${first.id}.jpg`)).status, 404);

  // Import groupé depuis l'admin (pack d'images)
  const image = makeJpeg(120, 90, (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * y) % 256]);
  const post = (headers) => fetch(`${url}/admin/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...headers }, body: image });
  assert.equal((await post({ 'X-Admin-Request': '1' })).status, 401, 'sans cookie');
  assert.equal((await post({ cookie })).status, 403, 'sans en-tête anti-CSRF');
  const imported = await (await post({ cookie, 'X-Admin-Request': '1' })).json();
  assert.equal(imported.ok, true);
  assert.equal(imported.duplicate, null);
  assert.equal((await (await post({ cookie, 'X-Admin-Request': '1' })).json()).duplicate, 'exact');
  assert.equal(server.memeLibrary.list().find((e) => e.id === imported.id)?.uploadedBy, 'admin');

  const fakeCookie = `${cookie.split('.')[0]}.signature-bidon`;
  assert.equal((await fetch(`${url}/admin/api/library`, { headers: { cookie: fakeCookie } })).status, 401);
});

test('partie M-Culture complète : réponses cachées, correction, classement', async () => {
  const [alice, bob] = await Promise.all([client(), client()]);
  const created = await call(alice, 'lobby:create', { name: 'Alice', mode: 'm-culture' });
  await call(bob, 'lobby:join', { code: created.code, name: 'Bob' });
  assert.equal((await call(alice, 'lobby:set-settings', { questions: 5, timer: 0, categories: ['culture'] })).ok, true);
  await waitFor(() => last(bob)?.settings.questions === 5);
  assert.equal(last(bob).limits.quiz.categories.length, 6);

  assert.equal((await call(alice, 'game:start')).ok, true);
  await waitFor(() => last(bob)?.state === 'quiz');
  const total = last(bob).game.quiz.total;
  assert.equal(total, 5);
  for (let index = 0; index < total; index += 1) {
    await waitFor(() => last(bob)?.game?.quiz?.index === index);
    assert.equal(last(bob).game.quiz.question.answer, undefined);
    assert.equal((await call(bob, 'quiz:answer', { index, text: 'réponse de Bob' })).ok, true);
    assert.equal((await call(alice, 'quiz:answer', { index, text: server.manager.get(created.code).game.questions[index].answer })).ok, true);
  }
  await waitFor(() => last(bob)?.state === 'review');
  const review = last(bob).game.review;
  assert.equal(review.answers.find((r) => r.playerId === created.playerId).correct, true);
  assert.equal((await call(bob, 'quiz:finish')).ok, false, 'seul l’hôte corrige');
  assert.equal((await call(alice, 'quiz:review', { index: 4 })).ok, true);
  assert.equal((await call(alice, 'quiz:finish')).ok, true);
  await waitFor(() => last(bob)?.state === 'finished');
  assert.equal(last(bob).game.final.ranking[0].playerId, created.playerId);
  alice.close();
  bob.close();
});

test('partie Juste Prix via les sockets : réponse, révélation, fin', async () => {
  const [alice, bob] = await Promise.all([client(), client()]);
  const created = await call(alice, 'lobby:create', { name: 'Alice', mode: 'juste-prix' });
  await call(bob, 'lobby:join', { code: created.code, name: 'Bob' });
  assert.equal((await call(alice, 'lobby:set-settings', { rounds: 1, jpTimer: 0, jpCategories: ['distances'] })).ok, true);
  assert.equal((await call(alice, 'game:start')).ok, true);
  await waitFor(() => last(bob)?.state === 'jp-question');
  const { index, question } = last(bob).game.justePrix;
  assert.equal(question.kind, 'estimate');
  assert.equal((await call(bob, 'jp:answer', { index, value: 'pas un nombre' })).ok, false);
  assert.equal((await call(bob, 'jp:answer', { index, value: '12,5' })).ok, true);
  assert.equal((await call(alice, 'jp:answer', { index, value: '1 000' })).ok, true);
  await waitFor(() => last(bob)?.state === 'jp-reveal');
  assert.equal(typeof last(bob).game.result.answer, 'number');
  assert.equal((await call(alice, 'game:next')).ok, true);
  await waitFor(() => last(bob)?.state === 'finished');
  alice.close();
  bob.close();
});

test('partie Paint via les sockets : dessin relayé en direct, devinette, synchro', async () => {
  const [alice, bob] = await Promise.all([client(), client()]);
  const ops = [];
  bob.on('paint:op', (msg) => ops.push(msg));
  alice.on('paint:op', (msg) => ops.push(msg));
  const created = await call(alice, 'lobby:create', { name: 'Alice', mode: 'paint' });
  await call(bob, 'lobby:join', { code: created.code, name: 'Bob' });
  assert.equal((await call(alice, 'lobby:set-settings', { paintTurns: 1, paintTimer: 60 })).ok, true);
  assert.equal((await call(alice, 'game:start')).ok, true);
  await waitFor(() => last(alice)?.state === 'paint-choose');
  const drawerIsAlice = last(alice).game.paint.drawerId === created.playerId;
  const [drawer, guesser] = drawerIsAlice ? [alice, bob] : [bob, alice];
  await waitFor(() => last(drawer)?.game?.paint?.choices && last(guesser)?.state === 'paint-choose');
  assert.equal(last(guesser).game.paint.choices, null);
  assert.equal((await call(drawer, 'paint:choose', { difficulty: 'facile' })).ok, true);
  await waitFor(() => last(drawer)?.state === 'paint-draw' && last(guesser)?.state === 'paint-draw');
  const word = last(drawer).game.paint.word;
  assert.equal(last(guesser).game.paint.word, null);
  assert.equal((await call(drawer, 'paint:draw', { op: { t: 's', id: 'x1', tool: 'pen', color: '#000000', size: 10, pts: [1, 2, 3, 4] } })).ok, true);
  await waitFor(() => ops.length === 1);
  assert.equal(ops[0].op.id, 'x1', 'le trait arrive chez l’autre joueur');
  assert.equal((await call(guesser, 'paint:draw', { op: { t: 'c' } })).ok, false);
  const sync = await call(guesser, 'paint:sync');
  assert.equal(sync.ops.length, 1);
  assert.equal((await call(guesser, 'paint:guess', { text: word })).ok, true);
  await waitFor(() => last(guesser)?.state === 'paint-end');
  assert.equal(last(guesser).game.paint.result.word, word);
  alice.close();
  bob.close();
});
