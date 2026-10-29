// M-Culture : réglages, écran de question (avec chrono), correction par l'hôte.
import { h } from './dom.js';

const CAT_INFO = {
  culture: { label: 'Culture G', emoji: '🧠' },
  drapeaux: { label: 'Drapeaux', emoji: '🚩' },
  carte: { label: 'Carte', emoji: '🗺️' },
  rebus: { label: 'Rébus', emoji: '🧩' },
  musique: { label: 'Musique', emoji: '🎵' },
  'petit-bac': { label: 'Petit bac', emoji: '✏️' },
};
const catInfo = (id) => CAT_INFO[id] ?? { label: id, emoji: '❓' };
const ptsLabel = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// Réglages dans le lobby (boutons on/off par catégorie, nombre de questions, chrono)
// ---------------------------------------------------------------------------

export function renderQuizSettings(lobby, host, ctx) {
  const limits = lobby.limits.quiz;
  if (!limits) return null;
  const { categories, questions, timer } = lobby.settings;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const toggle = (id) => {
    const next = categories.includes(id) ? categories.filter((c) => c !== id) : [...categories, id];
    if (next.length === 0) return ctx.toast('Garde au moins une catégorie 😉', 'error');
    set({ categories: next });
  };
  const { min, max } = limits.questions;
  const step = 5;

  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Catégories'),
    h(
      'div',
      { class: 'cat-toggles' },
      limits.categories.map((cat) => {
        const on = categories.includes(cat.id);
        return h(
          'button',
          {
            type: 'button',
            class: `cat-toggle${on ? ' is-on' : ''}`,
            'aria-pressed': String(on),
            disabled: !host || cat.count === 0,
            onClick: () => toggle(cat.id),
          },
          h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, cat.emoji),
          h('span', { class: 'cat-label' }, cat.label),
          h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
        );
      }),
    ),
    h(
      'div',
      { class: 'rounds' },
      h('span', { class: 'rounds-label' }, 'Nombre de questions'),
      host
        ? h(
            'div',
            { class: 'stepper' },
            h('button', { type: 'button', class: 'step', 'aria-label': 'Moins de questions', disabled: questions <= min, onClick: () => set({ questions: Math.max(min, questions - step) }) }, '−'),
            h('span', { class: 'step-value', 'aria-live': 'polite' }, questions),
            h('button', { type: 'button', class: 'step', 'aria-label': 'Plus de questions', disabled: questions >= max, onClick: () => set({ questions: Math.min(max, questions + step) }) }, '+'),
          )
        : h('strong', {}, questions),
    ),
    h('span', { class: 'rounds-label' }, 'Chrono par question'),
    h(
      'div',
      { class: 'timer-choices', role: 'group', 'aria-label': 'Chrono par question' },
      limits.timers.map((value) =>
        h(
          'button',
          {
            type: 'button',
            class: `timer-choice${value === timer ? ' is-active' : ''}`,
            'aria-pressed': String(value === timer),
            disabled: !host,
            onClick: () => value !== timer && set({ timer: value }),
          },
          value ? `${value} s` : 'Sans',
        ),
      ),
    ),
    h('p', { class: 'hint hint-left' }, timer ? 'Quand le chrono tombe, on passe à la suite (ce qui est écrit compte).' : 'Sans chrono : l’hôte passe à la question suivante.'),
  );
}

// ---------------------------------------------------------------------------
// Visuel d'une question (drapeau, carte, rébus, musique, petit bac)
// ---------------------------------------------------------------------------

export function renderQuestionVisual(question, { compact = false } = {}) {
  switch (question.cat) {
    case 'drapeaux':
      return h('div', { class: 'quiz-visual quiz-flag' }, h('img', { src: `/mculture/flags/${question.flag}.svg`, alt: 'Drapeau mystère', draggable: 'false' }));
    case 'carte':
      return renderMap(question.mapId, compact);
    case 'rebus':
      return h(
        'div',
        { class: 'quiz-visual quiz-rebus' },
        h('div', { class: 'rebus-emoji' }, question.emoji),
        question.hint ? h('span', { class: 'rebus-hint' }, question.hint) : null,
      );
    case 'musique':
      return h(
        'div',
        { class: 'quiz-visual quiz-song' },
        h('span', { class: 'song-icon', 'aria-hidden': 'true' }, '🎵'),
        h('strong', { class: 'song-title' }, `« ${question.song.title} »`),
        question.song.year ? h('span', { class: 'song-year' }, `Sortie en ${question.song.year}`) : null,
      );
    case 'petit-bac':
      return h('div', { class: 'quiz-visual quiz-bac' }, h('span', { class: 'bac-label' }, 'Lettre'), h('span', { class: 'bac-letter' }, question.letter));
    default:
      return null;
  }
}

