// Un seul indice (façon Just One) : réglages, indices, vérification des doublons, essai du devineur, révélation.
// Les zones de saisie sont conservées entre deux messages du serveur.
import { h } from './dom.js';

const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;

export function renderUnSeulIndiceSettings(lobby, host, ctx) {
  const limits = lobby.limits.unSeulIndice;
  if (!limits) return null;
  const s = lobby.settings.unSeulIndice;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (values, value, key, label) =>
    h('div', { class: 'timer-choices' }, values.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  const n = limits.players;
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, `Tours (chacun devine ${s.turns} fois${n ? ` → ${n * s.turns} mots` : ''})`),
    choices(limits.turns, s.turns, 'ujTurns', (v) => `${v}`),
    h('span', { class: 'rounds-label' }, 'Temps pour écrire son indice'),
    choices(limits.clue, s.clue, 'ujClue', (v) => `${v} s`),
    h('span', { class: 'rounds-label' }, 'Temps pour deviner'),
    choices(limits.guess, s.guess, 'ujGuess', (v) => `${v} s`),
    h(
      'p',
      { class: 'hint hint-left' },
      `Jeu coopératif ! Un devineur (chacun son tour) ne voit pas le mot. Les autres écrivent chacun UN indice d’un seul mot… mais les indices identiques s’annulent ! Le devineur a un seul essai. Mot trouvé : +${limits.points.guesser} pts au devineur, +${limits.points.clue} pt par indice gardé. ${limits.words} mots, à partir de ${limits.minPlayers} joueurs.`,
    ),
  );
}

export function unSeulIndiceScreenKey(lobby) {
  const u = lobby.game.unSeulIndice;
  return `uj:${u.index}:${u.phase}:${u.isGuesser}:${u.phase === 'uj-reveal' ? lobby.hostId : ''}`;
}

function timerBar(u, onExpire) {
  if (!u.deadline) return null;
  const offset = u.serverNow - Date.now();
  const total = u.timer * 1000;
  const fill = h('span');
  const label = h('strong', { class: 'timer-seconds' });
  const el = h('div', { class: 'quiz-timer', role: 'timer' }, h('div', { class: 'timer-bar' }, fill), label);
  let started = false;
  let fired = false;
  const tick = () => {
    if (started && !el.isConnected) return;
    started = true;
    const left = Math.max(0, u.deadline - (Date.now() + offset));
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

function header(u, ctx, eyebrow) {
  const g = ctx.getPlayer(u.guesser);
  return h(
    'section',
    { class: 'question-card quiz-card uj-head' },
    h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, eyebrow ?? `Mot ${u.index + 1} sur ${u.total}`), h('span', { class: 'cat-pill' }, `🙈 Devineur : ${g.name}`)),
    h('p', { class: 'uj-team' }, `🏆 Équipe : ${u.team.found} mot${u.team.found > 1 ? 's' : ''} trouvé${u.team.found > 1 ? 's' : ''} sur ${u.team.played}`),
  );
}

function wordCard(word, label = 'Le mot à faire deviner') {
  return h('section', { class: 'card uj-word' }, h('span', { class: 'eyebrow' }, label), h('strong', { class: 'uj-word-text' }, word));
}

function clueChips(ctx, clues, { onToggle = null, showAuthors = true } = {}) {
  if (!clues.length) return h('p', { class: 'hint uj-center' }, 'Aucun indice 😶');
  return h(
    'div',
    { class: 'uj-clues' },
    clues.map((c, i) => {
      const p = ctx.getPlayer(c.playerId);
      return h(
        onToggle ? 'button' : 'div',
        { ...(onToggle ? { type: 'button', onClick: () => onToggle(c) } : {}), class: `uj-clue${c.cancelled ? ' is-cancelled' : ''}`, style: `--i:${i}`, title: c.cancelled ? 'Indice barré' : '' },
        h('strong', { class: 'uj-clue-text' }, c.text),
        showAuthors ? h('span', { class: 'uj-clue-author' }, ctx.avatar(p, 'sm'), p.name) : null,
        c.cancelled ? h('span', { class: 'uj-clue-tag' }, c.auto ? 'doublon' : 'barré') : null,
      );
    }),
  );
}

