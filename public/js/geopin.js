// Géo Pin : réglages, carte où l'on pose son épingle (zoom, déplacement), révélation des distances.
import { h } from './dom.js';
import { loadWorld } from './mculture.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CAT_INFO = {
  monde: { label: 'Villes', emoji: '🌍' },
  pays: { label: 'Pays', emoji: '🗺️' },
  monuments: { label: 'Monuments', emoji: '🗿' },
  europe: { label: 'Europe', emoji: '🏰' },
  asie: { label: 'Asie', emoji: '🏯' },
  amerique: { label: 'Amérique', emoji: '🗽' },
  afrique: { label: 'Afrique', emoji: '🦁' },
  france: { label: 'France', emoji: '🇫🇷' },
};
const catInfo = (id) => CAT_INFO[id] ?? { label: id, emoji: '📍' };
const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const km = (n) => `${n.toLocaleString('fr-FR')} km`;
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderGeoPinSettings(lobby, host, ctx) {
  const limits = lobby.limits.geoPin;
  if (!limits) return null;
  const s = lobby.settings.geoPin;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const toggle = (id) => {
    const next = s.categories.includes(id) ? s.categories.filter((c) => c !== id) : [...s.categories, id];
    if (next.length === 0) return ctx.toast('Garde au moins une catégorie 😉', 'error');
    set({ gpCategories: next });
  };
  const switchBtn = (on, label, emoji, disabled, onClick, title) =>
    h(
      'button',
      { type: 'button', class: `cat-toggle${on ? ' is-on' : ''}`, 'aria-pressed': String(on), disabled, onClick, title: title ?? '' },
      h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, emoji),
      h('span', { class: 'cat-label' }, label),
      h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
    );
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Sur la carte du monde'),
    h('div', { class: 'cat-toggles gp-cats' }, limits.categories.filter((cat) => cat.group === 'monde').map((cat) => switchBtn(s.categories.includes(cat.id), cat.label, cat.emoji, !host || cat.count === 0, () => toggle(cat.id), `${cat.count} lieux`))),
    h('span', { class: 'rounds-label' }, 'Villes par région (carte zoomée)'),
    h('div', { class: 'cat-toggles gp-cats' }, limits.categories.filter((cat) => cat.group === 'region').map((cat) => switchBtn(s.categories.includes(cat.id), cat.label, cat.emoji, !host || cat.count === 0, () => toggle(cat.id), `${cat.count} villes`))),
    h('span', { class: 'rounds-label' }, 'Temps pour poser son épingle'),
    h('div', { class: 'timer-choices' }, limits.timers.map((v) => h('button', { type: 'button', class: `timer-choice${v === s.timer ? ' is-active' : ''}`, 'aria-pressed': String(v === s.timer), disabled: !host, onClick: () => v !== s.timer && set({ gpTimer: v }) }, `${v} s`))),
    h('div', { class: 'cat-toggles' }, switchBtn(s.hint, 'Afficher un indice (pays, département)', '💡', !host, () => set({ gpHint: !s.hint }))),
    h('p', { class: 'hint hint-left' }, `Un lieu s’affiche, chacun pose son épingle sur la carte. Jusqu’à ${limits.maxPoints} pts par lieu : plus tu es proche, plus tu marques. En mode Pays, il suffit de poser l’épingle dans le bon pays. Les régions et la France se jouent sur une carte zoomée, où il faut être plus précis.`),
  );
}

// ---------------------------------------------------------------------------
// La carte : glisser pour se déplacer, pincer / molette / boutons pour zoomer, toucher pour poser l'épingle
// ---------------------------------------------------------------------------

const VIEWS = {
  monde: { k: 1, cx: 0, cy: -12, w: 360, minW: 6, bounds: [-180, -85, 180, 60] },
  europe: { k: 0.62, cx: 6.2, cy: -53, w: 57, minW: 3, bounds: [-25, -74, 38, -32] },
  asie: { k: 0.87, cx: 76, cy: -22, w: 112, minW: 5, bounds: [18, -60, 136, 14] },
  amerique: { k: 0.95, cx: -95, cy: -8, w: 195, minW: 6, bounds: [-195, -75, 5, 60] },
  afrique: { k: 1, cx: 17.5, cy: -1, w: 113, minW: 5, bounds: [-40, -40, 75, 40] },
  france: { k: 0.688, cx: 1.6, cy: -46.4, w: 17, minW: 1.2, bounds: [-9, -52.5, 12, -40] },
};
const RATIO = 3 / 2;

