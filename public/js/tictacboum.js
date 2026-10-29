// Tic Tac Boum : réglages, table ronde avec la bombe, syllabe au centre, fil des réponses, sons.
import { h } from './dom.js';

const POSITION = {
  debut: { label: 'Au début', long: 'au début du mot', example: (s) => `${s}…` },
  milieu: { label: 'N’importe où', long: 'n’importe où dans le mot', example: (s) => `…${s}…` },
  fin: { label: 'À la fin', long: 'à la fin du mot', example: (s) => `…${s}` },
};
const FUSE = { courte: 'Courte', moyenne: 'Moyenne', longue: 'Longue' };
const LEVEL = { facile: 'Facile', moyen: 'Moyen', difficile: 'Difficile' };
const SOUND_KEY = 'entre-potes:sound';

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderTicTacBoumSettings(lobby, host, ctx) {
  const limits = lobby.limits.ticTacBoum;
  if (!limits) return null;
  const s = lobby.settings.ticTacBoum;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (list, labels, value, key) =>
    h(
      'div',
      { class: 'timer-choices' },
      list.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, disabled: !host, 'aria-pressed': String(v === value), onClick: () => v !== value && set({ [key]: v }) }, labels[v])),
    );
  const togglePos = (p) => {
    const next = s.positions.includes(p) ? s.positions.filter((x) => x !== p) : [...s.positions, p];
    if (!next.length) return ctx.toast('Garde au moins une position 😉', 'error');
    set({ tbPositions: next });
  };
  return h(
    'div',
    { class: 'quiz-settings' },
    h(
      'div',
      { class: 'rounds' },
      h('span', { class: 'rounds-label' }, 'Vies par joueur'),
      host
        ? h(
            'div',
            { class: 'stepper' },
            h('button', { type: 'button', class: 'step', 'aria-label': 'Une vie de moins', disabled: s.lives <= limits.lives.min, onClick: () => set({ tbLives: s.lives - 1 }) }, '−'),
            h('span', { class: 'step-value' }, '❤️'.repeat(s.lives)),
            h('button', { type: 'button', class: 'step', 'aria-label': 'Une vie de plus', disabled: s.lives >= limits.lives.max, onClick: () => set({ tbLives: s.lives + 1 }) }, '+'),
          )
        : h('strong', {}, '❤️'.repeat(s.lives)),
    ),
    h('span', { class: 'rounds-label' }, 'Mèche (durée secrète, tirée au hasard)'),
    choices(limits.fuses, FUSE, s.fuse, 'tbFuse'),
    h('span', { class: 'rounds-label' }, 'Difficulté des syllabes'),
    choices(limits.difficulties, LEVEL, s.difficulty, 'tbDifficulty'),
    h('span', { class: 'rounds-label' }, 'Où doit être la syllabe ?'),
    h(
      'div',
      { class: 'cat-toggles' },
      limits.positions.map((p) => {
        const on = s.positions.includes(p);
        return h(
          'button',
          { type: 'button', class: `cat-toggle${on ? ' is-on' : ''}`, 'aria-pressed': String(on), disabled: !host, onClick: () => togglePos(p) },
          h('span', { class: 'cat-emoji' }, POSITION[p].example('ab')),
          h('span', { class: 'cat-label' }, POSITION[p].label),
          h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
        );
      }),
    ),
    h('p', { class: 'hint hint-left' }, 'Mot juste : la bombe passe au voisin. Mot faux : elle reste chez toi. Personne ne sait quand elle explose ! Accents ignorés, chaque mot une seule fois.'),
  );
}

// ---------------------------------------------------------------------------
// Sons (générés, aucun fichier) : tic-tac et explosion
// ---------------------------------------------------------------------------

const sound = {
  ctx: null,
  get on() {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      return true;
    }
  },
  set on(value) {
    try {
      localStorage.setItem(SOUND_KEY, value ? 'on' : 'off');
    } catch {
      /* stockage indisponible */
    }
  },
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) this.ctx = new AudioCtx();
  },
  tick(high) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = high ? 1250 : 900;
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.05);
  },
  boom() {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    const length = Math.floor(this.ctx.sampleRate * 0.9);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 0.8);
    const gain = this.ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(filter).connect(gain).connect(this.ctx.destination);
    src.start(t);
  },
};
// Les navigateurs n'autorisent le son qu'après un geste de l'utilisateur.
document.addEventListener('pointerdown', () => sound.unlock(), { passive: true });
document.addEventListener('keydown', () => sound.unlock());

const vibrate = (pattern) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* pas de vibreur */
  }
};

// Frappe en direct du porteur de la bombe.
let active = null;
export function attachTicTacBoumSocket(socket) {
  socket.on('tb:typing', ({ playerId, text }) => active?.onTyping(playerId, text));
}

// ---------------------------------------------------------------------------
// Écran de jeu (conservé entre deux messages du serveur)
// ---------------------------------------------------------------------------

