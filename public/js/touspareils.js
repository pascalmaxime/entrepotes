// Tous pareils ! : réglages, saisie de la réponse, révélation par groupes (fusion par l'hôte).
// La zone de saisie est conservée entre deux messages du serveur : le texte en cours n'est jamais perdu.
import { h } from './dom.js';

const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;

export function renderTousPareilsSettings(lobby, host, ctx) {
  const limits = lobby.limits.tousPareils;
  if (!limits) return null;
  const s = lobby.settings.tousPareils;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (values, value, key, label) =>
    h('div', { class: 'timer-choices' }, values.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Nombre de questions'),
    choices(limits.rounds, s.rounds, 'tpRounds', (v) => `${v}`),
    h('span', { class: 'rounds-label' }, 'Temps pour répondre'),
    choices(limits.timers, s.timer, 'tpTimer', (v) => `${v} s`),
    h(
      'p',
      { class: 'hint hint-left' },
      `« Un fruit rouge » : chacun écrit sa réponse en secret. Le but est d’écrire la même chose que les autres ! ${limits.points.perMatch} pt par joueur qui a la même réponse que toi, +${limits.points.top} si ta réponse est la plus populaire. Les fautes, accents et pluriels sont pardonnés, et l’hôte peut fusionner deux réponses qu’il juge identiques. ${limits.questions} questions, à partir de ${limits.minPlayers} joueurs.`,
    ),
  );
}

export function tousPareilsScreenKey(lobby) {
  const t = lobby.game.tousPareils;
  return t.phase === 'tp-answer' ? `tp-a:${t.index}` : `tp-r:${t.index}:${lobby.hostId}`;
}

function timerBar(t, onExpire) {
  if (!t.deadline) return null;
  const offset = t.serverNow - Date.now();
  const total = t.timer * 1000;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
  let started = false;
  let fired = false;
  const tick = () => {
    if (started && !el.isConnected) return;
    started = true;
    const left = Math.max(0, t.deadline - (Date.now() + offset));
    fill.style.width = `${Math.min(100, (left / total) * 100)}%`;
    label.textContent = `${Math.ceil(left / 1000)} s`;
    el.classList.toggle('is-urgent', left <= 5_000);
    if (left <= 400 && !fired) {
      fired = true;
      onExpire?.();
    }
    if (left > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return el;
}

function header(t, eyebrow) {
  return h(
    'section',
    { class: 'question-card quiz-card tp-head' },
    h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, eyebrow), h('span', { class: 'cat-pill' }, '👯 Tous pareils !')),
    h('h1', { class: 'question tp-question' }, t.question),
  );
}

