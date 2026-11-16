// Sur la même onde (façon Wavelength) : réglages, échelle + cible (médium), curseur (les autres), révélation.
// Le curseur est conservé entre deux messages du serveur (on ne perd pas sa position).
import { h } from './dom.js';

const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderMemeOndeSettings(lobby, host, ctx) {
  const limits = lobby.limits.memeOnde;
  if (!limits) return null;
  const s = lobby.settings.memeOnde;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (values, value, key, label) =>
    h('div', { class: 'timer-choices' }, values.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  const n = limits.players;
  const z = limits.zones;
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, `Tours (chacun est médium ${s.turns} fois${n ? ` → ${n * s.turns} manches` : ''})`),
    choices(limits.turns, s.turns, 'omTurns', (v) => `${v}`),
    h('span', { class: 'rounds-label' }, 'Temps pour trouver l’indice'),
    choices(limits.clue, s.clue, 'omClue', (v) => `${v} s`),
    h('span', { class: 'rounds-label' }, 'Temps pour placer son curseur'),
    choices(limits.guess, s.guess, 'omGuess', (v) => `${v} s`),
    h(
      'p',
      { class: 'hint hint-left' },
      `À chaque manche, un médium voit une échelle (« Froid ↔ Chaud ») et une cible cachée. Il donne un indice (« une raclette »), les autres placent leur curseur. ${z.map((x) => `${x.points} pts à ±${x.within}`).join(', ')}. Le médium gagne la moyenne des points des autres. ${limits.scales} échelles, à partir de ${limits.minPlayers} joueurs.`,
    ),
  );
}

// ---------------------------------------------------------------------------
// L'échelle
// ---------------------------------------------------------------------------

// Zones de points autour de la cible (plus large → plus étroite).
function zones(target, list) {
  return [...list].reverse().map((z) => {
    const left = Math.max(0, target - z.within);
    const right = Math.min(100, target + z.within);
    return h('span', { class: `om-zone om-zone-${z.points}`, style: `left:${left}%;width:${right - left}%` }, h('b', {}, String(z.points)));
  });
}

