// L'Imposteur : réglages, mot secret, indices, vote, élimination, fin de manche.
// Chaque écran est conservé entre deux messages du serveur (on ne perd pas la saisie) :
// seule la zone d'avancement est mise à jour, sauf si l'écran doit vraiment changer.
import { h } from './dom.js';

const ROLE = {
  civil: { label: 'Civil', emoji: '🙂', className: 'role-civil' },
  impostor: { label: 'Imposteur', emoji: '🕵️', className: 'role-impostor' },
  white: { label: 'Mr. White', emoji: '👻', className: 'role-white' },
};
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function composition({ civils, impostors, whites }) {
  return h(
    'div',
    { class: 'imp-compo' },
    h('span', { class: 'compo-pill role-civil' }, `🙂 ${plural(civils, 'civil', 'civils')}`),
    h('span', { class: 'compo-pill role-impostor' }, `🕵️ ${plural(impostors, 'imposteur', 'imposteurs')}`),
    whites ? h('span', { class: 'compo-pill role-white' }, `👻 ${whites} Mr. White`) : null,
  );
}

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderImpostorSettings(lobby, host, ctx) {
  const limits = lobby.limits.impostor;
  if (!limits) return null;
  const { clueMode } = lobby.settings.impostor;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const stepper = (label, value, min, max, key) =>
    h(
      'div',
      { class: 'rounds' },
      h('span', { class: 'rounds-label' }, label),
      host
        ? h(
            'div',
            { class: 'stepper' },
            h('button', { type: 'button', class: 'step', 'aria-label': `${label} : moins`, disabled: value <= min, onClick: () => set({ [key]: value - 1 }) }, '−'),
            h('span', { class: 'step-value', 'aria-live': 'polite' }, value),
            h('button', { type: 'button', class: 'step', 'aria-label': `${label} : plus`, disabled: value >= max, onClick: () => set({ [key]: value + 1 }) }, '+'),
          )
        : h('strong', {}, value),
    );

  return h(
    'div',
    { class: 'imp-settings' },
    stepper('🕵️ Imposteurs', limits.impostors, 1, limits.impostorsMax, 'impostors'),
    stepper('👻 Mr. White', limits.whites, 0, limits.whitesMax, 'whites'),
    limits.playerCount >= 4
      ? composition(limits)
      : h('p', { class: 'hint hint-left' }, 'Il faut au moins 4 joueurs. Les rôles s’ajustent tout seuls au nombre de joueurs.'),
    h('span', { class: 'rounds-label' }, 'Les indices'),
    h(
      'div',
      { class: 'timer-choices', role: 'group', 'aria-label': 'Les indices' },
      [
        ['ecrit', '✍️ Écrits sur le téléphone'],
        ['oral', '🗣️ À voix haute'],
      ].map(([value, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: `timer-choice${value === clueMode ? ' is-active' : ''}`,
            'aria-pressed': String(value === clueMode),
            disabled: !host,
            onClick: () => value !== clueMode && set({ clueMode: value }),
          },
          label,
        ),
      ),
    ),
    h(
      'details',
      { class: 'imp-rules' },
      h('summary', {}, 'Comment on joue ?'),
      h(
        'ul',
        {},
        h('li', {}, 'Les civils ont tous le même mot. L’imposteur a un mot proche… et ne sait pas qu’il est l’imposteur !'),
        h('li', {}, 'Mr. White n’a pas de mot : il écoute les indices et bluffe.'),
        h('li', {}, 'Chacun donne un indice à son tour, puis tout le monde vote pour éliminer quelqu’un.'),
        h('li', {}, 'Mr. White éliminé peut tenter de deviner le mot des civils : s’il trouve, il gagne seul.'),
        h('li', {}, 'Les civils gagnent quand tous les infiltrés sont éliminés ; les infiltrés gagnent s’il ne reste qu’un civil.'),
        h('li', {}, 'Points : civils 2, imposteurs 10, Mr. White 6 (10 s’il trouve le mot).'),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Écrans de jeu
// ---------------------------------------------------------------------------

// Clé qui décide quand reconstruire l'écran.
export function impostorScreenKey(lobby) {
  const imp = lobby.game.impostor;
  const you = lobby.you ?? {};
  const parts = [lobby.state, imp.manche, imp.tour];
  if (lobby.state === 'reveal') parts.push(you.ready);
  if (lobby.state === 'clues') parts.push(imp.speaker, imp.clues.at(-1)?.entries.length);
  if (lobby.state === 'ballot') parts.push(imp.revote, you.vote, imp.candidates.join());
  if (lobby.state === 'elimination') parts.push(imp.elimination?.awaitingGuess, imp.elimination?.guess?.text, Boolean(imp.outcome));
  return `imp:${parts.join(':')}`;
}

export function buildImpostorScreen(lobby, ctx) {
  const view = {
    reveal: buildReveal,
    clues: buildClues,
    ballot: buildBallot,
    elimination: buildElimination,
    'round-end': buildRoundEnd,
  }[lobby.state];
  return view(lobby, ctx);
}

function header(lobby, title, hint) {
  const imp = lobby.game.impostor;
  return h(
    'section',
    { class: 'question-card is-compact imp-card' },
    h('span', { class: 'eyebrow' }, `Manche ${imp.manche} sur ${imp.totalManches}${imp.tour ? ` · tour ${imp.tour}` : ''}`),
    h('h1', { class: 'question' }, title),
    hint ? h('p', { class: 'question-hint' }, hint) : null,
  );
}

// Le mot secret, caché par défaut (les voisins regardent peut-être l'écran 👀).
function secretWord(lobby, { big = false } = {}) {
  const you = lobby.you;
  if (!you) return h('p', { class: 'hint' }, 'Tu regardes cette manche.');
  const content = you.isWhite
    ? h('span', { class: 'secret-value' }, '👻 Tu es Mr. White')
    : h('span', { class: 'secret-value' }, you.word);
  const box = h(
    'button',
    { type: 'button', class: `secret${big ? ' secret-big' : ''}`, 'aria-label': 'Afficher ou cacher mon mot' },
    h('span', { class: 'secret-label' }, you.isWhite ? 'Ton rôle' : 'Ton mot'),
    content,
    h('span', { class: 'secret-hidden' }, '👆 Touche pour voir'),
  );
  box.addEventListener('click', () => box.classList.toggle('is-shown'));
  return box;
}

function statusZone(build) {
  const zone = h('div', { class: 'stack' });
  return { zone, update: (lobby) => zone.replaceChildren(...build(lobby).filter(Boolean)) };
}

function hostButton(ctx, label, event, disabled = false) {
  return ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', disabled, onClick: () => ctx.action(event) }, label) : null;
}

function cluesList(lobby, ctx, { onlyCurrent = false } = {}) {
  const imp = lobby.game.impostor;
  const tours = onlyCurrent ? imp.clues.slice(-1) : [...imp.clues].reverse();
  if (!tours.length || !tours.some((t) => t.entries.length)) return null;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, onlyCurrent ? 'Indices de ce tour' : 'Tous les indices'),
    tours.map((tour) =>
      h(
        'div',
        { class: 'clue-tour' },
        onlyCurrent || imp.clues.length === 1 ? null : h('span', { class: 'eyebrow' }, `Tour ${tour.tour}`),
        h(
          'ul',
          { class: 'clue-list' },
          tour.entries.map(({ playerId, text }) =>
            h('li', {}, ctx.avatar(ctx.getPlayer(playerId), 'sm'), h('span', { class: 'clue-name' }, ctx.getPlayer(playerId).name), h('strong', { class: 'clue-text' }, text)),
          ),
        ),
      ),
    ),
  );
}

// ----- 1. Chacun découvre son mot -----

function buildReveal(lobby, ctx) {
  const imp = lobby.game.impostor;
  const you = lobby.you;
  const status = statusZone((current) => [
    ctx.renderProgress('Prêts', current.players, current.game.impostor.readyIds),
    hostButton(ctx, 'Commencer sans attendre', 'game:reveal'),
  ]);
  const el = h(
    'div',
    { class: 'stack' },
    header(lobby, 'Découvre ton mot en secret 🤫', 'Cache ton écran, touche la carte, mémorise… et ne dis rien !'),
    composition(imp.composition),
    secretWord(lobby, { big: true }),
    you?.isWhite
      ? h('p', { class: 'hint' }, 'Tu n’as pas de mot : écoute bien les indices des autres et fais semblant 😏')
      : h('p', { class: 'hint' }, 'Attention : l’imposteur ne sait pas qu’il est l’imposteur… c’est peut-être toi 👀'),
    you && !you.ready
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('imp:ready') }, 'C’est bon, j’ai retenu ✓')
      : ctx.renderWaiting('On attend que tout le monde ait vu son mot…'),
    status.zone,
  );
  return { el, update: status.update };
}

