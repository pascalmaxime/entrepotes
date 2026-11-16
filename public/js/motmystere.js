// Mot Mystère (façon Motus / Wordle) : réglages, grille + clavier, course des autres joueurs, révélation.
// L'écran de jeu est conservé pendant toute la manche : le mot en cours de frappe n'est jamais perdu.
import { h } from './dom.js';

const KEY_ROWS = ['azertyuiop', 'qsdfghjklm', '⌫wxcvbn⏎'];
const RANK = ['🥇', '🥈', '🥉'];
const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const clean = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[^a-z]/g, '');

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderMotMystereSettings(lobby, host, ctx) {
  const limits = lobby.limits.motMystere;
  if (!limits) return null;
  const s = lobby.settings.motMystere;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (list, value, key, label) =>
    h('div', { class: 'timer-choices' }, list.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  const p = limits.points;
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Nombre de manches (un mot par manche)'),
    choices(limits.rounds, s.rounds, 'mmRounds', (v) => `${v}`),
    h('span', { class: 'rounds-label' }, 'Longueur des mots'),
    choices(limits.lengths, s.length, 'mmLength', (v) => (v ? `${v} lettres` : 'Au hasard (5 à 7)')),
    h('span', { class: 'rounds-label' }, 'Temps par manche'),
    choices(limits.timers, s.timer, 'mmTimer', (v) => (v >= 120 ? `${v / 60} min` : `${v} s`)),
    h(
      'div',
      { class: 'cat-toggles' },
      h(
        'button',
        { type: 'button', class: `cat-toggle${s.first ? ' is-on' : ''}`, 'aria-pressed': String(s.first), disabled: !host, onClick: () => set({ mmFirst: !s.first }) },
        h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, '🅰️'),
        h('span', { class: 'cat-label' }, 'Première lettre donnée (comme Motus)'),
        h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
      ),
    ),
    h(
      'p',
      { class: 'hint hint-left' },
      `Tout le monde cherche le même mot, chacun sur son téléphone, en ${limits.maxTries} essais. 🟥 bien placée, 🟡 mal placée, 🟦 absente. Tu vois la progression des autres en couleurs, jamais leurs lettres. Trouvé : ${p.found} pts + ${p.perTryLeft} par essai non utilisé, et +${p.podium.join(' / +')} aux trois plus rapides. À partir de ${limits.minPlayers} joueurs.`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function motMystereScreenKey(lobby) {
  const m = lobby.game.motMystere;
  return m.phase === 'mm-play' ? `mm-p:${m.index}` : `mm-r:${m.index}:${lobby.hostId}`;
}

export function buildMotMystereScreen(lobby, ctx) {
  return lobby.game.motMystere.phase === 'mm-play' ? buildPlay(lobby, ctx) : buildReveal(lobby, ctx);
}

function timerBar(m) {
  if (!m.deadline) return null;
  const offset = m.serverNow - Date.now();
  const total = m.timer * 1000;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
  let started = false;
  const tick = () => {
    if (started && !el.isConnected) return;
    started = true;
    const left = Math.max(0, m.deadline - (Date.now() + offset));
    fill.style.width = `${Math.min(100, (left / total) * 100)}%`;
    label.textContent = `${Math.ceil(left / 1000)} s`;
    el.classList.toggle('is-urgent', left <= 10_000);
    if (left > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return el;
}

function header(m, eyebrow) {
  return h(
    'section',
    { class: 'question-card quiz-card mm-head' },
    h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, eyebrow), h('span', { class: 'cat-pill' }, `🔤 ${m.length} lettres`)),
  );
}

// Une ligne de la grille : lettres + couleurs (ou cases vides).
function row(length, { word = '', colors = null, hint = null, current = false } = {}) {
  return h(
    'div',
    { class: `mm-row${current ? ' is-current' : ''}`, style: `--len:${length}` },
    Array.from({ length }, (_, i) => {
      const letter = word[i] ?? '';
      const color = colors?.[i];
      const showHint = !letter && i === 0 && hint;
      return h('span', { class: `mm-cell${color ? ` is-${color}` : ''}${letter && !color ? ' is-typed' : ''}${showHint ? ' is-hint' : ''}`, style: `--i:${i}` }, (letter || (showHint ? hint : '')).toUpperCase());
    }),
  );
}

// Mini-grille d'un adversaire : couleurs seulement.
function miniGrid(length, rows, max) {
  return h(
    'div',
    { class: 'mm-mini', style: `--len:${length}` },
    Array.from({ length: max }, (_, r) => Array.from({ length }, (_, i) => h('span', { class: `mm-dot${rows[r] ? ` is-${rows[r][i]}` : ''}` }))).flat(),
  );
}

function buildPlay(lobby, ctx) {
  const m0 = lobby.game.motMystere;
  const length = m0.length;
  const first = m0.first;
  let typed = first ?? '';
  let busy = false;
  let current = m0;

  const grid = h('div', { class: 'mm-grid' });
  const status = h('p', { class: 'mm-status' });
  const race = h('div', { class: 'mm-race' });
  const keyEls = new Map();
  const host = h('div');

  const shake = () => {
    const rowEl = grid.querySelector('.mm-row.is-current');
    rowEl?.classList.remove('is-shake');
    void rowEl?.offsetWidth;
    rowEl?.classList.add('is-shake');
  };
  const drawGrid = () => {
    const rows = current.myRows;
    const lines = [];
    for (let r = 0; r < current.maxTries; r += 1) {
      if (rows[r]) lines.push(row(length, { word: rows[r].word, colors: rows[r].colors }));
      else if (r === rows.length && !current.myDone) lines.push(row(length, { word: typed, current: true, hint: first }));
      else lines.push(row(length, { hint: first && !current.myDone ? first : null }));
    }
    grid.replaceChildren(...lines);
  };
  const press = async (key) => {
    if (current.myDone || busy) return;
    if (key === '⌫') {
      if (typed.length > (first ? 1 : 0)) typed = typed.slice(0, -1);
    } else if (key === '⏎') {
      if (typed.length < length) {
        ctx.toast(`Il faut ${length} lettres 😉`, 'error');
        shake();
        return;
      }
      busy = true;
      const res = await ctx.emit('mm:guess', { index: current.index, word: typed });
      busy = false;
      if (!res.ok) {
        ctx.toast(res.message, 'error');
        shake();
        return;
      }
      typed = first ?? '';
      if (res.found) ctx.toast('Trouvé ! 🎉', 'success');
    } else if (typed.length < length) {
      typed += key;
    }
    drawGrid();
  };

  const keyboard = h(
    'div',
    { class: 'mm-keyboard', 'aria-label': 'Clavier' },
    KEY_ROWS.map((line) =>
      h(
        'div',
        { class: 'mm-keys' },
        [...line].map((key) => {
          const btn = h('button', { type: 'button', class: `mm-key${key === '⌫' || key === '⏎' ? ' is-wide' : ''}`, 'aria-label': key === '⌫' ? 'Effacer' : key === '⏎' ? 'Valider' : key, onClick: () => press(key) }, key === '⏎' ? 'OK' : key.toUpperCase());
          keyEls.set(key, btn);
          return btn;
        }),
      ),
    ),
  );

  // Clavier de l'ordinateur (lettres accentuées comprises).
  const onKey = (event) => {
    if (!keyboard.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('input, textarea')) return;
    if (event.key === 'Enter') press('⏎');
    else if (event.key === 'Backspace') press('⌫');
    else {
      const letter = clean(event.key);
      if (letter.length === 1) press(letter);
      else return;
    }
    event.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  const el = h(
    'div',
    { class: 'stack mm-screen' },
    header(m0, `Manche ${m0.index + 1} sur ${m0.total}`),
    timerBar(m0),
    race,
    grid,
    status,
    keyboard,
    host,
  );

  const update = (lobbyNow) => {
    const m = lobbyNow.game.motMystere;
    if (!m) return;
    current = m;
    drawGrid();
    // Couleurs du clavier : la meilleure info connue pour chaque lettre.
    const best = new Map();
    const rank = { ok: 3, near: 2, no: 1 };
    for (const r of m.myRows) [...r.word].forEach((l, i) => { if ((rank[r.colors[i]] ?? 0) > (rank[best.get(l)] ?? 0)) best.set(l, r.colors[i]); });
    for (const [key, btn] of keyEls) {
      btn.classList.remove('is-ok', 'is-near', 'is-no');
      if (best.has(key)) btn.classList.add(`is-${best.get(key)}`);
      btn.disabled = m.myDone;
    }
    const me = m.others.find((o) => o.playerId === ctx.me());
    status.textContent = m.myFound
      ? `Trouvé en ${m.myRows.length} essai${m.myRows.length > 1 ? 's' : ''} ! ${me?.rank ? `${RANK[me.rank - 1] ?? ''} ${me.rank}${me.rank === 1 ? 'er' : 'e'} à trouver` : ''} — on attend les autres…`
      : m.myDone
        ? 'Plus d’essai… réponse à la fin de la manche 🤞'
        : `Essai ${m.myRows.length + 1} sur ${m.maxTries}`;
    status.classList.toggle('is-found', m.myFound);
    race.replaceChildren(
      ...m.others
        .filter((o) => o.playerId !== ctx.me())
        .map((o) => {
          const p = ctx.getPlayer(o.playerId);
          return h(
            'div',
            { class: `mm-runner${o.found ? ' is-found' : o.done ? ' is-out' : ''}${p.connected ? '' : ' is-away'}` },
            h('div', { class: 'mm-runner-head' }, ctx.avatar(p, 'sm'), h('span', { class: 'mm-runner-name' }, p.name), h('span', { class: 'mm-runner-tag' }, o.found ? RANK[o.rank - 1] ?? '✅' : o.done ? '❌' : `${o.colors.length}/${m.maxTries}`)),
            miniGrid(m.length, o.colors, m.maxTries),
          );
        }),
    );
    host.replaceChildren(...(ctx.isHost() ? [h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Révéler le mot maintenant ⏭')] : []));
  };
  return { el, update };
}

// ---------------------------------------------------------------------------
// Révélation : le mot, puis la grille de chacun
// ---------------------------------------------------------------------------

function buildReveal(lobby, ctx) {
  const { game } = lobby;
  const m = game.motMystere;
  const r = game.result;
  const last = game.round >= game.totalRounds;
  const order = [...r.boards].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || b.rows.length - a.rows.length);
  const scores = lobby.players.map((p) => ({ player: p, total: r.scores?.[p.id] ?? 0, gain: r.gains?.[p.id] ?? 0 })).sort((a, b) => b.total - a.total);
  const el = h(
    'div',
    { class: 'stack' },
    header(m, `Réponse · manche ${game.round}/${game.totalRounds}`),
    h('section', { class: 'card mm-answer' }, row(r.key.length, { word: r.key, colors: Array(r.key.length).fill('ok') }), h('p', { class: 'hint' }, `Le mot était « ${r.word} »`)),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Mot suivant →')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h(
      'div',
      { class: 'mm-boards' },
      order.map((b, i) => {
        const p = ctx.getPlayer(b.playerId);
        const gain = r.gains?.[b.playerId] ?? 0;
        return h(
          'section',
          { class: `card mm-board${b.found ? ' is-found' : ''}`, style: `--i:${i}` },
          h('div', { class: 'mm-runner-head' }, ctx.avatar(p, 'sm'), h('strong', { class: 'mm-runner-name' }, p.name), h('span', { class: 'mm-runner-tag' }, b.found ? `${RANK[b.rank - 1] ?? '✅'} ${b.rows.length}/6` : '❌'), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null),
          h('div', { class: 'mm-grid mm-grid-small' }, b.rows.length ? b.rows.map((row2) => row(r.key.length, row2)) : h('p', { class: 'hint' }, 'Aucun essai')),
        );
      }),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Scores'),
      h('ol', { class: 'final-list' }, scores.map(({ player, total, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(total))))),
    ),
  );
  return { el, update: () => {} };
}