export const ticTacBoumScreenKey = (lobby) => `tb:${lobby.hostId}`;

export function buildTicTacBoumScreen(lobby, ctx) {
  const meId = ctx.me();
  let current = lobby;
  let typing = { playerId: null, text: '' };
  let lastPhase = null;
  let lastHolder = null;
  let lastFeedId = 0;
  let tickTimer = null;

  const table = h('div', { class: 'lg-table tb-table' });
  const feedList = h('ul', { class: 'paint-chat-list tb-feed' });
  const input = h('input', {
    type: 'text',
    class: 'tb-input',
    maxlength: '40',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    enterkeyhint: 'send',
    'aria-label': 'Ton mot',
  });
  const sendBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Valider');
  const form = h(
    'form',
    {
      class: 'tb-form',
      onSubmit: async (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        const res = await ctx.emit('tb:word', { text });
        if (!res.ok) {
          if (res.error !== 'NOT_YOUR_TURN') ctx.toast(res.message, 'error');
          return;
        }
        if (res.valid) input.value = '';
        else {
          form.classList.remove('is-wrong');
          void form.offsetWidth; // relance l'animation
          form.classList.add('is-wrong');
          vibrate(60);
          input.select();
        }
      },
    },
    input,
    sendBtn,
  );
  input.addEventListener('input', () => ctx.emit('tb:typing', { text: input.value }));
  form.addEventListener('animationend', () => form.classList.remove('is-wrong'));
  const soundBtn = h('button', { type: 'button', class: 'chip tb-sound', onClick: () => { sound.unlock(); sound.on = !sound.on; refresh(); } });
  const status = h('p', { class: 'tb-status' });
  const boomLayer = h('div', { class: 'tb-boom', hidden: true });
  const hostBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Faire passer la bombe ⏭ (hôte)');

  const startTicking = () => {
    if (tickTimer) return;
    let high = true;
    tickTimer = setInterval(() => {
      if (!table.isConnected) {
        clearInterval(tickTimer);
        tickTimer = null;
        return;
      }
      sound.tick(high);
      high = !high;
    }, 480);
  };
  const stopTicking = () => {
    clearInterval(tickTimer);
    tickTimer = null;
  };

  function renderTable(tb) {
    const n = tb.seats.length;
    const alive = new Set(tb.alive);
    const syllable = tb.syllable?.text?.toUpperCase() ?? '';
    const pos = POSITION[tb.syllable?.position] ?? POSITION.milieu;
    table.replaceChildren(
      ...[
      h('div', { class: 'lg-table-top tb-table-top', 'aria-hidden': 'true' }),
      tb.phase === 'tb-boom'
        ? null
        : h(
        'div',
        { class: 'lg-center tb-center' },
        h('span', { class: `tb-bomb${tb.phase === 'tb-play' ? ' is-lit' : ''}`, 'aria-hidden': 'true' }, tb.phase === 'tb-boom' ? '💥' : '💣'),
        h('strong', { class: 'tb-syllable' }, pos.example(syllable)),
        h('span', { class: 'tb-position' }, pos.long),
        tb.phase === 'tb-ready' ? h('span', { class: 'tb-ready' }, 'Prêts ? Partez…') : null,
      ),
      ...tb.seats.map((id, i) => {
        const angle = (-90 + (360 / n) * i) * (Math.PI / 180);
        const player = ctx.getPlayer(id);
        const holder = tb.holderId === id && tb.phase !== 'tb-boom';
        const dead = !alive.has(id);
        const lives = tb.lives[id] ?? 0;
        return h(
          'div',
          {
            class: ['lg-seat', 'tb-seat', holder ? 'is-holder' : '', dead ? 'is-dead' : '', id === meId ? 'is-me' : '', tb.boom?.playerId === id && tb.phase === 'tb-boom' ? 'is-boom' : ''].filter(Boolean).join(' '),
            style: `left:${50 + 40 * Math.cos(angle)}%;top:${50 + 40 * Math.sin(angle)}%`,
          },
          h('span', { class: 'lg-seat-avatar' }, ctx.avatar(player, 'md'), holder ? h('span', { class: 'tb-seat-bomb' }, '💣') : null),
          h('span', { class: 'lg-seat-name' }, player.name),
          h('span', { class: 'tb-lives' }, dead ? '💀' : '❤️'.repeat(lives) + '🖤'.repeat(Math.max(0, tb.maxLives - lives))),
          holder && typing.playerId === id && typing.text ? h('span', { class: 'tb-typing' }, typing.text) : null,
        );
      }),
      ].filter(Boolean),
    );
  }

  function renderFeed(tb) {
    const nearBottom = feedList.scrollHeight - feedList.scrollTop - feedList.clientHeight < 40;
    feedList.replaceChildren(
      ...tb.feed.map((f) => {
        const name = ctx.getPlayer(f.playerId).name;
        if (f.boom) return h('li', { class: 'tb-feed-boom' }, f.eliminated ? `💥 BOUM ! ${name} est éliminé 💀` : `💥 BOUM ! ${name} perd une vie`);
        return h(
          'li',
          { class: f.ok ? 'tb-feed-ok' : 'chat-wrong' },
          f.ok ? '✅ ' : '❌ ',
          h('strong', {}, `${name} : `),
          f.text.toUpperCase(),
          f.ok ? null : h('small', {}, ` — ${f.reason}`),
        );
      }),
    );
    const newest = tb.feed.at(-1)?.id ?? 0;
    if (nearBottom || newest !== lastFeedId) feedList.scrollTop = feedList.scrollHeight;
    lastFeedId = newest;
  }

  function refresh() {
    const tb = current.game.ticTacBoum;
    if (!tb) return;
    const isHolder = tb.holderId === meId && tb.alive.includes(meId);
    const playing = tb.phase === 'tb-play';

    // Sons et vibrations aux changements d'étape
    if (tb.phase !== lastPhase) {
      if (tb.phase === 'tb-play') startTicking();
      else stopTicking();
      if (tb.phase === 'tb-boom') {
        sound.boom();
        if (tb.boom?.playerId === meId) vibrate([200, 80, 300]);
      }
      if (tb.phase === 'tb-ready') input.value = '';
    }
    if (tb.holderId !== lastHolder) {
      typing = { playerId: null, text: '' };
      if (isHolder && tb.phase !== 'tb-boom') vibrate(80);
    }
    lastPhase = tb.phase;
    lastHolder = tb.holderId;

    renderTable(tb);
    renderFeed(tb);
    const canType = isHolder && playing;
    input.disabled = !canType;
    sendBtn.disabled = !canType;
    input.placeholder = canType ? `Un mot ${POSITION[tb.syllable.position].long}…` : isHolder ? 'Prépare-toi…' : `${ctx.getPlayer(tb.holderId).name} a la bombe…`;
    form.classList.toggle('is-mine', isHolder);
    if (canType && document.activeElement !== input) setTimeout(() => input.isConnected && !input.disabled && input.focus(), 30);
    soundBtn.textContent = sound.on ? '🔊 Son' : '🔇 Son coupé';
    const out = !tb.alive.includes(meId);
    status.textContent = out
      ? '💀 Tu es éliminé : regarde les autres transpirer.'
      : isHolder
        ? playing
          ? '💣 À toi ! Tape un mot vite !'
          : '💣 Tu commences avec la bombe…'
        : `Manche ${tb.manche} · ${tb.usedCount} mot${tb.usedCount > 1 ? 's' : ''} déjà utilisé${tb.usedCount > 1 ? 's' : ''}`;
    status.classList.toggle('is-mine', isHolder && !out);
    boomLayer.hidden = tb.phase !== 'tb-boom';
    if (!boomLayer.hidden && tb.boom) {
      boomLayer.replaceChildren(
        h('span', { class: 'tb-boom-icon' }, '💥'),
        h('strong', {}, `BOUM ! ${ctx.getPlayer(tb.boom.playerId).name}`),
        h('span', {}, tb.boom.eliminated ? 'est éliminé 💀' : 'perd une vie 💔'),
      );
    }
    hostBtn.hidden = !ctx.isHost() || !playing;
  }

  active = {
    onTyping(playerId, text) {
      typing = { playerId, text };
      if (current.game.ticTacBoum?.holderId === playerId) renderTable(current.game.ticTacBoum);
    },
  };

  const el = h(
    'div',
    { class: 'tb-layout' },
    h('div', { class: 'tb-top' }, status, soundBtn),
    h('div', { class: 'tb-stage' }, table, boomLayer),
    form,
    h('section', { class: 'card tb-feed-card' }, h('h2', {}, 'Réponses'), feedList),
    hostBtn,
  );
  return {
    el,
    update(next) {
      current = next;
      refresh();
    },
  };
}

// Fin de partie : le survivant et le nombre de mots trouvés.
export function renderTicTacBoumFinal(final, ctx) {
  const words = final.tb?.words ?? {};
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Classement'),
    h(
      'ol',
      { class: 'final-list' },
      final.ranking.map((entry, i) =>
        h(
          'li',
          {},
          h('span', { class: 'final-rank' }, i === 0 ? '🏆' : `#${i + 1}`),
          ctx.avatar(ctx.getPlayer(entry.playerId), 'sm'),
          h('span', { class: 'final-name' }, ctx.getPlayer(entry.playerId).name),
          h('strong', {}, `${words[entry.playerId] ?? 0} mot${(words[entry.playerId] ?? 0) > 1 ? 's' : ''}`),
        ),
      ),
    ),
    h('p', { class: 'hint' }, `Partie en ${final.tb?.manches ?? 0} manche${(final.tb?.manches ?? 0) > 1 ? 's' : ''}.`),
  );
}