function buildAnswer(lobby, ctx) {
  const t = lobby.game.tousPareils;
  let sent = t.myAnswer;
  const input = h('input', { type: 'text', class: 'answer-input', maxlength: '40', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'Ta réponse…', 'aria-label': 'Ta réponse' });
  if (sent) input.value = sent;
  const info = h('p', { class: 'tp-sent' });
  const showInfo = () => {
    info.textContent = sent ? `✓ Envoyé : « ${sent} » — tu peux encore changer` : 'Écris ce que les autres vont écrire 😉';
    info.classList.toggle('is-sent', Boolean(sent));
  };
  showInfo();
  const send = async (quiet = false) => {
    const text = input.value.trim();
    if (!text) {
      if (!quiet) ctx.toast('Écris une réponse 😉', 'error');
      return;
    }
    if (text === sent) return;
    const payload = { index: t.index, text };
    const res = quiet ? await ctx.emit('tp:answer', payload) : await ctx.action('tp:answer', payload);
    if (res.ok) {
      sent = text;
      showInfo();
      if (!quiet) input.blur();
    }
  };
  const status = h('div', { class: 'stack' });
  const el = h(
    'div',
    { class: 'stack' },
    header(t, `Question ${t.index + 1} sur ${t.total}`),
    timerBar(t, () => send(true)),
    h('form', { class: 'card tp-form', onSubmit: (event) => { event.preventDefault(); send(); } }, h('div', { class: 'answer-card' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Envoyer')), info),
    status,
  );
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  const update = (lobbyNow) => {
    const now = lobbyNow.game.tousPareils;
    if (!now) return;
    status.replaceChildren(...[ctx.renderProgress('Réponses', lobbyNow.players, now.doneIds), ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Révéler maintenant ⏭') : null].filter(Boolean));
  };
  return { el, update };
}

function buildReveal(lobby, ctx) {
  const t0 = lobby.game.tousPareils;
  let picked = null; // groupe choisi par l'hôte pour une fusion
  const list = h('div', { class: 'tp-groups' });
  const tip = h('p', { class: 'tp-merge-tip' });
  const scoresCard = h('section', { class: 'card' });
  const nextZone = h('div');
  const el = h('div', { class: 'stack' }, header(t0, `Résultat · question ${lobby.game.round}/${lobby.game.totalRounds}`), tip, list, nextZone, scoresCard);
  let current = lobby;
  const draw = () => {
    const { game } = current;
    const r = game.result;
    if (!r) return;
    const host = ctx.isHost();
    const top = r.groups[0]?.members.length ?? 0;
    tip.textContent = host ? (picked ? 'Maintenant, touche la réponse avec laquelle la fusionner (ou retouche-la pour annuler).' : '👑 Deux réponses veulent dire la même chose ? Touche-les l’une après l’autre pour les fusionner.') : '';
    tip.hidden = !host;
    list.replaceChildren(
      ...r.groups.map((g, i) => {
        const size = g.members.length;
        const isTop = top >= 2 && size === top;
        return h(
          host ? 'button' : 'section',
          {
            ...(host
              ? {
                  type: 'button',
                  onClick: async () => {
                    if (!picked) picked = g.id;
                    else if (picked === g.id) picked = null;
                    else {
                      const from = picked;
                      picked = null;
                      await ctx.action('tp:merge', { from, into: g.id });
                    }
                    draw();
                  },
                }
              : {}),
            class: `card tp-group${isTop ? ' is-top' : ''}${size === 1 ? ' is-alone' : ''}${picked === g.id ? ' is-picked' : ''}`,
            style: `--i:${i}`,
          },
          h('div', { class: 'tp-group-head' }, h('strong', { class: 'tp-label' }, g.label), h('span', { class: 'tp-count' }, `×${size}`), isTop ? h('span', { class: 'tp-crown', title: 'Réponse la plus populaire' }, '👑') : null),
          h(
            'div',
            { class: 'tp-members' },
            g.members.map((m) => {
              const p = ctx.getPlayer(m.playerId);
              const gain = r.gains?.[m.playerId] ?? 0;
              return h('span', { class: 'tp-member', title: m.text }, ctx.avatar(p, 'sm'), h('span', {}, p.name), m.text !== g.label ? h('em', {}, `« ${m.text} »`) : null, gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null);
            }),
          ),
        );
      }),
    );
    const last = game.round >= game.totalRounds;
    nextZone.replaceChildren(host ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Question suivante →') : ctx.renderWaiting('L’hôte va lancer la suite…'));
    const scores = current.players.map((p) => ({ player: p, total: r.scores?.[p.id] ?? 0, gain: r.gains?.[p.id] ?? 0 })).sort((a, b) => b.total - a.total);
    scoresCard.replaceChildren(h('h2', {}, 'Scores'), h('ol', { class: 'final-list' }, scores.map(({ player, total, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(total))))));
  };
  const update = (lobbyNow) => {
    current = lobbyNow;
    if (picked && !lobbyNow.game.result?.groups.some((g) => g.id === picked)) picked = null;
    draw();
  };
  return { el, update };
}

export function buildTousPareilsScreen(lobby, ctx) {
  return lobby.game.tousPareils.phase === 'tp-answer' ? buildAnswer(lobby, ctx) : buildReveal(lobby, ctx);
}
