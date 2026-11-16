// Chrono Stars (façon Time's Up) : réglages, annonce du tour, carte à faire deviner, fin de manche, fin de partie.
import { h } from './dom.js';

const TEAM = {
  rouge: { label: 'Rouges', emoji: '🔴' },
  bleu: { label: 'Bleus', emoji: '🔵' },
};
const CAT = { stars: '⭐', histoire: '📜', fiction: '🦸' };
const other = (team) => (team === 'rouge' ? 'bleu' : 'rouge');
const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const cards = (n) => `${n} carte${n > 1 ? 's' : ''}`;
const list = (names) => names.join(', ').replace(/, ([^,]*)$/, ' et $1');

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderChronoStarsSettings(lobby, host, ctx) {
  const limits = lobby.limits.chronoStars;
  if (!limits) return null;
  const s = lobby.settings.chronoStars;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (values, value, key, label) =>
    h('div', { class: 'timer-choices' }, values.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  const toggle = (id) => {
    const next = s.categories.includes(id) ? s.categories.filter((c) => c !== id) : [...s.categories, id];
    if (next.length === 0) return ctx.toast('Garde au moins un thème 😉', 'error');
    set({ csCategories: next });
  };
  const n = limits.players;
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Thèmes des cartes'),
    h(
      'div',
      { class: 'cat-toggles' },
      limits.categories.map((cat) =>
        h(
          'button',
          { type: 'button', class: `cat-toggle${s.categories.includes(cat.id) ? ' is-on' : ''}`, 'aria-pressed': String(s.categories.includes(cat.id)), disabled: !host || cat.count === 0, onClick: () => toggle(cat.id) },
          h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, cat.emoji),
          h('span', { class: 'cat-label', title: `${cat.count} personnalités` }, cat.label),
          h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
        ),
      ),
    ),
    h('span', { class: 'rounds-label' }, 'Nombre de cartes dans le paquet'),
    choices(limits.cards, s.cards, 'csCards', (v) => `${v}`),
    h('span', { class: 'rounds-label' }, 'Durée d’un tour'),
    choices(limits.timers, s.timer, 'csTimer', (v) => `${v} s`),
    h(
      'p',
      { class: 'hint hint-left' },
      `Deux équipes, le même paquet de personnalités pendant 3 manches : ${limits.manches.map((m) => `${m.emoji} ${m.label.toLowerCase()}`).join(', puis ')}. À ton tour, ton téléphone devient la carte : fais deviner un maximum de noms avant la fin du chrono. L’équipe adverse voit la carte pour vérifier. 1 pt par carte trouvée pour toute l’équipe. ${n >= limits.minPlayers ? `Avec ${n} joueurs : équipes de ${Math.ceil(n / 2)} et ${Math.floor(n / 2)}.` : `À partir de ${limits.minPlayers} joueurs.`}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function chronoStarsScreenKey(lobby) {
  const c = lobby.game.chronoStars;
  return `cs:${c.phase}:${c.manche}:${c.turnNo}:${c.isClueur}:${c.clueur}:${lobby.hostId}`;
}

function timerBar(c) {
  if (!c.deadline) return null;
  const offset = c.serverNow - Date.now();
  const total = c.timer * 1000;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer cs-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
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

function scoreboard(c, ctx) {
  return h(
    'div',
    { class: 'cs-score' },
    ['rouge', 'bleu'].map((team) =>
      h(
        'section',
        { class: `cs-team cs-team-${team}${c.turnTeam === team && c.phase !== 'cs-manche-end' ? ' is-turn' : ''}${c.myTeam === team ? ' is-mine' : ''}` },
        h('div', { class: 'cs-team-head' }, h('strong', {}, `${TEAM[team].emoji} ${TEAM[team].label}${c.myTeam === team ? ' (toi)' : ''}`), h('span', { class: 'cs-total' }, String(c.totals[team]))),
        h('div', { class: 'cs-members' }, c.teams[team].map((id) => { const p = ctx.getPlayer(id); return h('span', { class: `cs-member${p.connected ? '' : ' is-away'}${id === c.clueur && c.phase !== 'cs-manche-end' ? ' is-clueur' : ''}`, title: p.name }, ctx.avatar(p, 'sm')); })),
      ),
    ),
  );
}

function mancheBanner(c) {
  const m = c.manches[c.manche];
  return h(
    'section',
    { class: 'question-card quiz-card cs-manche' },
    h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, `Manche ${c.manche + 1} sur 3`), h('span', { class: 'cat-pill' }, `🃏 ${c.deckLeft}/${c.totalCards}`)),
    h('h1', { class: 'question cs-manche-title' }, `${m.emoji} ${m.label}`),
    h('p', { class: 'cs-rule' }, m.rule),
  );
}

function lastTurnCard(c, ctx) {
  const t = c.lastTurn;
  if (!t) return null;
  const p = ctx.getPlayer(t.clueur);
  const why = t.reason === 'left' ? ' (parti en plein tour)' : t.reason === 'host' ? ' (tour arrêté par l’hôte)' : '';
  return h(
    'section',
    { class: `card cs-last cs-last-${t.team}` },
    h('span', { class: 'eyebrow' }, `Tour précédent${why}`),
    h('p', {}, h('strong', {}, `${TEAM[t.team].emoji} ${p.name}`), ` a fait deviner ${cards(t.found.length)}${t.found.length ? ' : ' : ' 😬'}`, t.found.length ? h('span', { class: 'cs-names' }, list(t.found)) : null),
  );
}

function buildReady(c, ctx) {
  const clueur = ctx.getPlayer(c.clueur);
  const team = TEAM[c.turnTeam];
  const role = c.isClueur ? 'clueur' : c.myTeam === c.turnTeam ? 'mate' : 'opp';
  const live = h('div', { class: 'stack' });
  const el = h(
    'div',
    { class: 'stack' },
    live,
    h(
      'section',
      { class: `card cs-announce cs-announce-${c.turnTeam}` },
      ctx.avatar(clueur, 'lg'),
      h('h2', {}, c.isClueur ? 'À toi de faire deviner !' : `${clueur.name} va faire deviner`),
      h('p', { class: 'cs-who' }, `${team.emoji} pour les ${team.label}`),
      role === 'clueur'
        ? [
            h('p', { class: 'hint' }, `Ton téléphone va devenir la carte. ${c.manches[c.manche].pass ? 'Tu peux passer une carte difficile.' : 'Pas de « passer » à cette manche !'}`),
            h('button', { type: 'button', class: 'btn btn-primary btn-big cs-go', onClick: () => ctx.action('cs:go') }, `C’est parti ! ⏱ ${c.timer} s`),
          ]
        : h('p', { class: 'cs-role' }, role === 'mate' ? '🗣️ C’est ton équipe qui devine : prépare-toi !' : '👀 Équipe adverse : tu verras la carte pour vérifier qu’il ne triche pas.'),
      role !== 'clueur' ? ctx.renderWaiting(`On attend que ${clueur.name} lance le chrono…`) : null,
    ),
  );
  const update = (now) => {
    live.replaceChildren(...[scoreboard(now, ctx), mancheBanner(now), lastTurnCard(now, ctx), ctx.isHost() && !now.isClueur ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, `${clueur.name} n’est pas là ? Joueur suivant ⏭`) : null].filter(Boolean));
  };
  return { el, update };
}

function buildPlay(c, ctx) {
  const clueur = ctx.getPlayer(c.clueur);
  const role = c.isClueur ? 'clueur' : c.myTeam === c.turnTeam ? 'mate' : 'opp';
  const live = h('div', { class: 'stack' });
  const el = h('div', { class: 'stack' }, timerBar(c), live);
  const send = (event, cardId) => {
    navigator.vibrate?.(25);
    ctx.action(event, { cardId });
  };
  const update = (now) => {
    const found = now.turnFound;
    const m = now.manches[now.manche];
    let main;
    if (role === 'clueur' && now.card) {
      main = h(
        'div',
        { class: 'stack' },
        h('section', { class: `cs-card cs-card-${now.turnTeam}` }, h('span', { class: 'cs-card-cat', 'aria-hidden': 'true' }, CAT[now.card.cat] ?? '⭐'), h('strong', { class: 'cs-card-name' }, now.card.name), h('span', { class: 'cs-card-rule' }, `${m.emoji} ${m.label}`)),
        h(
          'div',
          { class: 'cs-buttons' },
          m.pass ? h('button', { type: 'button', class: 'btn btn-ghost cs-pass', onClick: () => send('cs:pass', now.card.id) }, '⏭ Passer') : null,
          h('button', { type: 'button', class: 'btn btn-primary cs-found', onClick: () => send('cs:found', now.card.id) }, '✅ Trouvé !'),
        ),
      );
    } else if (role === 'opp' && now.card) {
      main = h(
        'section',
        { class: 'card cs-watch' },
        h('span', { class: 'eyebrow' }, `👀 Carte de ${clueur.name} — surveillez !`),
        h('strong', { class: 'cs-watch-name' }, now.card.name),
        h('p', { class: 'hint' }, m.rule),
      );
    } else {
      main = h('section', { class: `card cs-guess cs-guess-${now.turnTeam}` }, h('span', { class: 'cs-guess-emoji', 'aria-hidden': 'true' }, m.emoji), h('h2', {}, `Devinez ! ${clueur.name} fait deviner`), h('p', { class: 'hint' }, m.rule));
    }
    live.replaceChildren(
      ...[
        main,
        h(
          'section',
          { class: 'card cs-found-list' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Trouvées ce tour'), h('span', { class: 'count' }, String(found.length))),
          found.length ? h('div', { class: 'cs-chips' }, found.map((n) => h('span', { class: 'cs-chip' }, n))) : h('p', { class: 'hint' }, 'Pas encore…'),
          h('p', { class: 'hint' }, `Encore ${cards(now.deckLeft)} dans le paquet`),
        ),
        scoreboard(now, ctx),
        ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Arrêter ce tour ⏹') : null,
      ].filter(Boolean),
    );
  };
  return { el, update };
}

function buildMancheEnd(lobby, c, ctx) {
  const r = c.result;
  const m = c.manches[c.manche];
  const nextM = c.manches[c.manche + 1];
  const scores = lobby.players.map((p) => ({ player: p, total: r.scores?.[p.id] ?? 0, gain: r.gains?.[p.id] ?? 0 })).sort((a, b) => b.total - a.total);
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: `card cn-winner ${r.winner ? `cn-winner-${r.winner}` : ''}` },
      h('span', { class: 'eyebrow' }, `Fin de la manche ${c.manche + 1} · ${m.emoji} ${m.label}`),
      h('h1', { class: 'question' }, r.winner ? `${TEAM[r.winner].emoji} Les ${TEAM[r.winner].label} gagnent la manche !` : 'Égalité parfaite !'),
      h('p', { class: 'cs-versus' }, `🔴 ${r.counts.rouge} — ${r.counts.bleu} 🔵`),
      nextM ? h('p', { class: 'hint' }, `Prochaine manche : ${nextM.emoji} ${nextM.label}. Même paquet, vous connaissez déjà les noms 😉`) : null,
    ),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, nextM ? `Manche ${c.manche + 2} : ${nextM.label} →` : 'Voir le classement final 🏁')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h(
      'div',
      { class: 'cs-results' },
      ['rouge', 'bleu'].map((team) =>
        h('section', { class: `card cs-result cs-result-${team}` }, h('div', { class: 'card-head' }, h('h2', {}, `${TEAM[team].emoji} ${TEAM[team].label}`), h('span', { class: 'count' }, cards(r.counts[team]))), r.found[team].length ? h('div', { class: 'cs-chips' }, r.found[team].map((n) => h('span', { class: 'cs-chip' }, n))) : h('p', { class: 'hint' }, 'Aucune carte'))),
    ),
    h('section', { class: 'card' }, h('h2', {}, 'Scores'), h('ol', { class: 'final-list' }, scores.map(({ player, total, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(total)))))),
  );
  return { el, update: () => {} };
}

export function buildChronoStarsScreen(lobby, ctx) {
  const c = lobby.game.chronoStars;
  const screen = c.phase === 'cs-ready' ? buildReady(c, ctx) : c.phase === 'cs-play' ? buildPlay(c, ctx) : buildMancheEnd(lobby, c, ctx);
  return { el: screen.el, update: (current) => current.game.chronoStars && screen.update(current.game.chronoStars) };
}

// Bandeau de l'équipe gagnante sur l'écran de fin.
export function renderChronoStarsEnd(final, ctx) {
  const f = final.cs;
  if (!f) return null;
  return h(
    'section',
    { class: `card cn-winner ${f.winner ? `cn-winner-${f.winner}` : ''}` },
    h('span', { class: 'eyebrow' }, 'Résultat des équipes'),
    h('h1', { class: 'question' }, f.winner ? `${TEAM[f.winner].emoji} Victoire des ${TEAM[f.winner].label} !` : 'Égalité parfaite !'),
    h('p', { class: 'cs-versus' }, `🔴 ${f.totals.rouge} — ${f.totals.bleu} 🔵`),
    f.winner ? h('p', { class: 'hint' }, list(f.teams[f.winner].map((id) => ctx.getPlayer(id).name))) : null,
    f.winner ? h('p', { class: 'hint' }, `Les ${TEAM[other(f.winner)].label} : la revanche ? 😏`) : null,
  );
}
