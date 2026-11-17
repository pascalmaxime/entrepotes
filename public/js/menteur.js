// Menteur ! (2 vérités, 1 mensonge) : réglages, écriture des 3 affirmations, vote, révélation, meilleur menteur.
// Le formulaire d'écriture est conservé entre deux messages du serveur : rien n'est perdu.
import { h } from './dom.js';

const pts = (n) => `${n} pt${n > 1 ? 's' : ''}`;
const IDEAS = [
  'un pays où tu es allé', 'un plat que tu détestes', 'une célébrité que tu as croisée', 'ta pire honte au collège', 'un sport que tu as pratiqué',
  'un objet bizarre que tu collectionnes', 'un talent caché', 'ta première voiture', 'une phobie', 'un concert marquant', 'une blessure étonnante',
  'un record personnel', 'un animal que tu as eu', 'un job d’été', 'une bêtise d’enfant', 'une rencontre improbable', 'une langue que tu parles',
  'un film que tu n’as jamais vu', 'un truc que tu as gagné', 'ton surnom d’enfance', 'une chanson que tu connais par cœur', 'un endroit où tu t’es perdu',
];

export function renderMenteurSettings(lobby, host, ctx) {
  const limits = lobby.limits.menteur;
  if (!limits) return null;
  const s = lobby.settings.menteur;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  const choices = (values, value, key, label) =>
    h('div', { class: 'timer-choices' }, values.map((v) => h('button', { type: 'button', class: `timer-choice${v === value ? ' is-active' : ''}`, 'aria-pressed': String(v === value), disabled: !host, onClick: () => v !== value && set({ [key]: v }) }, label(v))));
  const min = (v) => (v % 60 ? `${Math.floor(v / 60)} min ${v % 60}` : `${v / 60} min`);
  return h(
    'div',
    { class: 'quiz-settings' },
    h('span', { class: 'rounds-label' }, 'Temps pour écrire ses 3 affirmations'),
    choices(limits.write, s.write, 'mtWrite', min),
    h('span', { class: 'rounds-label' }, 'Temps de vote par joueur'),
    choices(limits.vote, s.vote, 'mtVote', (v) => `${v} s`),
    h(
      'p',
      { class: 'hint hint-left' },
      `Chacun écrit 3 affirmations sur lui : 2 vraies, 1 fausse. Puis chaque joueur passe sur la sellette : les autres votent pour le mensonge (il peut raconter des anecdotes pour les embrouiller !). +${limits.points.found} pts si tu trouves le mensonge, +${limits.points.fooled} pt au menteur par joueur trompé. À partir de ${limits.minPlayers} joueurs.`,
    ),
  );
}