function questionTitle(question) {
  if (question.cat === 'petit-bac') return `${question.prompt} qui commence par ${question.letter}`;
  return question.prompt;
}

// ----- Carte du monde (TopoJSON world-atlas décodé ici, sans librairie) -----

let worldPromise = null;
function loadWorld() {
  worldPromise ??= fetch('/mculture/world-110m.json')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(decodeTopology)
    .catch((error) => {
      worldPromise = null;
      throw error;
    });
  return worldPromise;
}

function decodeTopology(topology) {
  const { scale, translate } = topology.transform;
  const arcs = topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  const ring = (indexes) => {
    const points = [];
    for (const index of indexes) {
      const arc = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
      points.push(...(points.length ? arc.slice(1) : arc));
    }
    return points;
  };
  return topology.objects.countries.geometries
    .filter((g) => g.id !== '010' && g.arcs) // sans l'Antarctique
    .map((g) => ({
      id: g.id,
      polygons: (g.type === 'Polygon' ? [g.arcs] : g.arcs).map((rings) => rings.map(ring)),
    }));
}

function renderMap(mapId, compact) {
  const box = h('div', { class: `quiz-visual quiz-map${compact ? ' is-compact' : ''}` }, h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  loadWorld()
    .then((countries) => box.replaceChildren(drawMap(countries, mapId)))
    .catch(() => box.replaceChildren(h('p', { class: 'hint' }, 'Carte indisponible 😕')));
  return box;
}

function drawMap(countries, mapId) {
  const target = countries.find((c) => c.id === mapId);
  // Zoom sur le plus grand morceau du pays (la France sans la Guyane, les USA sans l'Alaska…).
  const bboxOf = (points) => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  let main = [-180, -60, 180, 85];
  if (target) {
    main = target.polygons
      .map((poly) => bboxOf(poly[0]))
      .sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0];
  }
  const centerLat = (main[1] + main[3]) / 2;
  const k = Math.max(0.35, Math.cos((centerLat * Math.PI) / 180)); // limite l'étirement près des pôles
  const project = ([lon, lat]) => [lon * k, -lat];

  const [x0, y0] = project([main[0], main[3]]);
  const [x1, y1] = project([main[2], main[1]]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let w = Math.max((x1 - x0) * 2.6, 26);
  let hgt = Math.max((y1 - y0) * 2.6, 19.5);
  if (w / hgt < 4 / 3) w = hgt * (4 / 3);
  else hgt = w * (3 / 4);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${cx - w / 2} ${cy - hgt / 2} ${w} ${hgt}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Carte : le pays à trouver est en couleur');
  const rect = document.createElementNS(SVG_NS, 'rect');
  Object.entries({ x: cx - w, y: cy - hgt, width: w * 2, height: hgt * 2, class: 'map-sea' }).forEach(([key, v]) => rect.setAttribute(key, v));
  svg.append(rect);

  const pathOf = (country) =>
    country.polygons
      .flatMap((poly) => poly.map((r) => `M${r.map((p) => project(p).map((n) => n.toFixed(2)).join(',')).join('L')}Z`))
      .join('');
  for (const country of countries) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathOf(country));
    path.setAttribute('class', country.id === mapId ? 'map-target' : 'map-land');
    svg.append(path);
  }
  // Petit pays : un cercle pour le repérer.
  if (x1 - x0 < w * 0.08 && y1 - y0 < hgt * 0.08) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    Object.entries({ cx, cy, r: w * 0.07, class: 'map-ring' }).forEach(([key, v]) => circle.setAttribute(key, v));
    svg.append(circle);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Écran de question : conservé entre deux messages du serveur (on ne perd pas la saisie)
// ---------------------------------------------------------------------------

export function quizScreenKey(lobby, ui) {
  const quiz = lobby.game.quiz;
  const locked = Boolean(lobby.you?.locked) && !ui.editing;
  return `quiz:${quiz.index}:${locked}`;
}