function buildClue(lobby, ctx) {
  const u = lobby.game.unSeulIndice;
  const status = h('div', { class: 'stack' });
  const progress = (lobbyNow) => {
    const now = lobbyNow.game.unSeulIndice;
    if (!now) return;
    const writers = lobbyNow.players.filter((p) => p.id !== now.guesser);
    status.replaceChildren(...[ctx.renderProgress('Indices écrits', writers, now.doneIds), ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Passer à la vérification ⏭') : null].filter(Boolean));
  };
  if (u.isGuesser) {
    const el = h('div', { class: 'stack' }, header(u, ctx), timerBar(u), h('section', { class: 'card uj-wait' }, h('span', { class: 'uj-big-emoji', 'aria-hidden': 'true' }, '🙈'), h('h2', {}, 'C’est toi qui devines !'), h('p', { class: 'hint' }, 'Les autres écrivent chacun un indice… sans se concerter. Les doublons seront barrés.')), status);
    return { el, update: progress };
  }
  let sent = u.myClue;
  const input = h('input', { type: 'text', class: 'answer-input', maxlength: '24', autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'send', placeholder: 'Ton indice (un seul mot)', 'aria-label': 'Ton indice' });
  if (sent) input.value = sent;
  const info = h('p', { class: 'uj-sent' });
  const showInfo = () => {
    info.textContent = sent ? `✓ Envoyé : « ${sent} » — tu peux encore changer` : 'Évite l’indice évident : si quelqu’un a le même, il est barré !';
    info.classList.toggle('is-sent', Boolean(sent));
  };
  showInfo();
  const send = async (quiet = false) => {
    const text = input.value.trim();
    if (!text) return quiet ? null : ctx.toast('Écris un indice 😉', 'error');
    if (text === sent) return null;
    const payload = { index: u.index, text };
    const res = quiet ? await ctx.emit('uj:clue', payload) : await ctx.action('uj:clue', payload);
    if (res.ok) {
      sent = text;
      showInfo();
      if (!quiet) input.blur();
    }
    return res;
  };
  const el = h(
    'div',
    { class: 'stack' },
    header(u, ctx),
    timerBar(u, () => send(true)),
    wordCard(u.word),
    h('form', { class: 'card uj-form', onSubmit: (event) => { event.preventDefault(); send(); } }, h('div', { class: 'answer-card' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Envoyer')), info),
    status,
  );
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  return { el, update: progress };
}

function buildCheck(lobby, ctx) {
  const u = lobby.game.unSeulIndice;
  const g = ctx.getPlayer(u.guesser);
  const host = h('div');
  if (u.isGuesser) {
    const el = h('div', { class: 'stack' }, header(u, ctx), h('section', { class: 'card uj-wait' }, h('span', { class: 'uj-big-emoji', 'aria-hidden': 'true' }, '🧐'), ctx.renderWaiting('Tes amis vérifient les indices… ferme les yeux 🙈')), host);
    return { el, update: () => host.replaceChildren(...(ctx.isHost() ? [h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Ils mettent trop de temps ? Montrer les indices ⏭')] : [])) };
  }
  const list = h('div');
  const counter = h('p', { class: 'uj-tip' });
  const el = h(
    'div',
    { class: 'stack' },
    header(u, ctx),
    wordCard(u.word),
    h(
      'section',
      { class: 'card uj-check' },
      h('h2', {}, 'Vérifiez les indices'),
      h('p', { class: 'hint' }, `Les doublons sont barrés automatiquement. Un indice trop proche (même famille, traduction…) ? Touchez-le pour le barrer. Ensuite, montrez-les à ${g.name} !`),
      list,
      counter,
      h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('uj:confirm') }, `C’est bon, montrer à ${g.name} 👀`),
    ),
  );
  const update = (lobbyNow) => {
    const now = lobbyNow.game.unSeulIndice;
    if (!now) return;
    list.replaceChildren(clueChips(ctx, now.clues, { onToggle: (c) => ctx.action('uj:toggle', { author: c.playerId }) }));
    counter.textContent = `${now.keptCount} indice${now.keptCount > 1 ? 's' : ''} gardé${now.keptCount > 1 ? 's' : ''} sur ${now.clueCount}`;
  };
  return { el, update };
}

function buildGuess(lobby, ctx) {
  const u = lobby.game.unSeulIndice;
  const g = ctx.getPlayer(u.guesser);
  const host = h('div');
  if (!u.isGuesser) {
    const el = h(
      'div',
      { class: 'stack' },
      header(u, ctx),
      timerBar(u),
      wordCard(u.word),
      h('section', { class: 'card' }, h('h2', {}, `Les indices montrés à ${g.name}`), clueChips(ctx, u.clues)),
      h('section', { class: 'card uj-wait' }, ctx.renderWaiting(`${g.name} réfléchit… chut ! 🤫`)),
      host,
    );
    return { el, update: () => host.replaceChildren(...(ctx.isHost() ? [h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Arrêter et révéler ⏭')] : [])) };
  }
  const input = h('input', { type: 'text', class: 'answer-input', maxlength: '24', autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'send', placeholder: 'Le mot mystère…', 'aria-label': 'Ta réponse' });
  let done = false;
  const send = async (pass = false) => {
    if (done) return;
    const text = input.value.trim();
    if (!pass && !text) return ctx.toast('Écris ta réponse (ou passe) 😉', 'error');
    done = true;
    const res = await ctx.action('uj:guess', { index: u.index, text, pass });
    if (!res.ok) done = false;
  };
  const el = h(
    'div',
    { class: 'stack' },
    header(u, ctx, 'À toi de deviner ! 🙈'),
    timerBar(u),
    h('section', { class: 'card uj-shown' }, h('h2', {}, 'Tes indices'), clueChips(ctx, u.clues, { showAuthors: false })),
    h(
      'form',
      { class: 'card uj-form', onSubmit: (event) => { event.preventDefault(); send(); } },
      h('p', { class: 'uj-tip uj-center' }, 'Un seul essai !'),
      h('div', { class: 'answer-card' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Valider')),
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => send(true) }, 'Je passe 🤷'),
    ),
  );
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.isConnected && input.focus(), 50);
  return { el, update: () => {} };
}

function buildReveal(lobby, ctx) {
  const { game } = lobby;
  const u = game.unSeulIndice;
  const r = game.result;
  const g = ctx.getPlayer(r.guesser);
  const last = game.round >= game.totalRounds;
  const scores = lobby.players.map((p) => ({ player: p, total: r.scores?.[p.id] ?? 0, gain: r.gains?.[p.id] ?? 0 })).sort((a, b) => b.total - a.total);
  const verdict = r.found ? (r.accepted ? `✅ Accepté par l’hôte : « ${r.guess} »` : `✅ Trouvé ! ${g.name} a répondu « ${r.guess} »`) : r.guess ? `❌ Raté : ${g.name} a répondu « ${r.guess} »` : `🤷 ${g.name} a passé`;
  const el = h(
    'div',
    { class: 'stack' },
    header({ ...u, team: r.team }, ctx, `Réponse · mot ${game.round}/${game.totalRounds}`),
    wordCard(r.word, 'Le mot était'),
    h('p', { class: `uj-verdict${r.found ? '' : ' is-fail'}` }, verdict),
    !r.found && r.guess && ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('uj:accept') }, '👑 C’est bon quand même (synonyme, orthographe…)') : null,
    h('section', { class: 'card' }, h('h2', {}, 'Les indices'), clueChips(ctx, r.clues)),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le résultat final 🏁' : 'Mot suivant →')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h('section', { class: 'card' }, h('h2', {}, 'Scores'), h('ol', { class: 'final-list' }, scores.map(({ player, total, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(total)))))),
  );
  return { el, update: () => {} };
}

export function buildUnSeulIndiceScreen(lobby, ctx) {
  const u = lobby.game.unSeulIndice;
  if (u.phase === 'uj-clue') return buildClue(lobby, ctx);
  if (u.phase === 'uj-check') return buildCheck(lobby, ctx);
  if (u.phase === 'uj-guess') return buildGuess(lobby, ctx);
  return buildReveal(lobby, ctx);
}

// Le score de l'équipe sur l'écran de fin (c'est un jeu coopératif !).
export function renderUnSeulIndiceEnd(final) {
  const f = final.uj;
  if (!f) return null;
  const ratio = f.played ? f.found / f.played : 0;
  const mood = ratio === 1 ? 'Score parfait ! Vous êtes télépathes 🤯' : ratio >= 0.75 ? 'Excellent ! Quelle équipe 🔥' : ratio >= 0.5 ? 'Pas mal du tout 👍' : ratio > 0 ? 'Peut mieux faire… la revanche ? 😅' : 'Aïe. On n’en parle plus 🙈';
  return h(
    'section',
    { class: 'card bl-best uj-final' },
    h('span', { class: 'eyebrow' }, 'Score de l’équipe'),
    h('strong', { class: 'uj-final-score' }, `${f.found} / ${f.played}`),
    h('p', {}, `mots trouvés ensemble — ${mood}`),
  );
}
