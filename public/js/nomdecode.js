// Nom de code (façon Codenames) : réglages, grille de 25 mots, indice de l'espion, votes des agents, fin de manche.
// La zone de saisie de l'indice est conservée entre deux messages du serveur ; la grille est redessinée à chaque fois.
import { h } from './dom.js';

const TEAM = {
  rouge: { label: 'Rouges', one: 'Rouge', emoji: '🔴' },
  bleu: { label: 'Bleus', one: 'Bleu', emoji: '🔵' },
};
const other = (team) => (team === 'rouge' ? 'bleu' : 'rouge');
const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const names = (ctx, ids) => ids.map((id) => ctx.getPlayer(id).name).join(', ').replace(/, ([^,]*)$/, ' et $1');

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderNomDeCodeSettings(lobby, host, ctx) {
  const limits = lobby.limits.nomDeCode;
  if (!limits) return null;
  const s = lobby.settings.nomDeCode;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (list, value, key, label) =>
    h('div', { class: 'timer-choices' }, list.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  const n = limits.players;
  const teams = n >= limits.minPlayers ? `Avec ${n} joueurs : équipes de ${Math.floor(n / 2)} et ${Math.ceil(n / 2)}.` : `Il faut au moins ${limits.minPlayers} joueurs (2 par équipe).`;
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Nombre de manches'),
    choices(limits.rounds, s.rounds, 'cnRounds', (v) => `${v}`),
    h('span', { class: 'rounds-label' }, 'Chrono par étape (indice, puis recherche)'),
    choices(limits.timers, s.timer, 'cnTimer', (v) => (v ? `${v} s` : 'Sans')),
    h(
      'p',
      { class: 'hint hint-left' },
      `Deux équipes tirées au hasard, 25 mots. Chaque équipe a un espion (chacun son tour) qui voit à qui appartient chaque mot. Il donne un indice d’un seul mot et un nombre ; son équipe touche les mots qu’elle pense être les siens. Mot neutre ou adverse : fin du tour. L’assassin 💀 : défaite immédiate ! +${limits.points.card} pt par mot de ton équipe trouvé, +${limits.points.win} pts si ton équipe gagne la manche. ${teams}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function nomDeCodeScreenKey(lobby) {
  const c = lobby.game.nomDeCode;
  return `cn:${c.manche}:${c.phase}:${c.turn}:${c.log.length}:${c.mySpy}:${c.phase === 'cn-end' ? lobby.hostId : ''}`;
}

function timerBar(c) {
  if (!c.deadline) return null;
  const offset = c.serverNow - Date.now();
  const total = c.timer * 1000;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
  let started = false;
  const tick = () => {
    if (started && !el.isConnected) return;
    started = true;
    const left = Math.max(0, c.deadline - (Date.now() + offset));
    fill.style.width = `${Math.min(100, (left / total) * 100)}%`;
    label.textContent = `${Math.ceil(left / 1000)} s`;
    el.classList.toggle('is-urgent', left <= 10_000);
    if (left > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return el;
}

// Les deux équipes : mots restants, membres, espion, qui joue.
function teamsBar(c, ctx) {
  return h(
    'div',
    { class: 'cn-teams' },
    ['rouge', 'bleu'].map((team) =>
      h(
        'section',
        { class: `cn-team cn-team-${team}${c.turn === team && c.phase !== 'cn-end' ? ' is-turn' : ''}${c.myTeam === team ? ' is-mine' : ''}` },
        h(
          'div',
          { class: 'cn-team-head' },
          h('strong', {}, `${TEAM[team].emoji} ${TEAM[team].label}`),
          h('span', { class: 'cn-left', title: 'Mots restant à trouver' }, String(c.remaining[team])),
        ),
        h(
          'ul',
          { class: 'cn-members' },
          c.teams[team].map((id) => {
            const p = ctx.getPlayer(id);
            return h('li', { class: p.connected ? '' : 'is-away' }, ctx.avatar(p, 'sm'), h('span', {}, p.name), id === c.spies[team] ? h('span', { class: 'cn-spy', title: 'Espion' }, '🕵️') : null);
          }),
        ),
        c.turn === team && c.phase !== 'cn-end' ? h('span', { class: 'cn-turn-tag' }, 'À eux de jouer') : null,
      ),
    ),
  );
}

function roleBanner(c) {
  if (!c.myTeam) return null;
  const t = TEAM[c.myTeam];
  return h(
    'p',
    { class: `cn-role cn-role-${c.myTeam}` },
    c.mySpy
      ? [h('strong', {}, `🕵️ Tu es l’espion des ${t.label}`), ' : toi seul vois les couleurs. Fais deviner les mots ', h('strong', {}, t.label.toLowerCase()), ', évite le 💀.']
      : [h('strong', {}, `${t.emoji} Tu es agent des ${t.label}`), ' : écoute ton espion et trouve vos mots.'],
  );
}

function cardClass(card) {
  if (card.revealed) return ` is-revealed t-${card.type}`;
  return card.type ? ` key-${card.type}` : '';
}

function board(c, ctx) {
  const canPick = c.phase === 'cn-guess' && c.myTeam === c.turn && !c.mySpy;
  const votesByCard = new Map();
  for (const v of c.votes) {
    if (!votesByCard.has(v.card)) votesByCard.set(v.card, []);
    votesByCard.get(v.card).push(v.playerId);
  }
  const me = ctx.me();
  const myVote = c.votes.find((v) => v.playerId === me)?.card;
  return h(
    'div',
    { class: `cn-board${canPick ? ' can-pick' : ''}` },
    c.board.map((card, i) => {
      const voters = votesByCard.get(i) ?? [];
      const clickable = canPick && !card.revealed;
      return h(
        clickable ? 'button' : 'div',
        {
          ...(clickable ? { type: 'button', onClick: () => ctx.action('cn:pick', { card: i }) } : {}),
          class: `cn-card${cardClass(card)}${clickable ? ' is-clickable' : ''}${myVote === i ? ' is-my-vote' : ''}${voters.length ? ' is-voted' : ''}`,
          'aria-label': `${card.word}${card.type ? ` (${card.type})` : ''}`,
        },
        card.type === 'assassin' ? h('span', { class: 'cn-skull', 'aria-hidden': 'true' }, '💀') : null,
        h('span', { class: 'cn-word' }, card.word),
        voters.length
          ? h('span', { class: 'cn-marks' }, voters.map((id) => { const p = ctx.getPlayer(id); return h('span', { class: 'cn-mark', style: `--avatar:${ctx.colorFor(id)}`, title: p.name }, ctx.initials(p.name)); }))
          : null,
      );
    }),
  );
}

function logList(c) {
  if (!c.log.length) return null;
  return h(
    'section',
    { class: 'card cn-log' },
    h('h2', {}, 'Indices de la manche'),
    h(
      'ol',
      {},
      [...c.log].reverse().map((entry) =>
        h(
          'li',
          { class: `cn-log-${entry.team}` },
          h('span', { class: 'cn-log-clue' }, `${TEAM[entry.team].emoji} ${entry.clue} · ${entry.count}`),
          h(
            'span',
            { class: 'cn-log-picks' },
            entry.picks.length
              ? entry.picks.map((p) => h('span', { class: `cn-pick t-${p.type}` }, `${p.word}${p.type === entry.team ? ' ✓' : p.type === 'assassin' ? ' 💀' : ' ✗'}`))
              : h('em', {}, 'aucun mot'),
          ),
        ),
      ),
    ),
  );
}

// Indice en cours + bouton « finir le tour » pour les agents.
function guessPanel(c, ctx) {
  if (c.phase !== 'cn-guess' || !c.clue) return null;
  const t = TEAM[c.turn];
  const canPick = c.myTeam === c.turn && !c.mySpy;
  const need = Math.floor(c.guessers.length / 2) + 1;
  const passVotes = c.votes.filter((v) => v.card === 'pass').length;
  const iPass = c.votes.some((v) => v.playerId === ctx.me() && v.card === 'pass');
  return h(
    'section',
    { class: `card cn-clue-card cn-clue-${c.turn}` },
    h('span', { class: 'eyebrow' }, `Indice de l’espion ${t.one.toLowerCase()}${c.spies[c.turn] ? ` · ${ctx.getPlayer(c.spies[c.turn]).name}` : ''}`),
    h('div', { class: 'cn-clue' }, h('strong', {}, c.clue.word), h('span', { class: 'cn-count' }, String(c.clue.count))),
    h('p', { class: 'hint' }, `Encore ${c.guessesLeft} essai${c.guessesLeft > 1 ? 's' : ''} au maximum.`),
    canPick
      ? h(
          'div',
          { class: 'stack cn-actions' },
          h('p', { class: 'cn-tip' }, c.guessers.length > 1 ? `Touchez un mot : il est retourné quand ${need} agents sur ${c.guessers.length} sont d’accord. Retouche pour annuler.` : 'Touche un mot pour le retourner.'),
          h('button', { type: 'button', class: `btn btn-ghost${iPass ? ' is-active' : ''}`, onClick: () => ctx.action('cn:pick', { card: 'pass' }) }, `✋ Finir le tour${c.guessers.length > 1 ? ` (${passVotes}/${need})` : ''}`),
        )
      : h('p', { class: 'cn-tip' }, c.mySpy && c.myTeam === c.turn ? 'Pas un mot, pas un geste… 🤐 Ton équipe cherche.' : `Les ${t.label} cherchent…`),
  );
}

function waitingClue(c, ctx) {
  if (c.phase !== 'cn-clue' || (c.mySpy && c.myTeam === c.turn)) return null;
  const spy = c.spies[c.turn] ? ctx.getPlayer(c.spies[c.turn]).name : 'L’espion';
  return h('section', { class: `card cn-clue-card cn-clue-${c.turn}` }, ctx.renderWaiting(`🕵️ ${spy} (espion des ${TEAM[c.turn].label}) cherche un indice…`));
}

// Formulaire de l'espion : un mot + un nombre.
function clueForm(c, ctx) {
  let count = 1;
  const input = h('input', { type: 'text', class: 'answer-input', maxlength: '24', autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'send', placeholder: 'Ton indice (un seul mot)', 'aria-label': 'Ton indice' });
  const countButtons = Array.from({ length: 9 }, (_, i) => i + 1).map((n) =>
    h('button', { type: 'button', class: `timer-choice${n === count ? ' is-active' : ''}`, 'aria-pressed': String(n === count), onClick: () => { count = n; countButtons.forEach((b, j) => { b.classList.toggle('is-active', j + 1 === n); b.setAttribute('aria-pressed', String(j + 1 === n)); }); } }, String(n)),
  );
  const send = async () => {
    const word = input.value.trim();
    if (!word) return ctx.toast('Écris un indice 😉', 'error');
    const res = await ctx.action('cn:clue', { word, count });
    if (!res.ok) input.select();
  };
  const form = h(
    'form',
    { class: `card cn-clue-form cn-clue-${c.turn}`, onSubmit: (event) => { event.preventDefault(); send(); } },
    h('span', { class: 'eyebrow' }, 'À toi de jouer, espion !'),
    h('p', { class: 'cn-tip' }, 'Un seul mot qui fait penser à plusieurs mots de ton équipe. Interdit : un mot de la grille (ou presque).'),
    input,
    h('span', { class: 'rounds-label' }, 'Combien de mots ?'),
    h('div', { class: 'timer-choices cn-counts' }, countButtons),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Envoyer l’indice 🕵️'),
  );
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  return form;
}

function endPanel(lobby, c, ctx) {
  const r = c.result;
  const t = TEAM[r.winner];
  const last = c.manche + 1 >= c.total;
  const why = r.reason === 'assassin' ? `Les ${TEAM[other(r.winner)].label} ont touché l’assassin 💀` : r.reason === 'gift' ? `Les ${TEAM[other(r.winner)].label} leur ont donné leur dernier mot 🎁` : 'Tous leurs mots sont trouvés !';
  const scores = lobby.players.map((p) => ({ player: p, total: r.scores?.[p.id] ?? 0, gain: r.gains?.[p.id] ?? 0 })).sort((a, b) => b.total - a.total);
  return h(
    'div',
    { class: 'stack' },
    h('section', { class: `card cn-winner cn-winner-${r.winner}` }, h('span', { class: 'eyebrow' }, `Manche ${c.manche + 1} sur ${c.total}`), h('h1', { class: 'question' }, `${t.emoji} Victoire des ${t.label} !`), h('p', {}, why), h('p', { class: 'hint' }, names(ctx, c.teams[r.winner]))),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Manche suivante (nouvelles équipes) →')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Scores'),
      h('ol', { class: 'final-list' }, scores.map(({ player, total, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(total))))),
    ),
  );
}

export function buildNomDeCodeScreen(lobby, ctx) {
  const c = lobby.game.nomDeCode;
  const fixed = c.phase === 'cn-clue' && c.mySpy && c.myTeam === c.turn ? clueForm(c, ctx) : null;
  const top = h('div', { class: 'stack' });
  // Chrono et formulaire de l'espion ne sont créés qu'une fois par écran (la saisie n'est jamais perdue).
  const live = h('div', { class: 'stack' });
  const main = h('div', { class: 'stack cn-main' }, ...[c.phase === 'cn-end' ? null : timerBar(c), fixed, live].filter(Boolean));
  const side = h('div', { class: 'stack cn-side' });
  const layout = h('div', { class: 'cn-layout' }, main, side);
  const el = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'quiz-head cn-head' }, h('span', { class: 'eyebrow' }, `Manche ${c.manche + 1} sur ${c.total}`), h('span', { class: 'cat-pill' }, '🔐 Nom de code')),
    top,
    layout,
  );
  const update = (current) => {
    const now = current.game.nomDeCode;
    if (!now) return;
    const ended = now.phase === 'cn-end';
    top.replaceChildren(...[teamsBar(now, ctx), ended ? null : roleBanner(now)].filter(Boolean));
    live.replaceChildren(
      ...[
        waitingClue(now, ctx),
        guessPanel(now, ctx),
        board(now, ctx),
        !ended && ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, `Passer le tour des ${TEAM[now.turn].label} ⏭`) : null,
      ].filter(Boolean),
    );
    side.replaceChildren(...[ended ? endPanel(current, now, ctx) : null, logList(now)].filter(Boolean));
    layout.classList.toggle('is-ended', ended);
    layout.classList.toggle('is-solo', side.childElementCount === 0);
  };
  return { el, update };
}