export function buildQuizScreen(lobby, ctx, ui) {
  const { quiz } = lobby.game;
  const { question } = quiz;
  const info = catInfo(question.cat);
  const you = lobby.you ?? { answer: '', locked: false };
  const offset = quiz.serverNow - Date.now(); // décalage d'horloge avec le serveur
  const now = () => Date.now() + offset;

  const status = h('div', { class: 'stack' });
  const update = (current) => {
    status.replaceChildren(
      ...[
        ctx.renderProgress('Réponses validées', current.players, current.game.votedIds),
        ctx.isHost()
          ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, current.game.quiz.index + 1 >= current.game.quiz.total ? 'Terminer et passer à la correction ⏭' : 'Passer à la question suivante ⏭')
          : null,
      ].filter(Boolean),
    );
  };

  // Chrono
  let timerEl = null;
  let expired = false;
  const onExpire = [];
  if (quiz.deadline) {
    const fill = h('span');
    const label = h('strong', { class: 'timer-seconds' });
    timerEl = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
    const total = quiz.timer * 1000;
    const tick = () => {
      if (!timerEl.isConnected && timerEl.dataset.started) return; // écran remplacé : on arrête
      timerEl.dataset.started = '1';
      const left = Math.max(0, quiz.deadline - now());
      fill.style.width = `${(left / total) * 100}%`;
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
  if (you.locked && !ui.editing) {
    body = h(
      'section',
      { class: 'card voted' },
      h('div', { class: 'voted-check', 'aria-hidden': 'true' }, '✓'),
      h('p', {}, 'Ta réponse : ', h('strong', {}, you.answer)),
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { ui.editing = true; ctx.rerender(); } }, 'Modifier ma réponse'),
    );
  } else {
    const input = h('input', {
      type: 'text',
      class: 'answer-input',
      maxlength: '80',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'send',
      placeholder: question.cat === 'petit-bac' ? `Un mot en ${question.letter}…` : 'Ta réponse…',
      'aria-label': 'Ta réponse',
    });
    input.value = you.answer ?? '';
    let lastSent = input.value;
    let draftTimer = null;
    const sendDraft = () => {
      clearTimeout(draftTimer);
      const text = input.value;
      if (text === lastSent) return;
      lastSent = text;
      ctx.emit('quiz:answer', { index: quiz.index, text, final: false });
    };
    input.addEventListener('input', () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(sendDraft, 400);
    });
    const submit = async () => {
      const text = input.value.trim();
      if (!text) {
        ctx.toast('Écris une réponse d’abord 😉', 'error');
        input.focus();
        return;
      }
      clearTimeout(draftTimer);
      lastSent = input.value;
      const res = await ctx.action('quiz:answer', { index: quiz.index, text, final: true });
      if (res.ok) {
        ui.editing = false;
        ctx.rerender();
      }
    };
    const send = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Valider');
    body = h(
      'form',
      {
        class: 'card answer-card',
        onSubmit: (event) => {
          event.preventDefault();
          submit();
        },
      },
      input,
      send,
    );
    onExpire.push(() => {
      sendDraft();
      input.disabled = true;
      send.disabled = true;
    });
    // Focus automatique sur ordinateur (sur téléphone ça ouvrirait le clavier par-dessus la question).
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  }

  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'question-card quiz-card' },
      h(
        'div',
        { class: 'quiz-head' },
        h('span', { class: 'eyebrow' }, `Question ${quiz.index + 1} sur ${quiz.total}`),
        h('span', { class: 'cat-pill' }, `${info.emoji} ${info.label}`),
        h('span', { class: 'pts-pill' }, ptsLabel(question.pts)),
      ),
      h('h1', { class: 'question' }, questionTitle(question)),
      renderQuestionVisual(question),
    ),
    timerEl,
    body,
    status,
  );
  return { el, update };
}

// ---------------------------------------------------------------------------
// Correction : l'hôte valide ou refuse chaque réponse, tout le monde suit en direct
// ---------------------------------------------------------------------------

