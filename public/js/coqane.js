// Du coq à l'âne : dessiner, deviner, redessiner… puis révéler les carnets page par page.
import { h } from './dom.js';
import { createSketch, renderDrawing } from './paint.js';

const LEVEL = { facile: 'Facile', moyen: 'Moyen', difficile: 'Difficile', melange: 'Mélange' };

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderCoqAneSettings(lobby, host, ctx) {
  const limits = lobby.limits.coqAne;
  if (!limits) return null;
  const s = lobby.settings.coqAne;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (list, value, key, label) =>
    h('div', { class: 'timer-choices' }, list.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  const n = Math.max(limits.players, limits.minPlayers);
  const steps = n % 2 === 0 ? n : n - 1;
  return h(
    'div',
    { class: 'quiz-settings' },
    h('p', { class: 'paint-rounds-calc' }, `${n} joueurs = ${n} carnets qui font le tour de la table en `, h('strong', {}, `${steps} étapes`), ' (dessin, devinette, dessin…).'),
    h('span', { class: 'rounds-label' }, 'Mots à dessiner'),
    choices(limits.difficulties, s.difficulty, 'ccDifficulty', (v) => LEVEL[v]),
    h('span', { class: 'rounds-label' }, 'Temps pour dessiner'),
    choices(limits.draw, s.draw, 'ccDraw', (v) => `${v} s`),
    h('span', { class: 'rounds-label' }, 'Temps pour deviner'),
    choices(limits.guess, s.guess, 'ccGuess', (v) => `${v} s`),
    h('p', { class: 'hint hint-left' }, 'Chacun reçoit un mot secret et le dessine. Le carnet passe au voisin qui devine, le suivant redessine ce qui a été deviné… Le dernier doit retrouver le mot de départ. 1 pt pour chaque devinette juste, et 1 pt pour celui qui l’a dessinée.'),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export function coqAneScreenKey(lobby) {
  const c = lobby.game.coqAne;
  if (c.phase === 'cc-step') return `cc:${c.step}:${Boolean(c.task?.done)}`;
  return `cc-r:${c.reveal?.index}:${c.reveal?.shown}:${lobby.hostId}`;
}

export function buildCoqAneScreen(lobby, ctx) {
  const c = lobby.game.coqAne;
  return c.phase === 'cc-step' ? buildStep(lobby, ctx) : buildReveal(lobby, ctx);
}

function timerBar(c, onExpire) {
  if (!c.deadline) return null;
  const offset = c.serverNow - Date.now();
  const total = c.deadline - c.serverNow;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
  let fired = false;
  const tick = () => {
    if (el.dataset.started && !el.isConnected) return;
    el.dataset.started = '1';
    const left = Math.max(0, c.deadline - (Date.now() + offset));
    fill.style.width = `${(left / total) * 100}%`;
    label.textContent = `${Math.ceil(left / 1000)} s`;
    el.classList.toggle('is-urgent', left <= 10_000);
    if (left <= 300 && !fired) {
      fired = true;
      onExpire?.();
    }
    if (left > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return el;
}

function buildStep(lobby, ctx) {
  const c = lobby.game.coqAne;
  const t = c.task;
  const status = h('div', { class: 'stack' });
  const update = (current) => {
    const cc = current.game.coqAne;
    status.replaceChildren(
      ...[
        ctx.renderProgress('Carnets rendus', current.players, cc.doneIds ?? []),
        ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Faire tourner les carnets maintenant ⏭') : null,
      ].filter(Boolean),
    );
  };
  const header = h(
    'section',
    { class: 'question-card is-compact cc-head' },
    h('span', { class: 'eyebrow' }, `Étape ${c.step + 1} sur ${c.steps} · ${t?.kind === 'guess' ? 'Devine' : 'Dessine'}`),
    !t
      ? h('h1', { class: 'question' }, 'Tu regardes la partie')
      : t.kind === 'draw'
        ? [
            h('span', { class: 'cc-label' }, c.step === 0 ? 'Ton mot secret' : `Dessine ce qu’a écrit ${ctx.getPlayer(t.fromId).name}`),
            h('h1', { class: 'question cc-word' }, `« ${t.word ?? t.text} »`),
          ]
        : h('h1', { class: 'question' }, `Qu’a dessiné ${ctx.getPlayer(t.fromId).name} ?`),
  );

  if (!t || t.done) {
    const el = h(
      'div',
      { class: 'stack' },
      header,
      h('section', { class: 'card voted' }, h('div', { class: 'voted-check', 'aria-hidden': 'true' }, '✓'), h('p', {}, 'Carnet rendu ! On attend les autres…')),
      status,
    );
    return { el, update };
  }

  if (t.kind === 'draw') {
    const sketch = createSketch(ctx);
    let sent = false;
    const send = async (auto = false) => {
      if (sent) return;
      sent = true;
      const res = await ctx.action('cc:submit', { step: c.step, ops: sketch.getOps() });
      if (!res.ok && !auto) sent = false;
      if (res.ok) sketch.disable();
    };
    const el = h(
      'div',
      { class: 'stack' },
      header,
      timerBar(c, () => send(true)),
      sketch.el,
      h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => send() }, 'J’ai fini, je passe le carnet ✅'),
      status,
    );
    return { el, update };
  }

  // Devinette
  const input = h('input', { type: 'text', class: 'answer-input', maxlength: '60', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'C’est quoi ce dessin ?', 'aria-label': 'Ta réponse' });
  let sent = false;
  const send = async (auto = false) => {
    const text = input.value.trim();
    if (sent || (!text && auto)) return;
    if (!text) {
      ctx.toast('Écris ce que tu vois 😉', 'error');
      return;
    }
    sent = true;
    const res = await ctx.action('cc:submit', { step: c.step, text });
    if (!res.ok) sent = false;
  };
  const el = h(
    'div',
    { class: 'stack' },
    header,
    timerBar(c, () => send(true)),
    renderDrawing(t.ops, 'cc-drawing'),
    h('form', { class: 'card answer-card', onSubmit: (event) => { event.preventDefault(); send(); } }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Valider')),
    status,
  );
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  return { el, update };
}

// ---------------------------------------------------------------------------
// Révélation des carnets, page par page
// ---------------------------------------------------------------------------

function buildReveal(lobby, ctx) {
  const r = lobby.game.coqAne.reveal;
  const owner = ctx.getPlayer(r.ownerId);
  const host = ctx.isHost();
  const complete = r.shown >= r.pages;
  const last = complete && r.index + 1 >= r.total;
  const pages = r.visible.map((page, i) => {
    const author = ctx.getPlayer(page.authorId).name;
    if (page.kind === 'draw') {
      return h(
        'li',
        { class: `cc-page${i === r.visible.length - 1 ? ' is-new' : ''}` },
        h('span', { class: 'cc-page-who' }, `✏️ ${author} a dessiné${page.missed ? ' (rien, temps écoulé)' : ''}`),
        renderDrawing(page.ops, 'cc-drawing'),
      );
    }
    return h(
      'li',
      { class: `cc-page cc-guess${page.correct ? ' is-correct' : ''}${i === r.visible.length - 1 ? ' is-new' : ''}` },
      h('span', { class: 'cc-page-who' }, `💬 ${author} a deviné`),
      h('strong', {}, `« ${page.text} »`),
      page.correct ? h('span', { class: 'cc-ok' }, '✅ le mot de départ !') : null,
    );
  });
  const finalGuess = r.visible.at(-1)?.text;
  return {
    el: h(
      'div',
      { class: 'stack' },
      h(
        'section',
        { class: 'question-card is-compact cc-head' },
        h('span', { class: 'eyebrow' }, `Carnet ${r.index + 1} sur ${r.total}`),
        h('div', { class: 'cc-owner' }, ctx.avatar(owner, 'md'), h('span', {}, `Le carnet de ${owner.name}`)),
        h('span', { class: 'cc-label' }, 'Mot de départ'),
        h('h1', { class: 'question cc-word' }, `« ${r.word} »`),
      ),
      h('ol', { class: 'cc-pages' }, pages),
      complete
        ? h(
            'section',
            { class: `card cc-verdict${r.success ? ' is-success' : ''}` },
            r.success ? '🎉 Le mot a survécu jusqu’au bout !' : `🐓➡️🫏 « ${r.word} » est devenu « ${finalGuess} »`,
          )
        : null,
      host
        ? h(
            'div',
            { class: 'row' },
            !complete ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('cc:reveal-all') }, 'Tout montrer') : null,
            h(
              'button',
              { type: 'button', class: 'btn btn-primary', onClick: () => ctx.action('game:next') },
              !complete ? 'Page suivante →' : last ? 'Voir le classement 🏁' : 'Carnet suivant 📒',
            ),
          )
        : ctx.renderWaiting('L’hôte tourne les pages…'),
    ),
    update: () => {},
  };
}