export function menteurScreenKey(lobby) {
  const m = lobby.game.menteur;
  return m.phase === 'mt-write' ? 'mt-w' : `mt:${m.index}:${m.phase}:${m.isSubject}:${m.phase === 'mt-reveal' ? lobby.hostId : ''}`;
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
    const s = Math.ceil(left / 1000);
    label.textContent = s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`;
    el.classList.toggle('is-urgent', left <= 10_000);
    if (left > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return el;
}

function buildWrite(lobby, ctx) {
  const m = lobby.game.menteur;
  const sheet = m.mySheet;
  let lie = sheet?.lie ?? null;
  let sent = Boolean(sheet);
  const inputs = [0, 1, 2].map((i) => {
    const input = h('textarea', { class: 'mt-input', rows: '2', maxlength: '90', placeholder: `Affirmation ${i + 1}…`, 'aria-label': `Affirmation ${i + 1}` });
    if (sheet) input.value = sheet.statements[i];
    input.addEventListener('input', () => {
      if (sent) {
        sent = false;
        showInfo();
      }
    });
    return input;
  });
  const lieButtons = [0, 1, 2].map((i) =>
    h('button', { type: 'button', class: 'mt-lie-toggle', onClick: () => { lie = i; sent = false; drawLie(); showInfo(); } }, ''),
  );
  const rows = [0, 1, 2].map((i) => h('div', { class: 'mt-row' }, inputs[i], lieButtons[i]));
  const drawLie = () => lieButtons.forEach((b, i) => {
    b.textContent = i === lie ? '🤥 Mensonge' : 'Vrai ✓';
    b.classList.toggle('is-lie', i === lie);
    b.setAttribute('aria-pressed', String(i === lie));
    rows[i].classList.toggle('is-lie', i === lie);
  });
  drawLie();
  const info = h('p', { class: 'mt-sent' });
  const showInfo = () => {
    info.textContent = sent ? '✓ Envoyé ! Tu peux encore modifier jusqu’à la fin.' : lie === null ? 'Écris 2 vérités et 1 mensonge, puis touche « Vrai ✓ » sur le mensonge.' : 'Pense à envoyer 😉';
    info.classList.toggle('is-sent', sent);
  };
  showInfo();
  const ideaZone = h('p', { class: 'mt-idea' });
  const idea = () => {
    const picks = [...IDEAS].sort(() => Math.random() - 0.5).slice(0, 3);
    ideaZone.textContent = `💡 Par exemple : ${picks.join(' · ')}`;
  };
  const send = async () => {
    const statements = inputs.map((x) => x.value.trim());
    if (statements.some((s) => !s)) return ctx.toast('Écris tes 3 affirmations 😉', 'error');
    if (lie === null) return ctx.toast('Touche « Vrai ✓ » sur celle qui est fausse 🤥', 'error');
    const res = await ctx.action('mt:sheet', { statements, lie });
    if (res.ok) {
      sent = true;
      showInfo();
    }
  };
  const status = h('div', { class: 'stack' });
  const el = h(
    'div',
    { class: 'stack' },
    h('section', { class: 'question-card quiz-card' }, h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, 'À vos stylos !'), h('span', { class: 'cat-pill' }, '🤥 Menteur !')), h('h1', { class: 'question' }, '2 vérités, 1 mensonge sur toi')),
    timerBar(m),
    h(
      'form',
      { class: 'card mt-form', onSubmit: (event) => { event.preventDefault(); send(); } },
      rows,
      h('div', { class: 'mt-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onClick: idea }, '💡 Une idée ?'), h('button', { type: 'submit', class: 'btn btn-primary' }, 'Envoyer')),
      ideaZone,
      info,
    ),
    status,
  );
  const update = (lobbyNow) => {
    const now = lobbyNow.game.menteur;
    if (!now) return;
    status.replaceChildren(...[ctx.renderProgress('Prêts', lobbyNow.players, now.doneIds), ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Passer au vote sans attendre ⏭') : null].filter(Boolean));
  };
  return { el, update };
}

function sellette(m, ctx, eyebrow) {
  const p = ctx.getPlayer(m.subject);
  return h(
    'section',
    { class: 'question-card quiz-card mt-sellette' },
    h('div', { class: 'quiz-head' }, h('span', { class: 'eyebrow' }, eyebrow), h('span', { class: 'cat-pill' }, '🤥 Menteur !')),
    ctx.avatar(p, 'lg'),
    h('h1', { class: 'question' }, m.isSubject ? 'Tu es sur la sellette !' : `${p.name} est sur la sellette`),
  );
}

function buildVote(lobby, ctx) {
  const m0 = lobby.game.menteur;
  const body = h('div', { class: 'stack' });
  const status = h('div', { class: 'stack' });
  const el = h('div', { class: 'stack' }, sellette(m0, ctx, `Joueur ${m0.index + 1} sur ${m0.total}`), timerBar(m0), body, status);
  const update = (lobbyNow) => {
    const m = lobbyNow.game.menteur;
    if (!m) return;
    const name = ctx.getPlayer(m.subject).name;
    body.replaceChildren(
      h('p', { class: 'mt-tip' }, m.isSubject ? 'Raconte des anecdotes pour les embrouiller 😈 (ton mensonge est en rouge, chut !)' : m.myVote ? '✓ Vote enregistré — tu peux encore changer' : `Laquelle est le mensonge de ${name} ?`),
      h(
        'div',
        { class: 'mt-cards' },
        m.cards.map((c, i) =>
          h(
            m.isSubject ? 'div' : 'button',
            {
              ...(m.isSubject ? {} : { type: 'button', onClick: () => c.id !== m.myVote && ctx.action('mt:vote', { cardId: c.id }) }),
              class: `mt-card${c.id === m.myVote ? ' is-voted' : ''}${c.lie ? ' is-lie' : ''}`,
              style: `--i:${i}`,
            },
            h('span', { class: 'mt-num' }, String(i + 1)),
            h('span', { class: 'mt-text' }, c.text),
            c.lie ? h('span', { class: 'mt-tag' }, '🤥') : c.id === m.myVote ? h('span', { class: 'mt-tag' }, '🎯') : null,
          ),
        ),
      ),
    );
    const voters = lobbyNow.players.filter((p) => p.id !== m.subject);
    status.replaceChildren(...[ctx.renderProgress('Votes', voters, m.votedIds), ctx.isHost() ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => ctx.action('game:reveal') }, 'Révéler maintenant ⏭') : null].filter(Boolean));
  };
  return { el, update };
}

function buildReveal(lobby, ctx) {
  const { game } = lobby;
  const m = game.menteur;
  const r = game.result;
  const p = ctx.getPlayer(r.subject);
  const last = game.round >= game.totalRounds;
  const total = r.finders.length + r.fooled.length;
  const verdict = total === 0 ? 'Personne n’a voté 🤷' : r.fooled.length === 0 ? `Démasqué ! Tout le monde a trouvé le mensonge de ${p.name} 🕵️` : r.finders.length === 0 ? `Quel menteur ! ${p.name} a trompé tout le monde 😈` : `${p.name} a trompé ${r.fooled.length} joueur${r.fooled.length > 1 ? 's' : ''} sur ${total}`;
  const scores = lobby.players.map((pl) => ({ player: pl, total: r.scores?.[pl.id] ?? 0, gain: r.gains?.[pl.id] ?? 0 })).sort((a, b) => b.total - a.total);
  const el = h(
    'div',
    { class: 'stack' },
    sellette({ ...m, isSubject: false, subject: r.subject }, ctx, `Réponse · joueur ${game.round}/${game.totalRounds}`),
    h('p', { class: `mt-verdict${r.fooled.length ? ' is-fooled' : ''}` }, verdict),
    h(
      'div',
      { class: 'mt-cards' },
      r.cards.map((c, i) =>
        h(
          'div',
          { class: `mt-card is-revealed${c.lie ? ' is-lie' : ' is-true'}`, style: `--i:${i}` },
          h('span', { class: 'mt-num' }, c.lie ? '🤥' : '✓'),
          h('span', { class: 'mt-text' }, c.text, h('small', { class: 'mt-kind' }, c.lie ? 'MENSONGE' : 'vrai')),
          h('span', { class: 'mt-voters' }, c.voters.map((id) => ctx.avatar(ctx.getPlayer(id), 'sm'))),
        ),
      ),
    ),
    ctx.isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => ctx.action('game:next') }, last ? 'Voir le classement final 🏁' : 'Joueur suivant →')
      : ctx.renderWaiting('L’hôte va lancer la suite…'),
    h('section', { class: 'card' }, h('h2', {}, 'Scores'), h('ol', { class: 'final-list' }, scores.map(({ player, total: t, gain }) => h('li', {}, ctx.avatar(player, 'sm'), h('span', { class: 'final-name' }, player.name), gain ? h('span', { class: 'bl-plus' }, `+${gain}`) : null, h('strong', {}, pts(t)))))),
  );
  return { el, update: () => {} };
}

export function buildMenteurScreen(lobby, ctx) {
  const m = lobby.game.menteur;
  if (m.phase === 'mt-write') return buildWrite(lobby, ctx);
  if (m.phase === 'mt-vote') return buildVote(lobby, ctx);
  return buildReveal(lobby, ctx);
}

export function renderMenteurBest(final, ctx) {
  const b = final.mt?.bestLiar;
  if (!b) return null;
  return h(
    'section',
    { class: 'card bl-best' },
    h('span', { class: 'eyebrow' }, '😈 Le plus grand menteur de la soirée'),
    h('strong', { class: 'bl-best-text' }, ctx.getPlayer(b.playerId).name),
    h('p', {}, `a trompé ${b.fooled} joueur${b.fooled > 1 ? 's' : ''}… méfiez-vous !`),
  );
}