// ----- 2. Indices -----

function buildClues(lobby, ctx) {
  const imp = lobby.game.impostor;
  const me = ctx.me();
  const oral = imp.clueMode === 'oral';
  const speaker = imp.speaker ? ctx.getPlayer(imp.speaker) : null;
  const given = new Set((imp.clues.at(-1)?.entries ?? []).map((e) => e.playerId));
  const myTurn = !oral && imp.speaker === me;

  const order = h(
    'ol',
    { class: 'speak-order' },
    imp.order.map((id, index) => {
      const p = ctx.getPlayer(id);
      const isCurrent = !oral && id === imp.speaker;
      return h(
        'li',
        { class: `${isCurrent ? 'is-current' : ''}${given.has(id) ? ' is-done' : ''}${p.connected ? '' : ' is-offline'}` },
        h('span', { class: 'speak-rank' }, index + 1),
        ctx.avatar(p, 'sm'),
        h('span', { class: 'speak-name' }, p.name, id === me ? h('span', { class: 'you' }, ' (toi)') : null),
        given.has(id) ? h('span', { class: 'tick-inline' }, '✓') : isCurrent ? h('span', { class: 'badge' }, '✍️ écrit…') : null,
      );
    }),
  );

  let action = null;
  if (myTurn) {
    const input = h('input', { type: 'text', class: 'answer-input', maxlength: '40', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', placeholder: 'Ton indice…', 'aria-label': 'Ton indice' });
    action = h(
      'form',
      {
        class: 'card answer-card is-turn',
        onSubmit: async (event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (!text) return ctx.toast('Écris un indice 😉', 'error');
          await ctx.action('imp:clue', { text });
        },
      },
      input,
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Envoyer'),
    );
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  } else if (oral) {
    action = h('p', { class: 'hint imp-oral' }, '🗣️ Chacun dit UN mot à voix haute, dans l’ordre ci-dessous. Quand tout le monde a parlé, l’hôte lance le vote.');
  } else if (speaker) {
    action = ctx.renderWaiting(`${speaker.name} cherche son indice…`);
  }

  const status = statusZone(() => [
    oral ? hostButton(ctx, 'Tout le monde a parlé → voter 🗳️', 'game:reveal') : speaker && speaker.id !== me ? hostButton(ctx, `Passer le tour de ${speaker.name}`, 'game:reveal') : null,
  ]);

  const el = h(
    'div',
    { class: 'stack' },
    header(lobby, myTurn ? 'À toi ! Donne un indice' : oral ? 'Les indices, à voix haute' : 'Les indices', myTurn ? 'Pas trop précis (l’imposteur écoute), pas trop vague (on te soupçonnerait)…' : null),
    secretWord(lobby),
    action,
    h('section', { class: 'card' }, h('h2', {}, 'Ordre de parole'), order),
    cluesList(lobby, ctx),
    status.zone,
  );
  return { el, update: status.update };
}

// ----- 3. Vote -----

function buildBallot(lobby, ctx) {
  const imp = lobby.game.impostor;
  const me = ctx.me();
  const you = lobby.you;
  const alive = you?.alive;

  const tiles = h(
    'section',
    { class: 'vote-grid' },
    imp.candidates
      .filter((id) => id !== me)
      .map((id) => {
        const p = ctx.getPlayer(id);
        const picked = you?.vote === id;
        return h(
          'button',
          { type: 'button', class: `vote-tile${picked ? ' is-picked' : ''}`, disabled: !alive, onClick: () => !picked && ctx.action('imp:vote', { target: id }) },
          ctx.avatar(p, 'lg'),
          h('span', { class: 'vote-name' }, p.name),
          picked ? h('span', { class: 'you' }, 'ton vote') : null,
        );
      }),
  );

  const status = statusZone((current) => [
    ctx.renderProgress('Votes', current.players.filter((p) => current.game.impostor.alive.includes(p.id)), current.game.impostor.votedIds),
    hostButton(ctx, 'Révéler les votes maintenant', 'game:reveal', current.game.impostor.votedIds.length === 0),
  ]);

  const el = h(
    'div',
    { class: 'stack' },
    header(
      lobby,
      imp.revote ? 'Égalité ! On revote' : 'Qui est l’imposteur ?',
      imp.revote ? 'Seulement entre les ex aequo.' : alive ? 'Vote pour éliminer quelqu’un. Tu peux changer d’avis tant que tout le monde n’a pas voté.' : null,
    ),
    alive ? null : h('section', { class: 'card voted' }, h('p', {}, '💀 Tu es éliminé : tu regardes la suite sans voter.')),
    alive && you?.vote ? h('p', { class: 'hint' }, 'Vote enregistré ✓ On attend les autres…') : null,
    tiles,
    secretWord(lobby),
    cluesList(lobby, ctx),
    status.zone,
  );
  return { el, update: status.update };
}

// ----- 4. Élimination -----

function voteBars(results, ctx) {
  const max = Math.max(1, ...results.map((r) => r.votes));
  return h(
    'ul',
    { class: 'bars' },
    results.map((entry) => {
      const p = ctx.getPlayer(entry.playerId);
      return h(
        'li',
        { class: 'bar-row' },
        ctx.avatar(p, 'sm'),
        h('span', { class: 'bar-name' }, p.name),
        h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${(entry.votes / max) * 100}%` })),
        h('strong', { class: 'bar-count' }, entry.votes),
      );
    }),
  );
}

const OUTCOME = {
  civils: { title: 'Les civils gagnent ! 🎉', className: 'role-civil' },
  infiltres: { title: 'Les infiltrés gagnent ! 😈', className: 'role-impostor' },
  white: { title: 'Mr. White a trouvé le mot ! 👻', className: 'role-white' },
};

function buildElimination(lobby, ctx) {
  const imp = lobby.game.impostor;
  const elim = imp.elimination;
  const me = ctx.me();
  const player = elim.playerId ? ctx.getPlayer(elim.playerId) : null;
  const role = elim.role ? ROLE[elim.role] : null;

  let guessZone = null;
  if (elim.awaitingGuess) {
    if (elim.playerId === me) {
      const input = h('input', { type: 'text', class: 'answer-input', maxlength: '40', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', placeholder: 'Le mot des civils…', 'aria-label': 'Le mot des civils' });
      guessZone = h(
        'form',
        {
          class: 'card answer-card is-turn',
          onSubmit: async (event) => {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) return ctx.toast('Tente un mot !', 'error');
            await ctx.action('imp:guess', { text });
          },
        },
        input,
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Tenter'),
      );
      setTimeout(() => input.isConnected && input.focus(), 50);
    } else {
      guessZone = ctx.renderWaiting(`👻 ${player.name} tente de deviner le mot des civils…`);
    }
  } else if (elim.guess) {
    guessZone = h(
      'p',
      { class: `guess-result ${elim.guess.correct ? 'is-correct' : 'is-wrong'}` },
      elim.guess.text ? ['Mr. White a proposé « ', h('strong', {}, elim.guess.text), elim.guess.correct ? ' » : TROUVÉ ! 😱' : ' » : raté !'] : 'Mr. White n’a rien proposé.',
    );
  }

  const outcome = imp.outcome ? OUTCOME[imp.outcome.winner] : null;
  const status = statusZone(() => [
    elim.awaitingGuess ? hostButton(ctx, 'Mr. White ne répond pas : passer', 'game:reveal') : null,
    ctx.isHost() && !elim.awaitingGuess
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('imp:next') }, outcome ? 'Voir la fin de la manche →' : 'Tour suivant →')
      : !elim.awaitingGuess
      ? ctx.renderWaiting('L’hôte lance la suite…')
      : null,
  ]);

  const el = h(
    'div',
    { class: 'stack' },
    header(lobby, elim.tie ? 'Égalité parfaite…' : 'Le verdict'),
    elim.tie
      ? h('section', { class: 'card winner-card' }, h('p', {}, '🤝 Toujours égalité : personne n’est éliminé ce tour-ci.'))
      : h(
          'section',
          { class: `card winner-card elim-card ${role.className}` },
          h('span', { class: 'eyebrow' }, 'Éliminé·e'),
          ctx.avatar(player, 'xl'),
          h('strong', { class: 'elim-name' }, player.id === me ? `${player.name} (toi)` : player.name),
          h('span', { class: 'elim-role' }, 'était… ', h('strong', {}, `${role.emoji} ${role.label}`)),
        ),
    guessZone,
    outcome ? h('section', { class: `card outcome ${outcome.className}` }, h('h2', {}, outcome.title)) : null,
    h('section', { class: 'card' }, h('h2', {}, 'Les votes'), voteBars(elim.results, ctx)),
    status.zone,
  );
  return { el, update: status.update };
}

// ----- 5. Fin de manche -----

function buildRoundEnd(lobby, ctx) {
  const imp = lobby.game.impostor;
  const { reveal } = imp;
  const outcome = OUTCOME[imp.outcome.winner];
  const last = imp.manche >= imp.totalManches;
  const winners = new Set(reveal.winners);
  const order = { impostor: 0, white: 1, civil: 2 };
  const roles = [...reveal.roles].sort((a, b) => order[a.role] - order[b.role]);
  const totals = lobby.players.map((p) => ({ player: p, total: imp.totals[p.id] ?? 0 })).sort((a, b) => b.total - a.total);

  const status = statusZone(() => [
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('imp:next') }, last ? 'Voir le classement final 🏁' : 'Manche suivante →')
      : ctx.renderWaiting('L’hôte lance la suite…'),
  ]);

  const el = h(
    'div',
    { class: 'stack' },
    header(lobby, outcome.title),
    h(
      'section',
      { class: 'imp-words' },
      h('div', { class: 'word-card role-civil' }, h('span', { class: 'eyebrow' }, 'Mot des civils'), h('strong', {}, reveal.words.civil)),
      h('div', { class: 'word-card role-impostor' }, h('span', { class: 'eyebrow' }, 'Mot de l’imposteur'), h('strong', {}, reveal.words.impostor)),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Qui était qui'),
      h(
        'ul',
        { class: 'role-list' },
        roles.map(({ playerId, role }) => {
          const p = ctx.getPlayer(playerId);
          const info = ROLE[role];
          return h(
            'li',
            { class: winners.has(playerId) ? 'is-winner' : '' },
            ctx.avatar(p, 'sm'),
            h('span', { class: 'final-name' }, p.name),
            h('span', { class: `role-pill ${info.className}` }, `${info.emoji} ${info.label}`),
            h('strong', { class: 'role-points' }, reveal.points[playerId] ? `+${reveal.points[playerId]}` : '0'),
          );
        }),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Scores'),
      h('ol', { class: 'final-list' }, totals.map(({ player, total }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), h('strong', {}, `${total} pts`)))),
    ),
    cluesList(lobby, ctx),
    status.zone,
  );
  return { el, update: status.update };
}
