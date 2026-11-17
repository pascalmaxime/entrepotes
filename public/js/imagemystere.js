// Image Mystère (façon Dixit) : réglages, main d'images, phrase du conteur, pose, vote, révélation.
import { h } from './dom.js';

const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderImageMystereSettings(lobby, host, ctx) {
  const limits = lobby.limits.imageMystere;
  if (!limits) return null;
  const s = lobby.settings.imageMystere;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (values, value, key, label) =>
    h('div', { class: 'timer-choices' }, values.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  const n = limits.players;
  const enough = limits.images >= limits.imagesNeeded;
  const p = limits.points;
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, `Tours (chacun est conteur ${s.turns} fois${n ? ` → ${n * s.turns} manches` : ''})`),
    choices(limits.turns, s.turns, 'imTurns', (v) => `${v}`),
    h('span', { class: 'rounds-label' }, 'Chrono par étape (phrase, pose, vote)'),
    choices(limits.timers, s.timer, 'imTimer', (v) => `${v} s`),
    h('p', { class: `hint hint-left im-library${enough ? '' : ' is-low'}` }, enough ? `🖼️ ${limits.images} images dans la bibliothèque Top Meme : c’est bon.` : `⚠️ Il faut au moins ${limits.imagesNeeded} images dans la bibliothèque Top Meme (il y en a ${limits.images}). Importe le pack d’images depuis l’espace admin.`),
    h(
      'p',
      { class: 'hint hint-left' },
      `Chacun a ${limits.handSize} images. Le conteur en choisit une et dit une phrase ; les autres posent l’image de leur main qui colle le mieux, puis cherchent celle du conteur. Si tout le monde ou personne la trouve, le conteur marque 0 et les autres ${p.allOrNone}. Sinon le conteur et ceux qui l’ont trouvée marquent ${p.storyteller}. +${p.perVote} par vote reçu sur ton image. À partir de ${limits.minPlayers} joueurs.`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function imageMystereScreenKey(lobby) {
  const m = lobby.game.imageMystere;
  return `im:${m.index}:${m.phase}:${m.isTeller}:${m.phase === 'im-reveal' ? lobby.hostId : ''}`;
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

function header(m, ctx, eyebrow) {
  const teller = ctx.getPlayer(m.teller);
  return h(
    'section',
    { class: 'question-card quiz-card im-head' },
    h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, eyebrow ?? `Manche ${m.index + 1} sur ${m.total}`), h('span', { class: 'cat-pill' }, `🎙️ Conteur : ${teller.name}`)),
    m.phrase ? h('h1', { class: 'question im-phrase' }, `« ${m.phrase} »`) : null,
  );
}

// Une grille d'images cliquables.
function gallery(cards, { selected = null, onPick = null, tag = null, big = false } = {}) {
  return h(
    'div',
    { class: `im-grid${big ? ' is-big' : ''}` },
    cards.map((c, i) =>
      h(
        onPick ? 'button' : 'div',
        {
          ...(onPick ? { type: 'button', onClick: () => onPick(c) } : {}),
          class: `im-card${c.id === selected ? ' is-selected' : ''}${c.mine ? ' is-mine' : ''}`,
          style: `--i:${i}`,
          'aria-pressed': onPick ? String(c.id === selected) : undefined,
          'aria-label': `Image ${i + 1}`,
        },
        h('img', { src: c.url, alt: '', loading: 'lazy', draggable: 'false' }),
        tag?.(c),
      ),
    ),
  );
}

function progressZone(ctx, label, skipLabel, field) {
  const zone = h('div', { class: 'stack' });
  const update = (lobbyNow) => {
    const m = lobbyNow.game.imageMystere;
    if (!m) return;
    const players = lobbyNow.players.filter((p) => p.id !== m.teller);
    zone.replaceChildren(...[ctx.renderProgress(label, players, m[field]), ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, skipLabel) : null].filter(Boolean));
  };
  return { zone, update };
}

