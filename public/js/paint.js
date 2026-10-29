// Paint (façon Skribbl) : réglages, tableau de dessin partagé en direct, chat des devinettes.
import { h } from './dom.js';

const SIZE = 800; // taille logique du tableau, identique sur tous les écrans
const TOOLS = [
  { id: 'pen', label: 'Crayon', icon: '✏️' },
  { id: 'marker', label: 'Marqueur', icon: '🖍️' },
  { id: 'spray', label: 'Spray', icon: '💨' },
  { id: 'eraser', label: 'Gomme', icon: '🧽' },
  { id: 'fill', label: 'Pot de peinture', icon: '🪣' },
];
const SIZES = [
  { px: 4, label: 'Fin' },
  { px: 10, label: 'Moyen' },
  { px: 22, label: 'Gros' },
  { px: 48, label: 'Énorme' },
];
const COLORS = [
  '#000000', '#5b5b5b', '#a0a0a0', '#ffffff', '#e53935', '#ff7043', '#ffb300', '#fdd835',
  '#7cb342', '#2e7d32', '#00acc1', '#1e88e5', '#3949ab', '#8e24aa', '#ec407a', '#8d6e63',
  '#ffccbc', '#f5deb3',
];
const DIFF = {
  facile: { label: 'Facile', mult: 1, className: 'diff-easy' },
  moyen: { label: 'Moyen', mult: 2, className: 'diff-medium' },
  difficile: { label: 'Difficile', mult: 3, className: 'diff-hard' },
};

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderPaintSettings(lobby, host, ctx) {
  const limits = lobby.limits.paint;
  if (!limits) return null;
  const { turns, timer } = lobby.settings.paint;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const players = Math.max(limits.players, 2);
  return h(
    'div',
    { class: 'quiz-settings' },
    h(
      'div',
      { class: 'rounds' },
      h('span', { class: 'rounds-label' }, 'Chacun dessine'),
      host
        ? h(
            'div',
            { class: 'stepper' },
            h('button', { type: 'button', class: 'step', 'aria-label': 'Moins de tours', disabled: turns <= limits.turns.min, onClick: () => set({ paintTurns: turns - 1 }) }, '−'),
            h('span', { class: 'step-value', 'aria-live': 'polite' }, `${turns}×`),
            h('button', { type: 'button', class: 'step', 'aria-label': 'Plus de tours', disabled: turns >= limits.turns.max, onClick: () => set({ paintTurns: turns + 1 }) }, '+'),
          )
        : h('strong', {}, `${turns}×`),
    ),
    h('p', { class: 'paint-rounds-calc' }, `${players} joueurs × ${turns} = `, h('strong', {}, `${players * turns} manches`)),
    h('span', { class: 'rounds-label' }, 'Temps pour dessiner'),
    h(
      'div',
      { class: 'timer-choices', role: 'group', 'aria-label': 'Temps pour dessiner' },
      limits.timers.map((value) =>
        h(
          'button',
          { type: 'button', class: `timer-choice${value === timer ? ' is-active' : ''}`, 'aria-pressed': String(value === timer), disabled: !host, onClick: () => value !== timer && set({ paintTimer: value }) },
          `${value} s`,
        ),
      ),
    ),
    h('p', { class: 'hint hint-left' }, 'Le dessinateur choisit un mot facile (×1), moyen (×2) ou difficile (×3). Le 1er qui trouve gagne 3 fois les points, le 2e 2 fois, les suivants 1 fois ; le dessinateur gagne 1 fois par joueur qui trouve.'),
  );
}

// ---------------------------------------------------------------------------
// Tableau de dessin : rejoue la liste des actions (traits, remplissages, effacements)
// ---------------------------------------------------------------------------