function createMap(viewName, { onPick = null, highlightId = null } = {}) {
  const base = VIEWS[viewName] ?? VIEWS.monde;
  const project = ({ lat, lon }) => [lon * base.k, -lat];
  const view = { cx: base.cx, cy: base.cy, w: base.w };
  const svg = svgEl('svg', { role: 'img', 'aria-label': 'Carte' });
  const land = svgEl('g');
  const overlay = svgEl('g');
  svg.append(svgEl('rect', { x: -400, y: -200, width: 800, height: 400, class: 'map-sea' }), land, overlay);
  const box = h('div', { class: `gp-map${onPick ? ' is-pickable' : ''}` }, svg);
  const markers = []; // { draw(scale) }
  let locked = false;

  const apply = () => {
    view.w = Math.min(base.w, Math.max(base.minW, view.w));
    const hgt = view.w / RATIO;
    const [x0, y0, x1, y1] = base.bounds;
    view.cx = Math.min(Math.max(view.cx, x0 + Math.min(view.w / 2, (x1 - x0) / 2)), x1 - Math.min(view.w / 2, (x1 - x0) / 2));
    view.cy = Math.min(Math.max(view.cy, y0 + Math.min(hgt / 2, (y1 - y0) / 2)), y1 - Math.min(hgt / 2, (y1 - y0) / 2));
    svg.setAttribute('viewBox', `${view.cx - view.w / 2} ${view.cy - hgt / 2} ${view.w} ${hgt}`);
    for (const m of markers) m.draw(view.w / 100);
  };
  const zoom = (factor, around = null) => {
    const before = view.w;
    view.w = Math.min(base.w, Math.max(base.minW, view.w * factor));
    if (around) {
      const f = view.w / before;
      view.cx = around[0] + (view.cx - around[0]) * f;
      view.cy = around[1] + (view.cy - around[1]) * f;
    }
    apply();
  };
  const toMap = (event) => {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const p = point.matrixTransform(svg.getScreenCTM().inverse());
    return [p.x, p.y];
  };

  // Gestes : un doigt = déplacer (ou toucher), deux doigts = zoomer.
  const pointers = new Map();
  let moved = 0;
  let pinch = null;
  svg.addEventListener('pointerdown', (event) => {
    svg.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), w: view.w };
      moved = 99;
    }
  });
  svg.addEventListener('pointermove', (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0) {
        view.w = pinch.w * (pinch.dist / dist);
        apply();
      }
      return;
    }
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved > 8) {
      const unit = view.w / svg.clientWidth;
      view.cx -= dx * unit;
      view.cy -= dy * unit;
      apply();
    }
  });
  const end = (event) => {
    const had = pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (had && event.type === 'pointerup' && pointers.size === 0 && moved <= 8 && onPick && !locked) {
      const [x, y] = toMap(event);
      onPick({ lat: Math.max(-85, Math.min(85, -y)), lon: Math.max(-180, Math.min(180, x / base.k)) });
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom(event.deltaY > 0 ? 1.25 : 0.8, toMap(event));
  }, { passive: false });

  box.append(
    h(
      'div',
      { class: 'gp-zoom' },
      h('button', { type: 'button', 'aria-label': 'Zoomer', onClick: () => zoom(0.6) }, '+'),
      h('button', { type: 'button', 'aria-label': 'Dézoomer', onClick: () => zoom(1 / 0.6) }, '−'),
      h('button', { type: 'button', 'aria-label': 'Vue d’ensemble', onClick: () => { Object.assign(view, { cx: base.cx, cy: base.cy, w: base.w }); apply(); } }, '⤢'),
    ),
  );

  loadWorld()
    .then((countries) => {
      for (const country of countries) {
        // Un contour qui traverse le bord de la carte (Russie, Fidji) est « déplié » et dessiné des deux côtés,
        // sinon il tracerait un trait d'un bord à l'autre.
        const draw = (ring, shift = 0) => `M${ring.map(([lon, lat]) => `${((lon + shift) * base.k).toFixed(2)},${(-lat).toFixed(2)}`).join('L')}Z`;
        const d = country.polygons
          .flatMap((poly) =>
            poly.map((ring) => {
              const crosses = ring.some(([lon], i) => i > 0 && Math.abs(lon - ring[i - 1][0]) > 180);
              if (!crosses) return draw(ring);
              const unwrapped = ring.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]);
              return draw(unwrapped) + draw(unwrapped, -360);
            }),
          )
          .join('');
        land.append(svgEl('path', { d, class: highlightId && country.id === highlightId ? 'map-target' : 'map-land' }));
      }
    })
    .catch(() => box.append(h('p', { class: 'hint gp-map-error' }, 'Carte indisponible 😕')));

  apply();
  return {
    el: box,
    lock: () => {
      locked = true;
      box.classList.add('is-locked');
    },
    // Épingle ronde (couleur + initiales facultatives) ou étoile pour la bonne réponse.
    addPin(position, { color = '#ffd23f', label = '', star = false, line = null } = {}) {
      const [x, y] = project(position);
      const g = svgEl('g', { class: `gp-pin${star ? ' is-target' : ''}` });
      const link = line ? svgEl('line', { class: 'gp-line' }) : null;
      const dot = svgEl('circle', { cx: x, cy: y, fill: color, class: 'gp-dot' });
      const text = svgEl('text', { x, y, class: 'gp-pin-label' });
      text.textContent = star ? '★' : label;
      if (link) overlay.prepend(link);
      g.append(dot, text);
      overlay.append(g);
      const marker = {
        draw(u) {
          dot.setAttribute('r', (star ? 2.6 : 2.2) * u);
          text.setAttribute('font-size', (star ? 3 : 1.9) * u);
          text.setAttribute('dy', (star ? 1.05 : 0.68) * u);
          if (link) {
            const [tx, ty] = project(line);
            Object.entries({ x1: x, y1: y, x2: tx, y2: ty, 'stroke-width': 0.35 * u, 'stroke-dasharray': `${1 * u} ${0.8 * u}` }).forEach(([k, v]) => link.setAttribute(k, v));
          }
        },
        remove() {
          g.remove();
          link?.remove();
          markers.splice(markers.indexOf(marker), 1);
        },
      };
      markers.push(marker);
      marker.draw(view.w / 100);
      return marker;
    },
    // Cadre la carte sur un ensemble de positions.
    fit(positions) {
      const pts2 = positions.map(project);
      const xs = pts2.map((p) => p[0]);
      const ys = pts2.map((p) => p[1]);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      view.cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      view.cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      view.w = Math.max(spanX * 1.5, spanY * RATIO * 1.5, base.minW * 4);
      apply();
    },
  };
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function geoPinScreenKey(lobby) {
  const g = lobby.game.geoPin;
  return g.phase === 'gp-guess' ? `gp-g:${g.index}` : `gp-r:${g.index}:${lobby.hostId}`;
}