function buildTell(lobby, ctx) {
  const m = lobby.game.imageMystere;
  const teller = ctx.getPlayer(m.teller);
  if (!m.isTeller) {
    const host = h('div');
    const el = h(
      'div',
      { class: 'stack' },
      header(m, ctx),
      timerBar(m),
      h('section', { class: 'card im-wait' }, ctx.avatar(teller, 'lg'), ctx.renderWaiting(`${teller.name} choisit une image et invente une phrase…`)),
      h('section', { class: 'card' }, h('h2', {}, 'Ta main'), h('p', { class: 'hint' }, 'Prépare-toi : tu poseras l’image qui colle le mieux à sa phrase.'), gallery(m.hand)),
      host,
    );
    return { el, update: () => host.replaceChildren(...(ctx.isHost() ? [h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, `${teller.name} n’est pas là ? Passer son tour ⏭`)] : [])) };
  }
  let selected = null;
  const grid = h('div');
  const draw = () => grid.replaceChildren(gallery(m.hand, { selected, onPick: (c) => { selected = c.id; draw(); } }));
  draw();
  const input = h('input', { type: 'text', class: 'answer-input', maxlength: '60', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'Ta phrase : un mot, un titre, un bruit…', 'aria-label': 'Ta phrase' });
  const send = async () => {
    if (!selected) return ctx.toast('Choisis d’abord une image 👆', 'error');
    const phrase = input.value.trim();
    if (!phrase) return ctx.toast('Écris ta phrase 😉', 'error');
    await ctx.action('im:tell', { cardId: selected, phrase });
  };
  const el = h(
    'div',
    { class: 'stack' },
    header(m, ctx, 'Tu es le conteur 🎙️'),
    timerBar(m),
    h('section', { class: 'card' }, h('h2', {}, '1. Choisis une image'), grid),
    h(
      'form',
      { class: 'card im-tell-form', onSubmit: (event) => { event.preventDefault(); send(); } },
      h('h2', {}, '2. Ta phrase'),
      h('p', { class: 'hint' }, 'Ni trop évidente, ni trop obscure : si tout le monde ou personne trouve ton image, tu ne marques rien !'),
      h('div', { class: 'answer-card' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Valider 🎙️')),
    ),
  );
  return { el, update: () => {} };
}

function buildPlay(lobby, ctx) {
  const m0 = lobby.game.imageMystere;
  const pz = progressZone(ctx, 'Images posées', 'Passer au vote sans attendre ⏭', 'playedIds');
  const body = h('div', { class: 'stack' });
  const el = h('div', { class: 'stack' }, header(m0, ctx), timerBar(m0), body, pz.zone);
  const update = (lobbyNow) => {
    const m = lobbyNow.game.imageMystere;
    if (!m) return;
    if (m.isTeller) {
      const mine = m.hand.find((c) => c.id === m.myCard);
      body.replaceChildren(h('section', { class: 'card im-wait' }, h('p', { class: 'hint' }, 'Ton image (chut !)'), mine ? gallery([mine], { big: true }) : null, h('p', { class: 'im-tip' }, 'Les autres cherchent dans leur main l’image qui colle le mieux à ta phrase…')));
    } else {
      body.replaceChildren(
        h('p', { class: 'im-tip im-center' }, m.myCard ? '✓ Image posée — touche une autre image pour changer d’avis' : 'Touche l’image de ta main qui colle le mieux à la phrase'),
        gallery(m.hand, { selected: m.myCard, onPick: (c) => c.id !== m.myCard && ctx.action('im:play', { cardId: c.id }), tag: (c) => (c.id === m.myCard ? h('span', { class: 'im-tag' }, 'posée') : null) }),
      );
    }
    pz.update(lobbyNow);
  };
  return { el, update };
}

function buildVote(lobby, ctx) {
  const m0 = lobby.game.imageMystere;
  const pz = progressZone(ctx, 'Votes', 'Révéler maintenant ⏭', 'votedIds');
  const body = h('div', { class: 'stack' });
  const el = h('div', { class: 'stack' }, header(m0, ctx), timerBar(m0), body, pz.zone);
  const update = (lobbyNow) => {
    const m = lobbyNow.game.imageMystere;
    if (!m) return;
    const tag = (c) => (c.mine ? h('span', { class: 'im-tag im-tag-mine' }, m.isTeller ? 'ton image' : 'ta carte') : c.id === m.myVote ? h('span', { class: 'im-tag' }, 'ton vote') : null);
    body.replaceChildren(
      h('p', { class: 'im-tip im-center' }, m.isTeller ? 'Les autres cherchent ton image… croise les doigts 🤞' : m.myVote ? '✓ Vote enregistré (tu peux encore changer)' : `Laquelle est l’image de ${ctx.getPlayer(m.teller).name} ? 🕵️`),
      gallery(m.choices, {
        selected: m.myVote,
        onPick: m.isTeller ? null : (c) => (c.mine ? ctx.toast('C’est ta carte, cherche celle du conteur 😉', 'error') : c.id !== m.myVote && ctx.action('im:vote', { choiceId: c.id })),
        tag,
      }),
    );
    pz.update(lobbyNow);
  };
  return { el, update };
}

function buildReveal(lobby, ctx) {
  const { game } = lobby;
  const m = game.imageMystere;
  const r = game.result;
  const last = game.round >= game.totalRounds;
  const teller = ctx.getPlayer(r.teller);
  const verdict = r.allOrNone
    ? r.nobody
      ? `Personne n’a trouvé l’image de ${teller.name} : trop obscur ! Il ne marque rien, les autres +2.`
      : `Tout le monde a trouvé l’image de ${teller.name} : trop facile ! Il ne marque rien, les autres +2.`
    : `${teller.name} et ceux qui ont trouvé son image marquent +3.`;
  const cards = [...r.cards].sort((a, b) => Number(b.teller) - Number(a.teller));
  const scores = lobby.players.map((p) => ({ player: p, total: r.scores?.[p.id] ?? 0, gain: r.gains?.[p.id] ?? 0 })).sort((a, b) => b.total - a.total);
  const el = h(
    'div',
    { class: 'stack' },
    header(m, ctx, `Réponse · manche ${game.round}/${game.totalRounds}`),
    h('p', { class: `im-verdict${r.allOrNone ? ' is-fail' : ''}` }, verdict),
    h(
      'div',
      { class: 'im-grid is-reveal' },
      cards.map((c, i) => {
        const owner = ctx.getPlayer(c.owner);
        return h(
          'div',
          { class: `im-card is-revealed${c.teller ? ' is-teller' : ''}`, style: `--i:${i}` },
          h('img', { src: c.url, alt: '' }),
          h('div', { class: 'im-owner' }, ctx.avatar(owner, 'sm'), h('strong', {}, c.teller ? `🎙️ ${owner.name}` : owner.name)),
          h('div', { class: 'im-voters' }, c.voters.length ? [h('small', {}, c.teller ? 'Trouvée par' : 'Piégés :'), ...c.voters.map((id) => ctx.avatar(ctx.getPlayer(id), 'sm'))] : h('small', {}, c.teller ? 'Personne 😱' : 'Aucun vote')),
        );
      }),
    ),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Manche suivante →')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h('section', { class: 'card' }, h('h2', {}, 'Scores'), h('ol', { class: 'final-list' }, scores.map(({ player, total, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(total)))))),
  );
  return { el, update: () => {} };
}

export function buildImageMystereScreen(lobby, ctx) {
  const m = lobby.game.imageMystere;
  if (m.phase === 'im-tell') return buildTell(lobby, ctx);
  if (m.phase === 'im-play') return buildPlay(lobby, ctx);
  if (m.phase === 'im-vote') return buildVote(lobby, ctx);
  return buildReveal(lobby, ctx);
}

// Le meilleur leurre de la soirée, sur l'écran de fin.
export function renderImageMystereBest(final, ctx) {
  const b = final.im?.best;
  if (!b) return null;
  return h(
    'section',
    { class: 'card bl-best im-best' },
    h('span', { class: 'eyebrow' }, '🃏 Le meilleur leurre de la soirée'),
    h('img', { src: b.cardUrl, alt: '', class: 'im-best-img' }),
    h('p', {}, `${ctx.getPlayer(b.owner).name} a piégé ${b.votes} joueur${b.votes > 1 ? 's' : ''} sur « ${b.phrase} »`),
  );
}