function hashString(text) {
  let h1 = 2166136261;
  for (let i = 0; i < text.length; i += 1) h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619);
  return h1 >>> 0;
}
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function createBoard() {
  const canvas = h('canvas', { class: 'paint-canvas', width: SIZE, height: SIZE });
  const g = canvas.getContext('2d', { willReadFrequently: true });
  let last = new Map(); // dernier point de chaque trait (les traits arrivent en plusieurs morceaux)

  const clear = () => {
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, SIZE, SIZE);
  };

  const strokeStyle = (op) => {
    g.globalAlpha = op.tool === 'marker' ? 0.35 : 1;
    g.strokeStyle = g.fillStyle = op.tool === 'eraser' ? '#ffffff' : op.color;
    g.lineWidth = op.tool === 'marker' ? op.size * 1.6 : op.size;
    g.lineCap = op.tool === 'marker' ? 'square' : 'round';
    g.lineJoin = 'round';
  };

  const spray = (op, x, y, index) => {
    const random = rng(hashString(`${op.id}:${x}:${y}:${index}`));
    const radius = op.size * 1.4;
    const dots = Math.max(10, Math.round(op.size * 1.5));
    for (let i = 0; i < dots; i += 1) {
      const angle = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * radius;
      g.fillRect(x + Math.cos(angle) * r, y + Math.sin(angle) * r, 1.6, 1.6);
    }
  };

  const drawStroke = (op) => {
    strokeStyle(op);
    const pts = op.pts;
    let prev = last.get(op.id) ?? null;
    if (op.tool === 'spray') {
      // On remplit le chemin entre deux points pour un spray régulier, même si le doigt va vite.
      let from = prev;
      for (let i = 0; i < pts.length; i += 2) {
        const to = [pts[i], pts[i + 1]];
        if (!from) spray(op, to[0], to[1], 0);
        else {
          const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / Math.max(3, op.size * 0.5)));
          for (let k = 1; k <= steps; k += 1) {
            spray(op, Math.round(from[0] + ((to[0] - from[0]) * k) / steps), Math.round(from[1] + ((to[1] - from[1]) * k) / steps), k);
          }
        }
        from = to;
      }
    } else if (!prev && pts.length === 2) {
      // Début d'un trait (ou simple clic) : un point de la taille du pinceau.
      g.beginPath();
      if (op.tool === 'marker') g.fillRect(pts[0] - g.lineWidth / 2, pts[1] - g.lineWidth / 2, g.lineWidth, g.lineWidth);
      else {
        g.arc(pts[0], pts[1], g.lineWidth / 2, 0, Math.PI * 2);
        g.fill();
      }
    } else {
      g.beginPath();
      let started = false;
      if (prev) {
        g.moveTo(prev[0], prev[1]);
        started = true;
      }
      for (let i = 0; i < pts.length; i += 2) {
        if (!started) {
          g.moveTo(pts[i], pts[i + 1]);
          started = true;
        } else g.lineTo(pts[i], pts[i + 1]);
      }
      g.stroke();
    }
    prev = [pts[pts.length - 2], pts[pts.length - 1]];
    last.set(op.id, prev);
    g.globalAlpha = 1;
  };

  // Pot de peinture : remplit la zone de couleur proche (tolérance pour les bords adoucis).
  const fill = (op) => {
    const image = g.getImageData(0, 0, SIZE, SIZE);
    const data = image.data;
    const start = (op.y * SIZE + op.x) * 4;
    const target = [data[start], data[start + 1], data[start + 2]];
    const [r, gg, b] = hexToRgb(op.color);
    if (Math.abs(target[0] - r) + Math.abs(target[1] - gg) + Math.abs(target[2] - b) < 8) return;
    const tolerance = 90;
    const matches = (i) => Math.abs(data[i] - target[0]) + Math.abs(data[i + 1] - target[1]) + Math.abs(data[i + 2] - target[2]) <= tolerance;
    const seen = new Uint8Array(SIZE * SIZE);
    const stack = [op.x, op.y];
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      while (x >= 0 && matches((y * SIZE + x) * 4) && !seen[y * SIZE + x]) x -= 1;
      x += 1;
      let up = false;
      let down = false;
      while (x < SIZE && !seen[y * SIZE + x] && matches((y * SIZE + x) * 4)) {
        const i = (y * SIZE + x) * 4;
        seen[y * SIZE + x] = 1;
        data[i] = r;
        data[i + 1] = gg;
        data[i + 2] = b;
        data[i + 3] = 255;
        for (const [ny, flagName] of [[y - 1, 'up'], [y + 1, 'down']]) {
          if (ny < 0 || ny >= SIZE) continue;
          const ok = !seen[ny * SIZE + x] && matches((ny * SIZE + x) * 4);
          const flag = flagName === 'up' ? up : down;
          if (ok && !flag) stack.push(x, ny);
          if (flagName === 'up') up = ok;
          else down = ok;
        }
        x += 1;
      }
    }
    g.putImageData(image, 0, 0);
  };

  const apply = (op) => {
    if (op.t === 's') drawStroke(op);
    else if (op.t === 'f') fill(op);
    else if (op.t === 'c') {
      clear();
      last = new Map();
    }
  };

  const reset = (ops) => {
    clear();
    last = new Map();
    for (const op of ops) apply(op);
  };

  clear();
  return { canvas, apply, reset };
}