export function renderReview(lobby, ctx) {
  const { review } = lobby.game;
  const { question } = review;
  const info = catInfo(question.cat);
  const host = ctx.isHost();
  const last = review.index + 1 >= review.total;
  const go = (index) => ctx.action('quiz:review', { index });

  const answers = review.answers.map(({ playerId, text, correct }) => {
    const player = ctx.getPlayer(playerId);
    const toggle = (value) => ctx.action('quiz:mark', { index: review.index, playerId, correct: value });
    return h(
      'li',
      { class: `review-row${text ? (correct ? ' is-correct' : ' is-wrong') : ' is-empty'}` },
      ctx.avatar(player, 'sm'),
      h('span', { class: 'review-player' }, h('small', {}, player.name), h('strong', {}, text || 'Pas de réponse')),
      text
        ? host
          ? h(
              'span',
              { class: 'review-toggle', role: 'group', 'aria-label': `Réponse de ${player.name}` },
              h('button', { type: 'button', class: `mark mark-ok${correct ? ' is-active' : ''}`, 'aria-pressed': String(correct), title: 'Bonne réponse', onClick: () => !correct && toggle(true) }, '✓'),
              h('button', { type: 'button', class: `mark mark-ko${correct ? '' : ' is-active'}`, 'aria-pressed': String(!correct), title: 'Mauvaise réponse', onClick: () => correct && toggle(false) }, '✗'),
            )
          : h('span', { class: `mark-badge ${correct ? 'mark-ok' : 'mark-ko'}` }, correct ? `+${question.pts}` : '✗')
        : null,
    );
  });

  const scores = lobby.players
    .map((p) => ({ player: p, total: review.scores[p.id] ?? 0 }))
    .sort((a, b) => b.total - a.total);

  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'question-card quiz-card is-compact' },
      h(
        'div',
        { class: 'quiz-head' },
        h('span', { class: 'eyebrow' }, `Correction · ${review.index + 1}/${review.total}`),
        h('span', { class: 'cat-pill' }, `${info.emoji} ${info.label}`),
        h('span', { class: 'pts-pill' }, ptsLabel(question.pts)),
      ),
      h('h1', { class: 'question' }, questionTitle(question)),
      renderQuestionVisual(question, { compact: true }),
      h(
        'p',
        { class: 'good-answer' },
        question.answer ? ['Réponse : ', h('strong', {}, question.answer)] : 'Petit bac : l’hôte valide les mots qui collent.',
      ),
      question.alt?.length ? h('p', { class: 'hint' }, `Aussi accepté : ${question.alt.join(', ')}`) : null,
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Les réponses'), host ? h('span', { class: 'count' }, 'Pré-corrigé, à toi de valider') : null),
      h('ul', { class: 'review-list' }, answers),
    ),
    h(
      'nav',
      { class: 'review-dots', 'aria-label': 'Questions' },
      review.overview.map((item, index) =>
        h(
          'button',
          {
            type: 'button',
            class: `review-dot${index === review.index ? ' is-current' : ''}`,
            disabled: !host,
            title: `Question ${index + 1} : ${item.correct} bonne(s) réponse(s)`,
            onClick: () => index !== review.index && go(index),
          },
          catInfo(item.cat).emoji,
        ),
      ),
    ),
    host
      ? h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-ghost', disabled: review.index === 0, onClick: () => go(review.index - 1) }, '← Précédente'),
          last
            ? h('button', { type: 'button', class: 'btn btn-primary', onClick: () => ctx.action('quiz:finish') }, 'Voir le classement 🏁')
            : h('button', { type: 'button', class: 'btn btn-primary', onClick: () => go(review.index + 1) }, 'Suivante →'),
        )
      : ctx.renderWaiting('L’hôte corrige les réponses…'),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Scores provisoires'),
      h(
        'ol',
        { class: 'final-list' },
        scores.map(({ player, total }) =>
          h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), h('strong', {}, ptsLabel(total))),
        ),
      ),
    ),
  );
}

// Récap de fin de partie : question, bonne réponse, qui a trouvé.
export function renderQuizRecap(final, ctx) {
  if (!final.recap.length) return null;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Récap des questions'),
    h(
      'ul',
      { class: 'recap' },
      final.recap.map((item) =>
        h(
          'li',
          {},
          h('span', { class: 'recap-q' }, item.question, item.answer ? h('small', { class: 'recap-answer' }, ` → ${item.answer}`) : null),
          h('span', { class: 'recap-a' }, item.topPlayerIds.length ? item.topPlayerIds.map((id) => ctx.getPlayer(id).name).join(', ') : 'Personne 😅'),
        ),
      ),
    ),
  );
}
