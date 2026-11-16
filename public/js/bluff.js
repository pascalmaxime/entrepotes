// Bluff (façon Fibbage) : réglages, écriture du mensonge, vote, révélation.
// Les écrans sont conservés entre deux messages du serveur (on ne perd pas la saisie).
import { h } from './dom.js';

const CAT_INFO = {
  animaux: { label: 'Animaux', emoji: '🐾' },
  histoire: { label: 'Histoire', emoji: '📜' },
  marques: { label: 'Inventions', emoji: '💡' },
  sciences: { label: 'Sciences', emoji: '🔬' },
  mots: { label: 'Mots', emoji: '🔤' },
  monde: { label: 'Monde', emoji: '🌍' },
  sport: { label: 'Sport', emoji: '🏅' },
  bouffe: { label: 'Bouffe', emoji: '🍔' },
};
const catInfo = (id) => CAT_INFO[id] ?? { label: id, emoji: '❓' };
const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const names = (ctx, ids) => ids.map((id) => ctx.getPlayer(id).name).join(', ').replace(/, ([^,]*)$/, ' et $1');

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderBluffSettings(lobby, host, ctx) {
  const limits = lobby.limits.bluff;
  if (!limits) return null;
  const s = lobby.settings.bluff;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const toggle = (id) => {
    const next = s.categories.includes(id) ? s.categories.filter((c) => c !== id) : [...s.categories, id];
    if (next.length === 0) return ctx.toast('Garde au moins une catégorie 😉', 'error');
    set({ blCategories: next });
  };
  const choices = (list, value, key) =>
    h('div', { class: 'timer-choices' }, list.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, `${v} s`)));
  const switchRow = (on, label, emoji, onClick) =>
    h(
      'button',
      { type: 'button', class: `cat-toggle${on ? ' is-on' : ''}`, 'aria-pressed': String(on), disabled: !host, onClick },
      h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, emoji),
      h('span', { class: 'cat-label' }, label),
      h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
    );
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Thèmes des questions'),
    h(
      'div',
      { class: 'cat-toggles' },
      limits.categories.map((cat) =>
        h(
          'button',
          { type: 'button', class: `cat-toggle${s.categories.includes(cat.id) ? ' is-on' : ''}`, 'aria-pressed': String(s.categories.includes(cat.id)), disabled: !host || cat.count === 0, onClick: () => toggle(cat.id) },
          h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, cat.emoji),
          h('span', { class: 'cat-label', title: `${cat.count} questions` }, cat.label),
          h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
        ),
      ),
    ),
    h('span', { class: 'rounds-label' }, 'Temps pour inventer son mensonge'),
    choices(limits.write, s.write, 'blWrite'),
    h('span', { class: 'rounds-label' }, 'Temps pour voter'),
    choices(limits.vote, s.vote, 'blVote'),
    h('div', { class: 'cat-toggles' }, switchRow(s.double, 'Dernière question : points doublés', '🔥', () => set({ blDouble: !s.double }))),
    h(
      'p',
      { class: 'hint hint-left' },
      `Une anecdote vraie avec un trou. Chacun invente une fausse réponse crédible, puis on cherche la vraie au milieu des mensonges : +${limits.points.truth} pts si tu la trouves, +${limits.points.fooled} pt par joueur piégé par ton mensonge. À partir de ${limits.minPlayers} joueurs.`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function bluffScreenKey(lobby, ui) {
  const b = lobby.game.bluff;
  if (b.phase === 'bl-write') return `bl-w:${b.index}:${Boolean(b.myLie) && !ui.blEditing}`;
  if (b.phase === 'bl-vote') return `bl-v:${b.index}:${b.myVote}`;
  return `bl-r:${b.index}:${lobby.hostId}`;
}

export function buildBluffScreen(lobby, ctx, ui) {
  const b = lobby.game.bluff;
  if (b.phase === 'bl-write') return buildWrite(lobby, ctx, ui);
  if (b.phase === 'bl-vote') return buildVote(lobby, ctx);
  return buildReveal(lobby, ctx);
}

// La phrase avec son trou : « Napoléon a été attaqué par une horde de [ ? ] »
function sentence(prompt, filler = null, fillerClass = '', revealAt = 0) {
  const [before, after = ''] = prompt.split('_____');
  return h('h1', { class: 'question bl-sentence' }, before, h('span', { class: `bl-blank${filler ? ` ${fillerClass}` : ''}`, style: `--reveal-at:${revealAt}` }, filler ?? '?'), after);
}

function header(b, filler, fillerClass, eyebrow, revealAt = 0) {
  const info = catInfo(b.question.cat);
  return h(
    'section',
    { class: 'question-card quiz-card' },
    h(
      'div',
      { class: 'quiz-head' },
      h('span', { class: 'eyebrow' }, eyebrow ?? `Question ${b.index + 1} sur ${b.total}`),
      h('span', { class: 'cat-pill' }, `${info.emoji} ${info.label}`),
      b.mult > 1 ? h('span', { class: 'pts-pill' }, '🔥 Points x2') : null,
    ),
    sentence(b.question.prompt, filler, fillerClass, revealAt),
  );
}

function timerBar(b, onExpire) {
  if (!b.deadline) return null;
  const offset = b.serverNow - Date.now();
  const total = b.timer * 1000;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
  let started = false;
  let fired = false;
  const tick = () => {
    if (started && !el.isConnected) return;
    started = true;
    const left = Math.max(0, b.deadline - (Date.now() + offset));
    fill.style.width = `${Math.min(100, (left / total) * 100)}%`;
    label.textContent = `${Math.ceil(left / 1000)} s`;
    el.classList.toggle('is-urgent', left <= 5_000);
    if (left <= 300 && !fired) {
      fired = true;
      onExpire?.();
    }
    if (left > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return el;
}

function statusZone(ctx, label, skipLabel) {
  const status = h('div', { class: 'stack' });
  const update = (current) => {
    status.replaceChildren(
      ...[
        ctx.renderProgress(label, current.players, current.game.bluff?.doneIds ?? []),
        ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, skipLabel) : null,
      ].filter(Boolean),
    );
  };
  return { status, update };
}

function buildWrite(lobby, ctx, ui) {
  const b = lobby.game.bluff;
  const { status, update } = statusZone(ctx, 'Mensonges écrits', 'Passer au vote sans attendre ⏭');

  if (b.myLie && !ui.blEditing) {
    const el = h(
      'div',
      { class: 'stack' },
      header(b),
      timerBar(b),
      h(
        'section',
        { class: 'card voted' },
        h('div', { class: 'voted-check', 'aria-hidden': 'true' }, '🤥'),
        h('p', {}, 'Ton mensonge : ', h('strong', {}, `« ${b.myLie} »`)),
        h('p', { class: 'hint' }, 'Chut… on attend les autres menteurs.'),
        h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { ui.blEditing = true; ctx.rerender(); } }, 'Modifier mon mensonge'),
      ),
      status,
    );
    return { el, update };
  }

  const input = h('input', { type: 'text', class: 'answer-input', maxlength: '60', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'Ton mensonge…', 'aria-label': 'Ton mensonge' });
  if (b.myLie) input.value = b.myLie;
  const send = async (quiet = false) => {
    const text = input.value.trim();
    if (!text) {
      if (!quiet) ctx.toast('Écris un mensonge crédible 😉', 'error');
      return;
    }
    const payload = { index: b.index, text };
    const res = quiet ? await ctx.emit('bl:lie', payload) : await ctx.action('bl:lie', payload);
    if (res.ok) {
      ui.blEditing = false;
      ctx.rerender();
    } else if (!quiet) {
      input.select();
    }
  };
  const idea = async () => {
    const res = await ctx.action('bl:suggest');
    if (res.ok) {
      input.value = res.text;
      input.focus();
    }
  };
  const el = h(
    'div',
    { class: 'stack' },
    header(b),
    timerBar(b, () => send(true)),
    h(
      'form',
      { class: 'card bl-write', onSubmit: (event) => { event.preventDefault(); send(); } },
      h('p', { class: 'bl-tip' }, 'Invente une fausse réponse qui a l’air vraie. Chaque joueur piégé = ', h('strong', {}, 'des points pour toi'), '.'),
      h('div', { class: 'answer-card' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Mentir 🤥')),
      h('button', { type: 'button', class: 'btn btn-ghost bl-idea', onClick: idea }, '💡 Pas d’idée ? Mentir pour moi'),
    ),
    status,
  );
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  return { el, update };
}

function buildVote(lobby, ctx) {
  const b = lobby.game.bluff;
  const { status, update } = statusZone(ctx, 'Votes', 'Révéler maintenant ⏭');
  const vote = (choice) => {
    if (choice.mine) return ctx.toast('C’est ton propre mensonge 😏', 'error');
    if (choice.id !== b.myVote) ctx.action('bl:vote', { index: b.index, choiceId: choice.id });
  };
  const el = h(
    'div',
    { class: 'stack' },
    header(b),
    timerBar(b),
    h('p', { class: 'bl-tip bl-tip-center' }, b.myVote ? 'Vote enregistré ✓ (tu peux encore changer d’avis)' : 'Laquelle est la vraie réponse ? 🕵️'),
    h(
      'div',
      { class: 'bl-choices' },
      b.choices.map((choice, i) =>
        h(
          'button',
          {
            type: 'button',
            class: `bl-choice${choice.mine ? ' is-mine' : ''}${choice.id === b.myVote ? ' is-picked' : ''}`,
            style: `--i:${i}`,
            'aria-pressed': String(choice.id === b.myVote),
            disabled: choice.mine,
            onClick: () => vote(choice),
          },
          h('span', { class: 'bl-choice-text' }, choice.text),
          choice.mine ? h('span', { class: 'bl-tag' }, 'ton mensonge') : null,
          choice.id === b.myVote ? h('span', { class: 'bl-tag bl-tag-pick' }, 'ton choix') : null,
        ),
      ),
    ),
    status,
  );
  return { el, update };
}

// ---------------------------------------------------------------------------
// Révélation : les mensonges un par un, puis la vérité
// ---------------------------------------------------------------------------

function buildReveal(lobby, ctx) {
  const { game } = lobby;
  const b = game.bluff;
  const { result } = game;
  const last = game.round >= game.totalRounds;
  const mult = result.mult;
  const voterChips = (ids) => h('div', { class: 'bl-voters' }, ids.map((id) => h('span', { class: 'bl-voter' }, ctx.avatar(ctx.getPlayer(id), 'sm'), ctx.getPlayer(id).name)));

  const cards = result.choices.map((choice, i) => {
    let who;
    let gain = null;
    if (choice.truth) {
      who = h('span', { class: 'bl-who bl-who-truth' }, '✅ La vraie réponse !');
      gain = choice.voters.length ? `+${2 * mult} pour ${names(ctx, choice.voters)}` : 'Personne ne l’a trouvée 😱';
    } else if (choice.house) {
      who = h('span', { class: 'bl-who' }, '🤖 Leurre du jeu');
    } else {
      who = h('span', { class: 'bl-who' }, `🤥 Mensonge de ${names(ctx, choice.authors)}`);
      if (choice.voters.length) gain = `+${choice.voters.length * mult} pour ${names(ctx, choice.authors)}`;
    }
    return h(
      'li',
      { class: `bl-reveal-card${choice.truth ? ' is-truth' : ''}${choice.voters.length && !choice.truth ? ' is-trap' : ''}`, style: `--i:${i}` },
      h('div', { class: 'bl-reveal-top' }, h('strong', { class: 'bl-reveal-text' }, choice.text), who),
      choice.voters.length
        ? h('div', { class: 'bl-reveal-votes' }, h('small', {}, choice.truth ? 'Trouvée par' : 'Sont tombés dans le piège'), voterChips(choice.voters))
        : h('small', { class: 'bl-nobody' }, choice.truth ? '' : 'Personne n’est tombé dans le piège'),
      gain ? h('span', { class: 'bl-gain' }, gain) : null,
    );
  });

  const scores = lobby.players.map((p) => ({ player: p, total: result.scores?.[p.id] ?? 0, gain: result.gains?.[p.id] ?? 0 })).sort((a, b2) => b2.total - a.total);
  const el = h(
    'div',
    { class: 'stack' },
    header(b, result.answer, 'is-filled', `Réponse · question ${game.round}/${game.totalRounds}`, (cards.length - 1) * 0.9),
    h('ol', { class: 'bl-reveal' }, cards),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big bl-next', style: `--i:${cards.length}`, onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Question suivante →')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h(
      'section',
      { class: 'card bl-scores', style: `--i:${cards.length}` },
      h('h2', {}, 'Scores'),
      h(
        'ol',
        { class: 'final-list' },
        scores.map(({ player, total, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(total)))),
      ),
    ),
  );
  return { el, update: () => {} };
}

// Carte « mensonge de la soirée » sur l'écran de fin.
export function renderBluffBest(final, ctx) {
  const best = final.bluff?.bestLie;
  if (!best) return null;
  return h(
    'section',
    { class: 'card bl-best' },
    h('span', { class: 'eyebrow' }, '🏆 Mensonge de la soirée'),
    h('strong', { class: 'bl-best-text' }, `« ${best.text} »`),
    h('p', {}, `par ${names(ctx, best.authors)} · ${best.fooled} joueur${best.fooled > 1 ? 's' : ''} piégé${best.fooled > 1 ? 's' : ''}`),
  );
}