export function buildGeoPinScreen(lobby, ctx) {
  return lobby.game.geoPin.phase === 'gp-guess' ? buildGuess(lobby, ctx) : buildReveal(lobby, ctx);
}

function header(g, eyebrow) {
  const info = catInfo(g.question.cat);
  return h(
    'section',
    { class: 'question-card quiz-card is-compact' },
    h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, eyebrow ?? `Lieu ${g.index + 1} sur ${g.total}`), h('span', { class: 'cat-pill' }, `${info.emoji} ${info.label}`)),
    h('h1', { class: 'question gp-place' }, '📍 ', g.question.name),
    g.question.hint ? h('span', { class: 'gp-hint' }, `💡 ${g.question.hint}`) : null,
  );
}

function timerBar(g, onExpire) {
  if (!g.deadline) return null;
  const offset = g.serverNow - Date.now();
  const total = g.timer * 1000;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
  let started = false;
  let fired = false;
  const tick = () => {
    if (started && !el.isConnected) return;
    started = true;
    const left = Math.max(0, g.deadline - (Date.now() + offset));
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

function buildGuess(lobby, ctx) {
  const g = lobby.game.geoPin;
  let pick = g.myGuess;
  let done = Boolean(g.myGuess);
  let pin = null;
  const me = ctx.me();
  const tip = h('p', { class: 'gp-tip' });
  const button = h('button', { type: 'button', class: 'btn btn-primary btn-big' }, 'Valider mon épingle 📍');
  const map = createMap(g.question.view, {
    onPick: (position) => {
      if (done) return;
      pick = position;
      pin?.remove();
      pin = map.addPin(pick, { label: '📍' });
      refresh();
    },
  });
  const refresh = () => {
    button.disabled = !pick || done;
    button.textContent = done ? 'Épingle validée ✓' : 'Valider mon épingle 📍';
    tip.textContent = done ? 'C’est noté ! On attend les autres…' : pick ? 'Touche ailleurs pour la déplacer, puis valide.' : 'Touche la carte pour poser ton épingle. Zoome pour être précis !';
    if (done) map.lock();
  };
  const send = async (quiet = false) => {
    if (!pick || done) return;
    done = true;
    refresh();
    const payload = { index: g.index, lat: pick.lat, lon: pick.lon };
    const res = quiet ? await ctx.emit('gp:guess', payload) : await ctx.action('gp:guess', payload);
    if (!res.ok && !quiet) {
      done = false;
      refresh();
    }
  };
  button.addEventListener('click', () => send());
  if (pick) pin = map.addPin(pick, { label: '📍' });
  refresh();

  const status = h('div', { class: 'stack' });
  const update = (current) => {
    const cg = current.game.geoPin;
    if (cg?.myGuess && !done) {
      done = true;
      refresh();
    }
    status.replaceChildren(
      ...[
        ctx.renderProgress('Épingles posées', current.players, cg?.doneIds ?? []),
        ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Révéler sans attendre ⏭') : null,
      ].filter(Boolean),
    );
  };
  void me;
  return { el: h('div', { class: 'stack' }, header(g), timerBar(g, () => send(true)), map.el, tip, button, status), update };
}

function buildReveal(lobby, ctx) {
  const { game } = lobby;
  const g = game.geoPin;
  const { result } = game;
  const last = game.round >= game.totalRounds;
  const isCountry = Boolean(result.place.countryId);
  const map = createMap(result.place.view, { highlightId: result.place.countryId });
  const placed = result.entries.filter((e) => e.km !== null);
  for (const e of placed) {
    const player = ctx.getPlayer(e.playerId);
    map.addPin(e, { color: ctx.colorFor(e.playerId), label: ctx.initials(player.name), line: isCountry ? null : result.place });
  }
  if (!isCountry) map.addPin(result.place, { star: true }); // un pays est colorié, pas besoin d'étoile
  map.fit([result.place, ...placed]);

  const rows = result.entries.map((e, i) => {
    const player = ctx.getPlayer(e.playerId);
    return h(
      'li',
      { class: `gp-row${i === 0 && e.km !== null ? ' is-best' : ''}` },
      ctx.avatar(player, 'sm'),
      h('span', { class: 'final-name' }, player.name),
      h('span', { class: 'gp-km' }, e.km === null ? 'pas d’épingle' : e.km === 0 ? (isCountry ? 'dans le pays 🎯' : 'pile dessus 🎯') : isCountry ? `à ${km(e.km)} de la frontière` : `à ${km(e.km)}`),
      h('strong', { class: 'gp-points' }, `+${e.points}`),
    );
  });
  const scores = lobby.players.map((p) => ({ player: p, total: result.scores?.[p.id] ?? 0 })).sort((a, b) => b.total - a.total);
  return {
    el: h(
      'div',
      { class: 'stack' },
      header(g, `Réponse · lieu ${game.round}/${game.totalRounds}`),
      map.el,
      h('section', { class: 'card' }, h('h2', {}, 'Qui était le plus près ?'), h('ol', { class: 'gp-list' }, rows)),
      ctx.isHost()
        ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Lieu suivant →')
        : ctx.renderWaiting('L’hôte va lancer la suite…'),
      h('section', { class: 'card' }, h('h2', {}, 'Scores'), h('ol', { class: 'final-list' }, scores.map(({ player, total }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), h('strong', {}, pts(total)))))),
    ),
    update: () => {},
  };
}

// Carte « tir le plus précis » sur l'écran de fin.
export function renderGeoPinBest(final, ctx) {
  const best = final.geoPin?.best;
  if (!best) return null;
  return h(
    'section',
    { class: 'card bl-best' },
    h('span', { class: 'eyebrow' }, '🎯 Épingle la plus précise'),
    h('strong', { class: 'bl-best-text' }, best.km === 0 ? 'Pile dessus !' : `À ${km(best.km)}`),
    h('p', {}, `${ctx.getPlayer(best.playerId).name} · ${best.name}`),
  );
}