function scaleBar(scale, { target = null, zoneList = [], markers = [], extra = null } = {}) {
  return h(
    'div',
    { class: 'om-scale' },
    h('div', { class: 'om-ends' }, h('span', { class: 'om-end om-end-left' }, `← ${scale.left}`), h('span', { class: 'om-end om-end-right' }, `${scale.right} →`)),
    h(
      'div',
      { class: 'om-bar' },
      target !== null ? zones(target, zoneList) : null,
      target !== null ? h('span', { class: 'om-target', style: `left:${target}%` }) : null,
      markers,
      extra,
    ),
    h('div', { class: 'om-ticks' }, [0, 25, 50, 75, 100].map((v) => h('span', {}, String(v)))),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function memeOndeScreenKey(lobby) {
  const o = lobby.game.memeOnde;
  return `om:${o.index}:${o.phase}:${o.isMedium}:${o.phase === 'om-reveal' ? lobby.hostId : ''}`;
}

function timerBar(o, onExpire) {
  if (!o.deadline) return null;
  const offset = o.serverNow - Date.now();
  const total = o.timer * 1000;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
  let started = false;
  let fired = false;
  const tick = () => {
    if (started && !el.isConnected) return;
    started = true;
    const left = Math.max(0, o.deadline - (Date.now() + offset));
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

function header(o, ctx, eyebrow) {
  const medium = ctx.getPlayer(o.medium);
  return h(
    'section',
    { class: 'question-card quiz-card om-head' },
    h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, eyebrow ?? `Manche ${o.index + 1} sur ${o.total}`), h('span', { class: 'cat-pill' }, `🔮 Médium : ${medium.name}`)),
    h('h1', { class: 'question om-title' }, `${o.scale.left} ↔ ${o.scale.right}`),
  );
}

function status(ctx, o, skipLabel) {
  const zone = h('div', { class: 'stack' });
  const update = (lobbyNow) => {
    const now = lobbyNow.game.memeOnde;
    if (!now) return;
    const players = lobbyNow.players.filter((p) => p.id !== now.medium);
    zone.replaceChildren(...[ctx.renderProgress('Curseurs placés', players, now.doneIds), ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, skipLabel) : null].filter(Boolean));
  };
  return { zone, update };
}

function buildClue(lobby, ctx) {
  const o = lobby.game.memeOnde;
  const medium = ctx.getPlayer(o.medium);
  if (!o.isMedium) {
    const host = h('div');
    const el = h(
      'div',
      { class: 'stack' },
      header(o, ctx),
      timerBar(o),
      scaleBar(o.scale),
      h('section', { class: 'card om-wait' }, ctx.avatar(medium, 'lg'), ctx.renderWaiting(`${medium.name} voit la cible et cherche un indice…`)),
      host,
    );
    return { el, update: () => host.replaceChildren(...(ctx.isHost() ? [h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, `${medium.name} n’est pas là ? Passer son tour ⏭`)] : [])) };
  }
  const input = h('input', { type: 'text', class: 'answer-input', maxlength: '40', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'Ton indice (« une raclette »…)', 'aria-label': 'Ton indice' });
  const send = async () => {
    const text = input.value.trim();
    if (!text) return ctx.toast('Écris un indice 😉', 'error');
    await ctx.action('om:clue', { text });
  };
  const el = h(
    'div',
    { class: 'stack' },
    header(o, ctx, 'Tu es le médium 🔮'),
    timerBar(o),
    scaleBar(o.scale, { target: o.target, zoneList: o.zones }),
    h(
      'form',
      { class: 'card om-clue-form', onSubmit: (event) => { event.preventDefault(); send(); } },
      h('p', { class: 'om-tip' }, 'La cible est à ', h('strong', {}, `${o.target} %`), ` entre « ${o.scale.left} » et « ${o.scale.right} ». Donne un indice qui y fait penser : un mot, un objet, une personne…`),
      h('div', { class: 'answer-card' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Envoyer 🔮')),
    ),
  );
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  return { el, update: () => {} };
}

function buildGuess(lobby, ctx) {
  const o = lobby.game.memeOnde;
  const st = status(ctx, o, 'Révéler maintenant ⏭');
  const clueCard = h('section', { class: 'card om-clue' }, h('span', { class: 'eyebrow' }, `L’indice de ${ctx.getPlayer(o.medium).name}`), h('strong', { class: 'om-clue-text' }, `« ${o.clue} »`));
  if (o.isMedium) {
    const el = h('div', { class: 'stack' }, header(o, ctx), timerBar(o), clueCard, scaleBar(o.scale, { target: o.target, zoneList: o.zones }), h('p', { class: 'om-tip om-center' }, 'Les autres placent leur curseur… pas un mot ! 🤐'), st.zone);
    return { el, update: (now) => st.update(now) };
  }
  let value = o.myGuess ?? 50;
  let sent = o.myGuess !== null;
  const bubble = h('span', { class: 'om-bubble' });
  const range = h('input', { type: 'range', min: '0', max: '100', step: '1', class: 'om-range', 'aria-label': `Position entre ${o.scale.left} et ${o.scale.right}` });
  range.value = String(value);
  const info = h('p', { class: 'om-tip om-center' });
  const showInfo = () => {
    info.textContent = sent ? '✓ Position envoyée — tu peux encore la changer jusqu’à la fin' : 'Glisse le curseur, puis valide';
    info.classList.toggle('is-sent', sent);
  };
  const place = () => {
    bubble.style.left = `${value}%`;
    bubble.textContent = String(value);
  };
  const send = async (quiet = false) => {
    const payload = { index: o.index, position: value };
    const res = quiet ? await ctx.emit('om:guess', payload) : await ctx.action('om:guess', payload);
    if (res.ok) {
      sent = true;
      showInfo();
    }
  };
  range.addEventListener('input', () => {
    value = Number(range.value);
    if (sent) {
      sent = false;
      showInfo();
    }
    place();
  });
  place();
  showInfo();
  const el = h(
    'div',
    { class: 'stack' },
    header(o, ctx),
    timerBar(o, () => !sent && send(true)),
    clueCard,
    scaleBar(o.scale, { extra: [range, bubble] }),
    info,
    h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => send() }, 'Valider ma position 🎯'),
    st.zone,
  );
  return { el, update: (now) => st.update(now) };
}

