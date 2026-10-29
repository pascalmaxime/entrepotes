// Le Juste Prix : réglages, question (estimation ou classement) avec chrono, révélation.
// Les écrans sont conservés entre deux messages du serveur (on ne perd pas la saisie).
import { h } from './dom.js';

const CAT_INFO = {
  prix: { label: 'Prix & argent', emoji: '💶' },
  poids: { label: 'Poids', emoji: '⚖️' },
  distances: { label: 'Tailles & distances', emoji: '📏' },
  volumes: { label: 'Volumes', emoji: '🧴' },
  population: { label: 'Population', emoji: '👥' },
  economie: { label: 'PIB & économie', emoji: '📈' },
  temps: { label: 'Temps & vitesses', emoji: '⏱️' },
  classements: { label: 'Classement', emoji: '🏆' },
};
const catInfo = (id) => CAT_INFO[id] ?? { label: id, emoji: '❓' };
const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
export const formatNumber = (value) => nf.format(value);
const withUnit = (value, unit) => (unit === 'année' ? String(value) : `${formatNumber(value)}${unit ? ` ${unit}` : ''}`);

// Même lecture que le serveur : « 1 234,5 », « 1.234,5 », « 12k », « 3 millions »…
export function parseNumber(raw) {
  let text = String(raw ?? '').trim().replace(/[\s  ']/g, ' ').replace(/[€$%]/g, '').trim();
  let factor = 1;
  for (const [pattern, value] of [[/\s*(milliards?|mds?)$/i, 1e9], [/\s*(millions?)$/i, 1e6], [/\s*(mille|k)$/i, 1e3]]) {
    if (pattern.test(text)) {
      factor = value;
      text = text.replace(pattern, '');
      break;
    }
  }
  text = text.replace(/ /g, '');
  if (!/^-?[\d.,]+$/.test(text)) return null;
  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  if (dots && commas) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (commas > 1) text = text.replace(/,/g, '');
  else if (dots > 1) text = text.replace(/\./g, '');
  else text = text.replace(',', '.');
  const value = Number(text) * factor;
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderJustePrixSettings(lobby, host, ctx) {
  const limits = lobby.limits.justePrix;
  if (!limits) return null;
  const { categories, timer } = lobby.settings.justePrix;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const toggle = (id) => {
    const next = categories.includes(id) ? categories.filter((c) => c !== id) : [...categories, id];
    if (next.length === 0) return ctx.toast('Garde au moins une catégorie 😉', 'error');
    set({ jpCategories: next });
  };
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Types de questions'),
    h(
      'div',
      { class: 'cat-toggles' },
      limits.categories.map((cat) => {
        const on = categories.includes(cat.id);
        return h(
          'button',
          { type: 'button', class: `cat-toggle${on ? ' is-on' : ''}`, 'aria-pressed': String(on), disabled: !host || cat.count === 0, onClick: () => toggle(cat.id) },
          h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, cat.emoji),
          h('span', { class: 'cat-label' }, cat.label),
          h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
        );
      }),
    ),
    h('span', { class: 'rounds-label' }, 'Chrono par question'),
    h(
      'div',
      { class: 'timer-choices', role: 'group', 'aria-label': 'Chrono par question' },
      limits.timers.map((value) =>
        h(
          'button',
          { type: 'button', class: `timer-choice${value === timer ? ' is-active' : ''}`, 'aria-pressed': String(value === timer), disabled: !host, onClick: () => value !== timer && set({ jpTimer: value }) },
          value ? `${value} s` : 'Sans',
        ),
      ),
    ),
    h('p', { class: 'hint hint-left' }, 'Le plus proche : 3 pts, le 2e : 2 pts, le 3e : 1 pt, +2 si c’est pile. Classements : 1 pt par bonne place, +2 si tout est juste.'),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function justePrixScreenKey(lobby, ui) {
  if (lobby.state === 'jp-question') {
    const answered = Boolean(lobby.you?.answered) && !ui.editing;
    return `jp-q:${lobby.game.justePrix.index}:${answered}`;
  }
  return `jp-r:${lobby.game.round}:${lobby.hostId}`;
}

export function buildJustePrixScreen(lobby, ctx, ui) {
  return lobby.state === 'jp-question' ? buildQuestion(lobby, ctx, ui) : buildReveal(lobby, ctx);
}

function questionHeader(question, index, total) {
  const info = catInfo(question.cat);
  return h(
    'section',
    { class: 'question-card quiz-card' },
    h(
      'div',
      { class: 'quiz-head' },
      h('span', { class: 'eyebrow' }, `Question ${index + 1} sur ${total}`),
      h('span', { class: 'cat-pill' }, `${info.emoji} ${question.kind === 'ranking' ? question.theme || info.label : info.label}`),
      question.kind === 'estimate' && question.unit ? h('span', { class: 'pts-pill' }, `en ${question.unit}`) : null,
    ),
    h('h1', { class: 'question' }, question.prompt),
    question.kind === 'ranking' ? h('p', { class: 'question-hint' }, 'Touche les propositions dans l’ordre : Top 1 d’abord.') : null,
  );
}

function buildQuestion(lobby, ctx, ui) {
  const jp = lobby.game.justePrix;
  const { question } = jp;
  const you = lobby.you ?? { answered: false, answer: null };
  const offset = jp.serverNow - Date.now();
  const send = (value) => ctx.action('jp:answer', { index: jp.index, value });
  const sendQuiet = (value) => ctx.emit('jp:answer', { index: jp.index, value }); // fin du chrono, sans message d'erreur

  const status = h('div', { class: 'stack' });
  const update = (current) => {
    status.replaceChildren(
      ...[
        ctx.renderProgress('Réponses', current.players, current.game.votedIds),
        ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Révéler la réponse maintenant') : null,
      ].filter(Boolean),
    );
  };

  // Chrono (même affichage que M-Culture)
  let timerEl = null;
  const onExpire = [];
  if (jp.deadline) {
    const fill = h('span');
    const label = h('strong', { class: 'timer-seconds' });
    timerEl = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
    let started = false;
    let expired = false;
    const tick = () => {
      if (started && !timerEl.isConnected) return;
      started = true;
      const left = Math.max(0, jp.deadline - (Date.now() + offset));
      fill.style.width = `${(left / (jp.timer * 1000)) * 100}%`;
      label.textContent = `${Math.ceil(left / 1000)} s`;
      timerEl.classList.toggle('is-urgent', left <= 5000);
      if (left <= 0) {
        if (!expired) {
          expired = true;
          onExpire.forEach((fn) => fn());
        }
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  let body;
  if (you.answered && !ui.editing) {
    const shown = Array.isArray(you.answer) ? you.answer.map((label, i) => `${i + 1}. ${label}`).join('  ') : withUnit(you.answer, question.unit);
    body = h(
      'section',
      { class: 'card voted' },
      h('div', { class: 'voted-check', 'aria-hidden': 'true' }, '✓'),
      h('p', {}, 'Ta réponse : ', h('strong', {}, shown)),
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { ui.editing = true; ctx.rerender(); } }, 'Modifier ma réponse'),
    );
  } else if (question.kind === 'ranking') {
    body = buildRankingInput(question, you, send, sendQuiet, ui, ctx, onExpire);
  } else {
    body = buildNumberInput(question, you, send, sendQuiet, ui, ctx, onExpire);
  }

  const el = h('div', { class: 'stack' }, questionHeader(question, jp.index, jp.total), timerEl, body, status);
  return { el, update };
}

function buildNumberInput(question, you, send, sendQuiet, ui, ctx, onExpire) {
  const input = h('input', {
    type: 'text',
    inputmode: 'decimal',
    class: 'answer-input',
    maxlength: '30',
    autocomplete: 'off',
    enterkeyhint: 'send',
    placeholder: question.unit === 'année' ? 'Ex : 1850' : 'Ex : 1 234,5',
    'aria-label': `Ta réponse en ${question.unit}`,
  });
  if (you.answer !== null && you.answer !== undefined) input.value = String(you.answer).replace('.', ',');
  const preview = h('p', { class: 'jp-preview', 'aria-live': 'polite' });
  const refresh = () => {
    const value = parseNumber(input.value);
    preview.textContent = input.value.trim() ? (value === null ? 'Ce n’est pas un nombre 🤔' : `= ${withUnit(value, question.unit)}`) : `Réponds en ${question.unit}`;
    preview.classList.toggle('is-error', Boolean(input.value.trim()) && value === null);
  };
  input.addEventListener('input', refresh);
  refresh();
  const submit = async () => {
    if (parseNumber(input.value) === null) {
      ctx.toast('Écris un nombre (ex : 1 234,5)', 'error');
      input.focus();
      return;
    }
    const res = await send(input.value);
    if (res.ok) {
      ui.editing = false;
      ctx.rerender();
    }
  };
  const button = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Valider');
  // Chrono écoulé : ce qui est écrit est envoyé automatiquement.
  onExpire.push(() => {
    if (parseNumber(input.value) !== null) sendQuiet(input.value);
    input.disabled = true;
    button.disabled = true;
  });
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  return h(
    'form',
    { class: 'card jp-answer', onSubmit: (event) => { event.preventDefault(); submit(); } },
    h('div', { class: 'answer-card' }, h('div', { class: 'jp-input-wrap' }, input, question.unit && question.unit !== 'année' ? h('span', { class: 'jp-unit' }, question.unit) : null), button),
    preview,
  );
}

function buildRankingInput(question, you, send, sendQuiet, ui, ctx, onExpire) {
  const choices = question.choices;
  let order = Array.isArray(you.answer) ? [...you.answer] : [];
  const box = h('section', { class: 'card' });
  const draw = () => {
    const remaining = choices.filter((c) => !order.includes(c));
    box.replaceChildren(
      ...[
      h(
        'ol',
        { class: 'tier-slots' },
        choices.map((_, index) => {
          const label = order[index];
          return h(
            'li',
            { class: 'tier-slot' },
            h('span', { class: 'tier-label', style: `--tier:var(--tier-${Math.min(5, index + 1)})` }, `TOP ${index + 1}`),
            label
              ? h('button', { type: 'button', class: 'tier-chip', onClick: () => { order = order.filter((l) => l !== label); draw(); } }, h('span', {}, label), h('span', { class: 'remove', 'aria-hidden': 'true' }, '×'))
              : h('span', { class: 'tier-empty' }, index === order.length ? 'Touche une proposition ↓' : '—'),
          );
        }),
      ),
      remaining.length
        ? h('div', { class: 'tier-pool' }, remaining.map((label) => h('button', { type: 'button', class: 'pool-chip', onClick: () => { order = [...order, label]; draw(); } }, h('span', {}, label))))
        : null,
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-ghost', disabled: order.length === 0, onClick: () => { order = []; draw(); } }, 'Recommencer'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            disabled: order.length !== choices.length,
            onClick: async () => {
              const res = await send([...order]);
              if (res.ok) {
                ui.editing = false;
                ctx.rerender();
              }
            },
          },
          'Valider',
        ),
      ),
      ].filter(Boolean),
    );
  };
  draw();
  onExpire.push(() => {
    if (order.length === choices.length) sendQuiet([...order]);
    box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  });
  return box;
}

// ---------------------------------------------------------------------------
// Révélation
// ---------------------------------------------------------------------------

function buildReveal(lobby, ctx) {
  const { game } = lobby;
  const { result } = game;
  const last = game.round >= game.totalRounds;
  const question = result.question;
  const info = catInfo(question.cat);

  const answerCard = h(
    'section',
    { class: 'question-card quiz-card is-compact' },
    h(
      'div',
      { class: 'quiz-head' },
      h('span', { class: 'eyebrow' }, `Réponse · question ${game.round}/${game.totalRounds}`),
      h('span', { class: 'cat-pill' }, `${info.emoji} ${question.kind === 'ranking' ? question.theme || info.label : info.label}`),
    ),
    h('h1', { class: 'question' }, question.prompt),
    result.kind === 'estimate' ? h('div', { class: 'jp-answer-big' }, withUnit(result.answer, result.unit)) : null,
    result.info ? h('p', { class: 'hint' }, result.info) : null,
    result.kind === 'ranking'
      ? h(
          'ol',
          { class: 'jp-truth' },
          result.items.map((item, index) =>
            h(
              'li',
              {},
              h('span', { class: 'voter-rank', style: `--tier:var(--tier-${Math.min(5, index + 1)})` }, `TOP ${index + 1}`),
              h('span', { class: 'jp-truth-item' }, h('strong', {}, item.label), h('small', {}, withUnit(item.value, result.unit))),
            ),
          ),
        )
      : null,
  );

  const rows =
    result.kind === 'estimate'
      ? result.entries.map((entry) => {
          const p = ctx.getPlayer(entry.playerId);
          const gap = entry.value === null ? null : entry.percent === null ? '' : `${entry.percent > 0 ? '+' : ''}${String(entry.percent).replace('.', ',')} %`;
          return h(
            'li',
            { class: `jp-row${entry.exact ? ' is-exact' : ''}${entry.value === null ? ' is-empty' : ''}` },
            h('span', { class: 'jp-rank' }, entry.rank ? `#${entry.rank}` : '–'),
            ctx.avatar(p, 'sm'),
            h(
              'span',
              { class: 'jp-player' },
              h('small', {}, p.name),
              h('strong', {}, entry.value === null ? 'Pas de réponse' : withUnit(entry.value, result.unit)),
            ),
            gap ? h('span', { class: `jp-gap${entry.percent > 0 ? ' is-over' : ' is-under'}` }, entry.exact ? '🎯 Pile !' : gap) : null,
            h('span', { class: `jp-points${entry.points ? '' : ' is-zero'}` }, `+${entry.points}`),
          );
        })
      : result.entries.map((entry) => {
          const p = ctx.getPlayer(entry.playerId);
          return h(
            'li',
            { class: `jp-row jp-row-ranking${entry.order ? '' : ' is-empty'}` },
            ctx.avatar(p, 'sm'),
            h(
              'span',
              { class: 'jp-player' },
              h('small', {}, p.name),
              entry.order
                ? h('span', { class: 'jp-order' }, entry.order.map((label, i) => h('span', { class: `jp-chip ${entry.marks[i] ? 'is-good' : 'is-bad'}` }, `${i + 1}. ${label}`)))
                : h('strong', {}, 'Pas de réponse'),
            ),
            h('span', { class: `jp-points${entry.points ? '' : ' is-zero'}` }, `+${entry.points}`),
          );
        });

  const scores = lobby.players
    .map((p) => ({ player: p, total: result.scores?.[p.id] ?? 0 }))
    .sort((a, b) => b.total - a.total);

  const el = h(
    'div',
    { class: 'stack' },
    answerCard,
    h('section', { class: 'card' }, h('h2', {}, result.kind === 'estimate' ? 'Qui était le plus proche ?' : 'Les classements'), h('ul', { class: 'jp-list' }, rows)),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Question suivante →')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Scores'),
      h('ol', { class: 'final-list' }, scores.map(({ player, total }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), h('strong', {}, pts(total))))),
    ),
  );
  return { el, update: () => {} };
}