// Un seul tableau affiché à la fois : les messages du serveur lui sont transmis.
let active = null;

export function attachPaintSocket(socket) {
  socket.on('paint:op', ({ key, op }) => {
    if (active && active.key === key) active.board.apply(op);
  });
  socket.on('paint:reset', ({ key, ops }) => {
    if (active && active.key === key) active.board.reset(ops);
  });
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function paintScreenKey(lobby) {
  const paint = lobby.game.paint;
  return `paint:${paint.key}:${lobby.state}:${lobby.hostId}`;
}

const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;

export function buildPaintScreen(lobby, ctx) {
  const paint = lobby.game.paint;
  const me = ctx.me();
  const isDrawer = paint.drawerId === me;
  const drawer = ctx.getPlayer(paint.drawerId);
  const offset = paint.serverNow - Date.now();
  const now = () => Date.now() + offset;

  // --- Tableau partagé ---
  const board = createBoard();
  active = { key: paint.key, board };
  ctx.emit('paint:sync').then((res) => {
    if (res?.ok && active?.board === board && res.key === paint.key) board.reset(res.ops);
  });

  // --- Bandeau du haut : chrono, mot ou petites barres, manche ---
  const timerText = h('strong', { class: 'paint-timer' }, '');
  const wordBox = h('div', { class: 'paint-word' });
  const head = h(
    'div',
    { class: 'paint-head' },
    h('span', { class: 'paint-clock', 'aria-label': 'Temps restant' }, '⏱️ ', timerText),
    wordBox,
    h('span', { class: 'paint-round' }, `${paint.manche}/${paint.total}`),
  );
  const renderWord = (p) => {
    if (lobby.state === 'paint-choose') {
      wordBox.replaceChildren(h('span', { class: 'paint-word-hint' }, isDrawer ? 'Choisis ton mot ↓' : `${drawer.name} choisit un mot…`));
    } else if (p.word) {
      wordBox.replaceChildren(
        h('span', { class: 'paint-word-label' }, isDrawer ? 'Ton mot' : lobby.state === 'paint-end' ? 'C’était' : 'Trouvé !'),
        h('strong', { class: 'paint-word-text' }, p.word),
      );
    } else if (p.mask) {
      const letters = p.mask.filter((c) => /[\p{L}\p{N}_]/u.test(c)).length;
      wordBox.replaceChildren(
        h('span', { class: 'paint-mask', 'aria-label': `Mot de ${letters} lettres` }, p.mask.map((c) => h('span', { class: c === ' ' ? 'mask-space' : c === '_' ? 'mask-blank' : 'mask-letter' }, c === '_' ? '' : c))),
        h('small', { class: 'paint-mask-count' }, `${letters} lettres`),
      );
    } else wordBox.replaceChildren();
  };
  renderWord(paint);

  // Chrono (choix du mot, dessin, ou attente de la manche suivante)
  let deadline = paint.deadline ?? paint.chooseDeadline ?? paint.nextAt;
  const tick = () => {
    if (!head.isConnected && head.dataset.started) return;
    head.dataset.started = '1';
    const left = deadline ? Math.max(0, Math.ceil((deadline - now()) / 1000)) : null;
    timerText.textContent = left === null ? '—' : `${left}`;
    head.classList.toggle('is-urgent', lobby.state === 'paint-draw' && left !== null && left <= 10);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // --- Joueurs (cases colorées) ---
  const playerList = h('ul', { class: 'paint-players' });
  const renderPlayers = (current) => {
    const p = current.game.paint;
    playerList.replaceChildren(
      ...current.players.map((player) => {
        const status = p.statuses[player.id];
        return h(
          'li',
          { class: `paint-player${status ? ` is-${status}` : ''}${player.connected ? '' : ' is-offline'}` },
          ctx.avatar(player, 'sm'),
          h('span', { class: 'paint-player-name' }, player.name, player.id === me ? h('small', {}, ' (toi)') : null),
          h('span', { class: 'paint-player-score' }, status === 'drawing' ? '✏️' : status === 'found' ? '✅' : '', ` ${p.scores[player.id] ?? 0}`),
        );
      }),
    );
  };

  // --- Chat ---
  const chatList = h('ul', { class: 'paint-chat-list', 'aria-live': 'polite' });
  let lastChatId = 0;
  const renderChat = (current) => {
    const p = current.game.paint;
    const nearBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
    chatList.replaceChildren(
      ...p.chat.map((c) => {
        const name = c.playerId ? ctx.getPlayer(c.playerId).name : '';
        if (c.kind === 'found') return h('li', { class: 'chat-found' }, `✅ ${name} a trouvé le mot !`);
        if (c.kind === 'close') {
          return h('li', { class: 'chat-close' }, c.text ? [h('strong', {}, `${name} : `), c.text, ' — tout proche ! 🟠'] : `🟠 ${name} est tout proche !`);
        }
        if (c.kind === 'guess') return h('li', { class: 'chat-wrong' }, h('strong', {}, `${name} : `), c.text);
        if (c.kind === 'secret') return h('li', { class: 'chat-secret' }, h('strong', {}, `${name} 🤫 : `), c.text);
        if (c.kind === 'drawer') return h('li', { class: 'chat-drawer' }, h('strong', {}, `✏️ ${name} : `), c.text);
        return h('li', { class: 'chat-system' }, c.text);
      }),
    );
    const newest = p.chat.at(-1)?.id ?? 0;
    if (nearBottom || newest !== lastChatId) chatList.scrollTop = chatList.scrollHeight;
    lastChatId = newest;
  };

  const chatInput = h('input', {
    type: 'text',
    class: 'paint-chat-input',
    maxlength: '60',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'send',
    placeholder: isDrawer ? 'Parle aux joueurs (sans donner le mot)…' : 'Écris ta réponse…',
    disabled: lobby.state !== 'paint-draw',
  });
  const chatForm = h(
    'form',
    {
      class: 'paint-chat-form',
      onSubmit: async (event) => {
        event.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;
        chatInput.value = '';
        const res = await ctx.action('paint:guess', { text });
        if (!res.ok) chatInput.value = text;
        chatInput.focus();
      },
    },
    chatInput,
    h('button', { type: 'submit', class: 'btn btn-primary', disabled: lobby.state !== 'paint-draw' }, 'Envoyer'),
  );
  const chat = h('section', { class: 'paint-chat card' }, h('h2', {}, 'Chat'), chatList, chatForm);

  // --- Zone centrale : tableau + outils / choix du mot / résultat ---
  const stage = h('div', { class: 'paint-stage' }, board.canvas);
  let tools = null;

  if (lobby.state === 'paint-choose' && isDrawer && paint.choices) {
    stage.append(
      h(
        'div',
        { class: 'paint-overlay' },
        h('p', { class: 'paint-overlay-title' }, 'Choisis le mot à dessiner'),
        h(
          'div',
          { class: 'paint-choices' },
          Object.entries(DIFF).map(([level, info]) =>
            h(
              'button',
              { type: 'button', class: `paint-choice ${info.className}`, onClick: () => ctx.action('paint:choose', { difficulty: level }) },
              h('span', { class: 'choice-level' }, `${info.label} · ×${info.mult}`),
              h('strong', {}, paint.choices[level]),
            ),
          ),
        ),
      ),
    );
  } else if (lobby.state === 'paint-choose') {
    stage.append(h('div', { class: 'paint-overlay' }, ctx.avatar(drawer, 'lg'), h('p', { class: 'paint-overlay-title' }, `${drawer.name} choisit un mot…`)));
  } else if (lobby.state === 'paint-end') {
    const { result } = paint;
    const reason = { 'all-found': 'Tout le monde a trouvé ! 🎉', time: 'Temps écoulé ⏱️', 'drawer-left': `${drawer.name} est parti…`, skipped: 'Manche passée', alone: 'Plus personne pour deviner' }[result.reason];
    const winners = Object.entries(result.points).sort((a, b) => b[1] - a[1]);
    stage.append(
      h(
        'div',
        { class: 'paint-overlay' },
        h('p', { class: 'paint-overlay-reason' }, reason ?? ''),
        result.word ? [h('p', { class: 'paint-overlay-title' }, 'Le mot était'), h('p', { class: 'paint-overlay-word' }, result.word)] : null,
        winners.length
          ? h('ul', { class: 'paint-gains' }, winners.map(([id, n]) => h('li', {}, h('span', {}, ctx.getPlayer(id).name), h('strong', {}, `+${pts(n)}`))))
          : h('p', { class: 'hint' }, 'Personne n’a marqué de points.'),
        ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-primary', onClick: () => ctx.action('game:next') }, paint.manche >= paint.total ? 'Classement final 🏁' : 'Manche suivante →') : null,
      ),
    );
  }

  if (lobby.state === 'paint-draw' && isDrawer) tools = buildTools(board, ctx, paint.key);

  const hostBar = ctx.isHost() && lobby.state !== 'paint-end'
    ? h('button', { type: 'button', class: 'btn btn-ghost paint-skip', onClick: () => ctx.action('game:reveal') }, 'Passer cette manche ⏭')
    : null;

  const el = h(
    'div',
    { class: 'paint-layout' },
    h('div', { class: 'paint-main' }, head, stage, tools),
    chat,
    h('section', { class: 'paint-side card' }, h('h2', {}, 'Joueurs'), playerList, hostBar),
  );

  const update = (current) => {
    const p = current.game.paint;
    if (!p) return;
    deadline = p.deadline ?? p.chooseDeadline ?? p.nextAt;
    renderWord(p);
    renderPlayers(current);
    renderChat(current);
  };
  return { el, update };
}

// ---------------------------------------------------------------------------
// Outils du dessinateur
// ---------------------------------------------------------------------------

function buildTools(board, ctx, key, sink = null) {
  const state = { tool: 'pen', color: '#000000', size: SIZES[1].px };
  let stroke = null;
  let buffer = [];
  let flushTimer = null;

  // Par défaut on envoie au serveur (Paint) ; « sink » permet de dessiner en local (Du coq à l'âne).
  const send = sink ?? ((op) => ctx.emit('paint:draw', { op }).then((res) => {
    if (!res.ok && res.error !== 'NOT_DRAWING') ctx.toast(res.message, 'error');
  }));
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!stroke || buffer.length === 0) return;
    send({ ...stroke, pts: buffer });
    buffer = [];
  };
  const point = (event) => {
    const rect = board.canvas.getBoundingClientRect();
    return [Math.round(((event.clientX - rect.left) / rect.width) * SIZE), Math.round(((event.clientY - rect.top) / rect.height) * SIZE)];
  };
  const addPoint = (xy) => {
    // Dessin immédiat chez le dessinateur, envoi groupé toutes les 40 ms.
    board.apply({ ...stroke, pts: xy });
    buffer.push(...xy);
    if (buffer.length >= 120) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 40);
  };

  const canvas = board.canvas;
  canvas.classList.add('is-drawing');
  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const xy = point(event);
    if (state.tool === 'fill') {
      const op = { t: 'f', x: Math.min(SIZE - 1, Math.max(0, xy[0])), y: Math.min(SIZE - 1, Math.max(0, xy[1])), color: state.color };
      board.apply(op);
      send(op);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    stroke = { t: 's', id: Math.random().toString(36).slice(2, 10), tool: state.tool, color: state.color, size: state.size };
    addPoint(xy);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!stroke) return;
    const events = event.getCoalescedEvents?.() ?? [event];
    for (const e of events) addPoint(point(e));
  });
  const end = () => {
    flush();
    stroke = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const box = h('div', { class: 'paint-tools card' });
  const draw = () => {
    box.replaceChildren(
      h(
        'div',
        { class: 'tool-row' },
        TOOLS.map((tool) =>
          h('button', { type: 'button', class: `tool-btn${state.tool === tool.id ? ' is-active' : ''}`, title: tool.label, 'aria-label': tool.label, 'aria-pressed': String(state.tool === tool.id), onClick: () => { state.tool = tool.id; draw(); } }, tool.icon),
        ),
        h('span', { class: 'tool-sep' }),
        h('button', { type: 'button', class: 'tool-btn', title: 'Annuler', 'aria-label': 'Annuler le dernier trait', onClick: () => { flush(); send({ t: 'u' }); } }, '↩️'),
        h(
          'button',
          {
            type: 'button',
            class: 'tool-btn',
            title: 'Tout effacer',
            'aria-label': 'Tout effacer',
            onClick: () => {
              flush();
              board.apply({ t: 'c' });
              send({ t: 'c' });
            },
          },
          '🗑️',
        ),
      ),
      h(
        'div',
        { class: 'tool-row' },
        SIZES.map((size) =>
          h(
            'button',
            { type: 'button', class: `size-btn${state.size === size.px ? ' is-active' : ''}`, title: size.label, 'aria-label': `Taille ${size.label}`, onClick: () => { state.size = size.px; draw(); } },
            h('span', { class: 'size-dot', style: `width:${Math.max(4, size.px / 2)}px;height:${Math.max(4, size.px / 2)}px` }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'color-row' },
        COLORS.map((color) =>
          h('button', { type: 'button', class: `color-btn${state.color === color ? ' is-active' : ''}`, style: `--swatch:${color}`, 'aria-label': `Couleur ${color}`, onClick: () => { state.color = color; if (state.tool === 'eraser') state.tool = 'pen'; draw(); } }),
        ),
        h(
          'label',
          { class: 'color-custom', title: 'Couleur au choix' },
          '🎨',
          h('input', { type: 'color', value: state.color, onInput: (event) => { state.color = event.target.value.toLowerCase(); if (state.tool === 'eraser') state.tool = 'pen'; }, onChange: () => draw() }),
        ),
      ),
    );
  };
  draw();
  void key;
  box.flush = flush;
  return box;
}

// Dessin local (non partagé en direct) : on récupère la liste des traits à la fin.
export function createSketch(ctx) {
  const board = createBoard();
  let ops = [];
  const sink = (op) => {
    if (op.t === 'u') {
      const last = ops.at(-1);
      if (last?.t === 's') ops = ops.filter((o) => !(o.t === 's' && o.id === last.id));
      else ops.pop();
      board.reset(ops);
    } else ops.push(op);
    return Promise.resolve();
  };
  const tools = buildTools(board, ctx, null, sink);
  return {
    el: h('div', { class: 'sketch' }, h('div', { class: 'paint-stage' }, board.canvas), tools),
    getOps() {
      tools.flush();
      return ops;
    },
    disable() {
      board.canvas.style.pointerEvents = 'none';
      tools.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
    },
  };
}

// Affiche un dessin terminé (lecture seule).
export function renderDrawing(ops, className = '') {
  const board = createBoard();
  board.reset(ops ?? []);
  return h('div', { class: `paint-stage drawing-view ${className}` }, board.canvas);
}