function buildReveal(lobby, ctx) {
  const { game } = lobby;
  const o = game.memeOnde;
  const r = game.result;
  const last = game.round >= game.totalRounds;
  const markers = r.shots.map((s, i) => {
    const p = ctx.getPlayer(s.playerId);
    return h('span', { class: `om-marker${s.points ? ` om-hit-${s.points}` : ''}`, style: `left:${s.position}%;--i:${i};--row:${i % 3}`, title: `${p.name} : ${s.position}` }, ctx.avatar(p, 'sm'));
  });
  const scores = lobby.players.map((p) => ({ player: p, total: r.scores?.[p.id] ?? 0, gain: r.gains?.[p.id] ?? 0 })).sort((a, b) => b.total - a.total);
  const medium = ctx.getPlayer(r.medium);
  const el = h(
    'div',
    { class: 'stack' },
    header(o, ctx, `Réponse · manche ${game.round}/${game.totalRounds}`),
    h('section', { class: 'card om-clue' }, h('span', { class: 'eyebrow' }, `L’indice de ${medium.name}`), h('strong', { class: 'om-clue-text' }, `« ${r.clue} »`), h('p', { class: 'hint' }, `La cible était à ${r.target} %`)),
    scaleBar(r.scale, { target: r.target, zoneList: o.zones, markers }),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Qui était sur la même onde ?'),
      h(
        'ol',
        { class: 'final-list' },
        r.shots.map((s) => { const p = ctx.getPlayer(s.playerId); return h('li', {}, ctx.avatar(p, 'sm'), h('span', { class: 'final-name' }, p.name), h('span', { class: 'om-dist' }, s.distance === 0 ? 'pile dessus ! 🎯' : `à ${s.distance}`), h('strong', {}, s.points ? `+${s.points}` : '0')); }),
        h('li', { class: 'om-medium-row' }, ctx.avatar(medium, 'sm'), h('span', { class: 'final-name' }, `${medium.name} 🔮`), h('span', { class: 'om-dist' }, 'médium : la moyenne'), h('strong', {}, r.mediumPoints ? `+${r.mediumPoints}` : '0')),
      ),
    ),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Manche suivante →')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h('section', { class: 'card' }, h('h2', {}, 'Scores'), h('ol', { class: 'final-list' }, scores.map(({ player, total, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(total)))))),
  );
  return { el, update: () => {} };
}

export function buildMemeOndeScreen(lobby, ctx) {
  const o = lobby.game.memeOnde;
  if (o.phase === 'om-clue') return buildClue(lobby, ctx);
  if (o.phase === 'om-guess') return buildGuess(lobby, ctx);
  return buildReveal(lobby, ctx);
}

// Carte « meilleur tir » sur l'écran de fin.
export function renderMemeOndeBest(final, ctx) {
  const b = final.om?.bestShot;
  if (!b) return null;
  return h(
    'section',
    { class: 'card bl-best' },
    h('span', { class: 'eyebrow' }, '🎯 Le plus en phase de la soirée'),
    h('strong', { class: 'bl-best-text' }, `${ctx.getPlayer(b.playerId).name} — ${b.distance === 0 ? 'pile sur la cible' : `à ${b.distance} de la cible`}`),
    h('p', {}, `sur « ${b.clue} » de ${ctx.getPlayer(b.medium).name} (${b.scale.left} ↔ ${b.scale.right})`),
  );
}
