// Loup-Garou : réglages (composition + recommandation), table ronde, actions de nuit et de jour, chats.
// L'écran est conservé entre deux messages du serveur (on ne perd pas la saisie du chat).
import { h } from './dom.js';

export const ROLES = {
  loup: { label: 'Loup-Garou', emoji: '🐺', camp: 'loups', desc: 'Chaque nuit, avec les autres loups, tu choisis un villageois à dévorer. Le jour, fais-toi passer pour un innocent.' },
  villageois: { label: 'Simple Villageois', emoji: '🧑‍🌾', camp: 'village', desc: 'Aucun pouvoir, juste ton flair. Démasque les loups pendant le débat et vote bien !' },
  voyante: { label: 'Voyante', emoji: '🔮', camp: 'village', desc: 'Chaque nuit, tu découvres le vrai rôle d’un joueur de ton choix.' },
  sorciere: { label: 'Sorcière', emoji: '🧪', camp: 'village', desc: 'Une potion de vie (sauver la victime des loups) et une potion de mort. Une seule fois chacune.' },
  chasseur: { label: 'Chasseur', emoji: '🏹', camp: 'village', desc: 'Si tu meurs, tu tires une dernière balle sur le joueur de ton choix.' },
  cupidon: { label: 'Cupidon', emoji: '💘', camp: 'village', desc: 'La 1re nuit, tu désignes deux amoureux. Si l’un meurt, l’autre meurt de chagrin.' },
  'petite-fille': { label: 'Petite Fille', emoji: '👧', camp: 'village', desc: 'La nuit, tu espionnes le chat des loups… sans voir qui écrit.' },
  salvateur: { label: 'Salvateur', emoji: '🛡️', camp: 'village', desc: 'Chaque nuit, tu protèges un joueur des loups (pas deux fois de suite le même).' },
  ancien: { label: 'Ancien', emoji: '👴', camp: 'village', desc: 'Tu survis à la première attaque des loups.' },
  idiot: { label: 'Idiot du village', emoji: '🤪', camp: 'village', desc: 'Si le village vote contre toi, tu es épargné mais tu ne votes plus.' },
};
const ROLE_ORDER = ['loup', 'voyante', 'sorciere', 'chasseur', 'cupidon', 'petite-fille', 'salvateur', 'ancien', 'idiot'];
const CAUSE = { loups: 'dévoré par les loups', sorciere: 'empoisonné', chagrin: 'mort de chagrin 💔', vote: 'éliminé par le village', chasseur: 'abattu par le chasseur', parti: 'parti' };
const roleLine = (role, count = 1) => `${ROLES[role].emoji} ${ROLES[role].label}${count > 1 ? ` ×${count}` : ''}`;

// ---------------------------------------------------------------------------
// Réglages dans le lobby
// ---------------------------------------------------------------------------

export function renderLoupGarouSettings(lobby, host, ctx) {
  const limits = lobby.limits.loupGarou;
  if (!limits) return null;
  const settings = lobby.settings.loupGarou;
  const { roles, problem } = limits.composition;
  const set = (patch) => ctx.action('lobby:set-settings', patch);
  // Modifier un rôle : on part de la composition affichée (recommandée ou déjà personnalisée).
  const change = (role, value) => {
    const next = {};
    for (const id of ROLE_ORDER) next[id] = roles[id] ?? 0;
    next[role] = value;
    set({ lgCustom: next });
  };

  const rows = ROLE_ORDER.map((id) => {
    const count = roles[id] ?? 0;
    const control =
      id === 'loup'
        ? h(
            'div',
            { class: 'stepper' },
            h('button', { type: 'button', class: 'step', disabled: !host || count <= 1, 'aria-label': 'Un loup de moins', onClick: () => change(id, count - 1) }, '−'),
            h('span', { class: 'step-value' }, count),
            h('button', { type: 'button', class: 'step', disabled: !host, 'aria-label': 'Un loup de plus', onClick: () => change(id, count + 1) }, '+'),
          )
        : h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span'));
    return h(
      id === 'loup' ? 'div' : 'button',
      id === 'loup'
        ? { class: 'lg-role-row is-on' }
        : { type: 'button', class: `lg-role-row cat-toggle${count ? ' is-on' : ''}`, 'aria-pressed': String(Boolean(count)), disabled: !host, title: ROLES[id].desc, onClick: () => change(id, count ? 0 : 1) },
      h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, ROLES[id].emoji),
      h('span', { class: 'cat-label' }, ROLES[id].label),
      control,
    );
  });

  const recommended = limits.recommended;
  return h(
    'div',
    { class: 'quiz-settings' },
    h(
      'div',
      { class: 'lg-settings-grid' },
      h(
        'div',
        {},
        h('span', { class: 'rounds-label' }, `Composition (${limits.players} joueurs)`),
        h('div', { class: 'lg-roles' }, rows),
        h('p', { class: 'lg-villagers' }, roles.villageois ? `+ ${roleLine('villageois', roles.villageois)} (complètent automatiquement)` : 'Aucun simple villageois'),
        problem ? h('p', { class: 'hint lg-problem' }, `⚠️ ${problem}`) : null,
      ),
      h(
        'aside',
        { class: 'lg-reco' },
        h('strong', {}, `Recommandé pour ${Math.max(limits.players, limits.minPlayers)} joueurs`),
        limits.players < limits.minPlayers
          ? h('p', { class: 'hint' }, `Il faut au moins ${limits.minPlayers} joueurs.`)
          : h('ul', {}, Object.entries(recommended).map(([id, n]) => h('li', {}, roleLine(id, n)))),
        host && settings.custom ? h('button', { type: 'button', class: 'btn btn-ghost btn-small', onClick: () => set({ lgCustom: null }) }, 'Utiliser la recommandation') : null,
        !settings.custom ? h('p', { class: 'hint' }, '✓ Composition recommandée (elle s’adapte au nombre de joueurs).') : null,
      ),
    ),
    h(
      'button',
      { type: 'button', class: `cat-toggle${settings.mayor ? ' is-on' : ''}`, disabled: !host, 'aria-pressed': String(settings.mayor), onClick: () => set({ lgMayor: !settings.mayor }) },
      h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, '👑'),
      h('span', { class: 'cat-label' }, 'Élection du maire (voix double)'),
      h('span', { class: 'cat-switch', 'aria-hidden': 'true' }, h('span')),
    ),
    h('span', { class: 'rounds-label' }, 'Temps par rôle la nuit'),
    h('div', { class: 'timer-choices' }, limits.night.map((v) => h('button', { type: 'button', class: `timer-choice${v === settings.night ? ' is-active' : ''}`, disabled: !host, onClick: () => v !== settings.night && set({ lgNight: v }) }, `${v} s`))),
    h('span', { class: 'rounds-label' }, 'Temps de débat le jour'),
    h('div', { class: 'timer-choices' }, limits.debate.map((v) => h('button', { type: 'button', class: `timer-choice${v === settings.debate ? ' is-active' : ''}`, disabled: !host, onClick: () => v !== settings.debate && set({ lgDebate: v }) }, v >= 60 ? `${v / 60} min` : `${v} s`))),
  );
}

// ---------------------------------------------------------------------------
// Écran de jeu
// ---------------------------------------------------------------------------

export const loupGarouScreenKey = (lobby) => `lg:${lobby.hostId}`;

function phaseTitle(lg) {
  switch (lg.phase) {
    case 'lg-reveal':
      return '🎭 Chacun découvre son rôle…';
    case 'lg-night':
      return `🌙 Nuit ${lg.night} · ${lg.stepText}`;
    case 'lg-dawn':
      return '☀️ Le jour se lève…';
    case 'lg-mayor':
      return '👑 Élection du maire';
    case 'lg-debate':
      return `🗣️ Jour ${lg.day} · Débat`;
    case 'lg-vote':
      return `🗳️ Jour ${lg.day} · Vote du village`;
    case 'lg-verdict':
      return '⚖️ Le verdict';
    case 'lg-hunter':
      return '🏹 Le chasseur tire sa dernière balle';
    case 'lg-successor':
      return '👑 Le maire désigne son successeur';
    default:
      return '🐺 Loup-Garou';
  }
}

// Ce que le joueur peut faire maintenant (et qui il peut viser).
function currentAction(lg, me) {
  if (!me) return null;
  const alive = new Set(lg.alive);
  const others = lg.alive.filter((id) => id !== me.id);
  if (lg.phase === 'lg-night' && me.isActor) {
    if (lg.step === 'cupidon') return { type: 'cupid', count: 2, targets: lg.alive, label: 'Unir ces deux amoureux 💘' };
    if (lg.step === 'voyante' && !me.seerPicked) return { type: 'see', count: 1, targets: others, label: 'Découvrir son rôle 🔮' };
    if (lg.step === 'salvateur') return { type: 'protect', count: 1, targets: lg.alive.filter((id) => id !== me.guardLast), label: 'Protéger 🛡️', skip: 'Ne protéger personne' };
    if (lg.step === 'loups') return { type: 'wolf-vote', count: 1, targets: lg.alive.filter((id) => lg.known[id] !== 'loup'), label: 'Dévorer 🐺' };
    if (lg.step === 'sorciere') return { type: 'witch', count: me.witch.death ? 1 : 0, targets: lg.alive, label: 'Valider' };
  }
  if ((lg.phase === 'lg-vote' || lg.phase === 'lg-mayor') && me.canVote) {
    return { type: 'vote', count: 1, targets: (lg.candidates ?? []).filter((id) => alive.has(id)), label: lg.phase === 'lg-mayor' ? 'Voter pour ce maire 👑' : 'Voter contre 🗳️' };
  }
  if (lg.phase === 'lg-hunter' && lg.actors[0] === me.id) return { type: 'shoot', count: 1, targets: others, label: 'Tirer 🏹' };
  if (lg.phase === 'lg-successor' && lg.actors[0] === me.id) return { type: 'successor', count: 1, targets: others, label: 'Désigner comme maire 👑' };
  return null;
}

export function buildLoupGarouScreen(lobby, ctx) {
  const ui = { selected: [], witchSave: false, tab: null, roleOpen: false, actionKey: null };
  let current = lobby;
  const meId = ctx.me();

  const bar = h('div', { class: 'lg-bar' });
  const table = h('div', { class: 'lg-table' });
  const panel = h('section', { class: 'lg-panel card' });
  const badge = h('button', { type: 'button', class: 'lg-badge', onClick: () => { ui.roleOpen = !ui.roleOpen; refresh(); } });
  const overlay = h('div', { class: 'lg-reveal', hidden: true });
  const tabs = h('div', { class: 'lg-tabs', role: 'tablist' });
  const chatList = h('ul', { class: 'paint-chat-list lg-chat-list' });
  const chatInput = h('input', { type: 'text', class: 'paint-chat-input', maxlength: '200', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'Écris un message…' });
  const chatSend = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Envoyer');
  const chatForm = h(
    'form',
    {
      class: 'paint-chat-form',
      onSubmit: async (event) => {
        event.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;
        chatInput.value = '';
        const res = await ctx.action('lg:chat', { channel: ui.tab, text });
        if (!res.ok) chatInput.value = text;
      },
    },
    chatInput,
    chatSend,
  );
  const chat = h('section', { class: 'paint-chat card lg-chat' }, tabs, chatList, chatForm);

  // Chrono (barre grise + centre de la table)
  const clocks = [];
  const lgOffset = () => current.game.loupGarou.serverNow - Date.now();
  let offset = lgOffset();
  const tick = () => {
    if (!bar.isConnected && bar.dataset.started) return;
    bar.dataset.started = '1';
    const endsAt = current.game.loupGarou?.endsAt;
    const left = endsAt ? Math.max(0, Math.ceil((endsAt - (Date.now() + offset)) / 1000)) : null;
    for (const el of clocks) el.textContent = left === null ? '' : `${left} s`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const send = async (payload) => {
    const res = await ctx.action('lg:action', payload);
    if (res.ok) {
      ui.selected = [];
      ui.witchSave = false;
    }
    refresh();
  };

  function refresh() {
    const lg = current.game.loupGarou;
    if (!lg) return;
    offset = lgOffset();
    const me = lg.me ? { ...lg.me, id: meId } : null;
    const action = currentAction(lg, me);
    const actionKey = action ? `${lg.phase}:${lg.step}:${lg.night}:${lg.day}:${action.type}` : null;
    if (actionKey !== ui.actionKey) {
      ui.actionKey = actionKey;
      ui.selected = [];
      ui.witchSave = false;
    }
    const nightTime = lg.phase === 'lg-night' || lg.phase === 'lg-reveal';
    document.querySelector('.app')?.classList.toggle('is-night', nightTime);

    // --- Barre grise du haut ---
    const myTurn = Boolean(action);
    const clock = h('span', { class: 'lg-bar-clock' });
    clocks.length = 0;
    clocks.push(clock);
    bar.replaceChildren(...[h('span', { class: 'lg-bar-text' }, phaseTitle(lg)), myTurn ? h('span', { class: 'lg-bar-me' }, 'À toi !') : null, clock].filter(Boolean));
    bar.classList.toggle('is-my-turn', myTurn);

    // --- Table ronde ---
    const seats = lg.seats;
    const n = seats.length;
    const alive = new Set(lg.alive);
    const lovers = new Set(lg.lovers ?? []);
    const teammates = new Set(me?.teammates ?? []);
    const voteCounts = {};
    if (lg.votes) for (const [voter, target] of Object.entries(lg.votes)) voteCounts[target] = (voteCounts[target] ?? 0) + (lg.mayorId === voter && lg.phase !== 'lg-mayor' ? 2 : 1);
    const wolfCounts = {};
    if (me?.wolfVotes) for (const target of Object.values(me.wolfVotes)) wolfCounts[target] = (wolfCounts[target] ?? 0) + 1;
    const clickable = new Set(action?.targets ?? []);
    const center = h(
      'div',
      { class: 'lg-center' },
      h('span', { class: 'lg-center-icon', 'aria-hidden': 'true' }, nightTime ? '🌙' : lg.phase === 'finished' ? '🏁' : '☀️'),
      h('span', { class: 'lg-center-text' }, lg.phase === 'lg-night' ? `Nuit ${lg.night}` : lg.phase === 'lg-dawn' ? 'Aube' : lg.day ? `Jour ${lg.day}` : 'Début'),
      (() => {
        const c = h('strong', { class: 'lg-center-clock' });
        clocks.push(c);
        return c;
      })(),
    );
    table.replaceChildren(
      h('div', { class: 'lg-table-top', 'aria-hidden': 'true' }),
      center,
      ...seats.map((id, i) => {
        const angle = (-90 + (360 / n) * i) * (Math.PI / 180);
        const x = 50 + 40 * Math.cos(angle);
        const y = 50 + 40 * Math.sin(angle);
        const player = ctx.getPlayer(id);
        const role = lg.known[id];
        const dead = !alive.has(id);
        const selected = ui.selected.includes(id);
        const canClick = clickable.has(id) && !(action?.type === 'witch' && action.count === 0);
        const classes = [
          'lg-seat',
          dead ? 'is-dead' : '',
          id === meId ? 'is-me' : '',
          teammates.has(id) ? 'is-teammate' : '',
          lovers.has(id) && id !== meId ? 'is-lover' : '',
          selected ? 'is-selected' : '',
          canClick ? 'is-clickable' : '',
          lg.actors.includes(id) ? 'is-actor' : '',
          player.connected ? '' : 'is-offline',
        ].filter(Boolean).join(' ');
        const votes = voteCounts[id] ?? wolfCounts[id];
        return h(
          canClick ? 'button' : 'div',
          {
            type: canClick ? 'button' : undefined,
            class: classes,
            style: `left:${x}%;top:${y}%`,
            title: role ? ROLES[role].label : player.name,
            onClick: canClick
              ? () => {
                  if (selected) ui.selected = ui.selected.filter((s) => s !== id);
                  else ui.selected = action.count === 1 ? [id] : [...ui.selected, id].slice(-action.count);
                  refresh();
                }
              : undefined,
          },
          h('span', { class: 'lg-seat-avatar' }, ctx.avatar(player, 'md'), role ? h('span', { class: 'lg-seat-role' }, ROLES[role].emoji) : null),
          h('span', { class: 'lg-seat-name' }, player.name),
          h(
            'span',
            { class: 'lg-seat-tags' },
            lg.mayorId === id ? '👑' : null,
            lovers.has(id) ? '💘' : null,
            dead ? '💀' : null,
            lg.idiots.includes(id) ? '🤪' : null,
          ),
          votes ? h('span', { class: 'lg-seat-votes' }, votes) : null,
        );
      }),
    );

    // --- Panneau d'actions ---
    panel.replaceChildren(...renderPanel(lg, me, action, ui, ctx, send, refresh));

    // --- Badge du rôle (coin de l'écran) ---
    if (me) {
      const info = ROLES[me.role];
      badge.hidden = false;
      badge.replaceChildren(
        ...[
          h('span', { class: 'lg-badge-emoji' }, info.emoji),
          h('span', { class: 'lg-badge-text' }, h('small', {}, me.alive ? 'Ton rôle' : 'Tu étais'), h('strong', {}, info.label)),
          lg.lovers && !ui.roleOpen ? h('span', { class: 'lg-badge-love' }, '💘') : null,
          ui.roleOpen ? h('span', { class: 'lg-badge-desc' }, info.desc, lg.lovers ? ` 💘 Tu es amoureux de ${ctx.getPlayer(lg.lovers.find((x) => x !== meId)).name}.` : '') : null,
        ].filter(Boolean),
      );
      badge.classList.toggle('is-dead', !me.alive);
    } else badge.hidden = true;

    // --- Révélation du rôle (10 s) ---
    overlay.hidden = !(lg.phase === 'lg-reveal' && me);
    if (!overlay.hidden) {
      const info = ROLES[me.role];
      const c = h('strong', { class: 'lg-reveal-clock' });
      clocks.push(c);
      overlay.replaceChildren(
        h(
          'div',
          { class: `lg-reveal-card camp-${info.camp}` },
          h('span', { class: 'lg-reveal-title' }, 'Ton rôle'),
          h('span', { class: 'lg-reveal-emoji' }, info.emoji),
          h('strong', { class: 'lg-reveal-name' }, info.label),
          h('p', {}, info.desc),
          me.teammates.length ? h('p', { class: 'lg-reveal-team' }, `🐺 Ta meute : ${me.teammates.map((id) => ctx.getPlayer(id).name).join(', ')}`) : null,
          c,
        ),
      );
    }

    // --- Chats ---
    const channels = Object.keys(lg.chats);
    const preferred = lg.canWrite.includes('wolves') ? 'wolves' : !me?.alive && channels.includes('dead') && !lg.canWrite.includes('village') ? 'dead' : 'village';
    if (!channels.includes(ui.tab) || ui.lastPreferred !== preferred) {
      ui.tab = preferred;
      ui.lastPreferred = preferred;
    }
    const tabLabel = { village: '🏘️ Village', wolves: me?.role === 'petite-fille' && me.alive ? '👀 Loups (espion)' : '🐺 Loups', dead: '💀 Cimetière' };
    tabs.replaceChildren(
      ...channels.map((channel) =>
        h('button', { type: 'button', role: 'tab', class: `lg-tab${ui.tab === channel ? ' is-active' : ''}`, 'aria-selected': String(ui.tab === channel), onClick: () => { ui.tab = channel; refresh(); } }, tabLabel[channel]),
      ),
    );
    const messages = lg.chats[ui.tab] ?? [];
    const nearBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
    chatList.replaceChildren(
      ...messages.map((m) =>
        m.system
          ? h('li', { class: 'chat-system' }, m.text)
          : h('li', { class: ui.tab === 'wolves' ? 'chat-wolf' : ui.tab === 'dead' ? 'chat-secret' : '' }, h('strong', {}, m.from ? `${ctx.getPlayer(m.from).name} : ` : '🐺 Un loup : '), m.text),
      ),
    );
    if (nearBottom || ui.lastCount !== messages.length) chatList.scrollTop = chatList.scrollHeight;
    ui.lastCount = messages.length;
    const canWrite = lg.canWrite.includes(ui.tab);
    chatInput.disabled = !canWrite;
    chatSend.disabled = !canWrite;
    chatInput.placeholder = canWrite ? (ui.tab === 'wolves' ? 'Message secret aux loups…' : 'Écris un message…') : nightTime ? 'Chut… c’est la nuit 🌙' : 'Tu ne peux pas écrire ici';
  }

  const el = h(
    'div',
    { class: 'lg-layout' },
    bar,
    h('div', { class: 'lg-body' }, chat, h('div', { class: 'lg-main' }, table, panel)),
    badge,
    overlay,
  );
  return {
    el,
    update(next) {
      current = next;
      refresh();
    },
  };
}

function renderPanel(lg, me, action, ui, ctx, send, refresh) {
  const out = [];
  const host = ctx.isHost();
  const nameOf = (id) => ctx.getPlayer(id).name;

  // Annonce de l'aube / du verdict
  if (lg.announce && ['lg-dawn', 'lg-verdict', 'lg-hunter', 'lg-successor'].includes(lg.phase)) {
    const a = lg.announce;
    const deaths = a.deaths ?? [];
    out.push(
      h(
        'div',
        { class: 'lg-announce' },
        a.type === 'dawn' && deaths.length === 0 ? h('p', {}, '🌅 Personne n’est mort cette nuit !') : null,
        a.type === 'verdict' && !a.targetId ? h('p', {}, a.tie ? '⚖️ Égalité : personne n’est éliminé.' : '🤷 Personne n’a voté.') : null,
        a.type === 'verdict' && a.idiot ? h('p', {}, `🤪 ${nameOf(a.targetId)} est l’idiot du village : épargné !`) : null,
        deaths.map((d) => h('p', { class: 'lg-death' }, `💀 ${nameOf(d.id)} — ${ROLES[d.role].emoji} ${ROLES[d.role].label} (${CAUSE[d.cause] ?? d.cause})`)),
        a.details?.length ? h('p', { class: 'hint' }, a.details.map((v) => `${nameOf(v.voterId)} → ${nameOf(v.targetId)}`).join(' · ')) : null,
      ),
    );
  }

  if (!me) {
    out.push(h('p', { class: 'hint' }, 'Tu regardes la partie.'));
  } else if (!me.alive && lg.phase !== 'finished') {
    out.push(h('p', { class: 'lg-info' }, '💀 Tu es mort : tu vois tous les rôles. Discute au cimetière, sans spoiler les vivants !'));
  }

  // Résultats de la voyante
  if (me?.seer?.length) {
    out.push(
      h(
        'div',
        { class: 'lg-seer' },
        h('strong', {}, '🔮 Tes visions'),
        h('ul', {}, me.seer.map((s) => h('li', {}, `Nuit ${s.night} : ${nameOf(s.targetId)} est ${ROLES[s.role].emoji} ${ROLES[s.role].label}`))),
      ),
    );
  }

  if (action) {
    const chosen = ui.selected.map(nameOf);
    const ready = ui.selected.length === action.count;
    if (action.type === 'witch') {
      const victim = me.witch.victim;
      out.push(
        h(
          'div',
          { class: 'lg-action' },
          h('p', {}, victim ? `🐺 Les loups ont attaqué ${nameOf(victim)}.` : '🐺 Les loups n’ont attaqué personne.'),
          me.witch.life && victim
            ? h('button', { type: 'button', class: `cat-toggle${ui.witchSave ? ' is-on' : ''}`, onClick: () => { ui.witchSave = !ui.witchSave; refresh(); } }, h('span', { class: 'cat-emoji' }, '💚'), h('span', { class: 'cat-label' }, `Sauver ${nameOf(victim)} (potion de vie)`), h('span', { class: 'cat-switch' }, h('span')))
            : h('p', { class: 'hint' }, me.witch.life ? '' : 'Potion de vie déjà utilisée.'),
          me.witch.death ? h('p', { class: 'hint' }, chosen.length ? `☠️ Empoisonner : ${chosen[0]} (touche-le encore pour annuler)` : '☠️ Potion de mort : touche un joueur autour de la table pour l’empoisonner.') : h('p', { class: 'hint' }, 'Potion de mort déjà utilisée.'),
          h(
            'div',
            { class: 'row' },
            h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => send({ type: 'witch', save: false, kill: null }) }, 'Ne rien faire'),
            h('button', { type: 'button', class: 'btn btn-primary', disabled: !ui.witchSave && !ui.selected.length, onClick: () => send({ type: 'witch', save: ui.witchSave, kill: ui.selected[0] ?? null }) }, 'Valider'),
          ),
        ),
      );
    } else {
      const hint = {
        cupid: 'Touche deux joueurs autour de la table pour les rendre amoureux.',
        see: 'Touche le joueur dont tu veux découvrir le rôle.',
        protect: 'Touche le joueur à protéger cette nuit.',
        'wolf-vote': 'Touche votre victime. Mettez-vous d’accord dans le chat des loups !',
        vote: lg.phase === 'lg-mayor' ? 'Touche le joueur que tu veux comme maire.' : 'Touche le joueur que tu veux éliminer.',
        shoot: 'Touche le joueur sur qui tirer.',
        successor: 'Touche ton successeur.',
      }[action.type];
      out.push(
        h(
          'div',
          { class: 'lg-action' },
          h('p', {}, chosen.length ? `Choix : ${chosen.join(' + ')}` : hint),
          me.myVote && ['vote'].includes(action.type) ? h('p', { class: 'hint' }, `Ton vote actuel : ${nameOf(me.myVote)}`) : null,
          h(
            'div',
            { class: 'row' },
            action.skip ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => send({ type: 'skip' }) }, action.skip) : null,
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-primary',
                disabled: !ready,
                onClick: () => send(action.type === 'cupid' ? { type: 'cupid', targets: ui.selected } : { type: action.type, target: ui.selected[0] }),
              },
              action.label,
            ),
          ),
        ),
      );
    }
  } else if (me?.alive && lg.phase === 'lg-night') {
    out.push(h('p', { class: 'lg-info' }, me.role === 'petite-fille' && lg.step === 'loups' ? '👀 Tu entrouvres les yeux… regarde le chat des loups !' : me.role === 'voyante' && lg.step === 'voyante' && me.seerPicked ? '🔮 Vision reçue, rendors-toi…' : '😴 Tu dors… attends ton tour.'));
  } else if (me?.alive && lg.phase === 'lg-debate') {
    out.push(h('p', { class: 'lg-info' }, '🗣️ Débattez dans le chat du village. Le vote arrive à la fin du chrono.'));
  } else if (me?.alive && lg.phase === 'lg-vote' && !me.canVote) {
    out.push(h('p', { class: 'lg-info' }, me.myVote ? `🗳️ Tu as voté contre ${nameOf(me.myVote)}.` : '🤪 L’idiot du village ne vote plus.'));
  } else if (['lg-hunter', 'lg-successor'].includes(lg.phase)) {
    out.push(h('p', { class: 'lg-info' }, lg.phase === 'lg-hunter' ? `🏹 ${nameOf(lg.actors[0])} choisit sa cible…` : `👑 ${nameOf(lg.actors[0])} choisit son successeur…`));
  }

  if (lg.composition) {
    out.push(h('p', { class: 'lg-compo' }, 'En jeu : ', Object.entries(lg.composition).map(([id, n]) => `${ROLES[id].emoji}${n > 1 ? `×${n}` : ''}`).join('  ')));
  }
  if (host && lg.phase !== 'finished') {
    out.push(h('button', { type: 'button', class: 'btn btn-ghost lg-skip', onClick: () => ctx.action('game:reveal') }, 'Passer l’étape ⏭ (hôte)'));
  }
  void refresh;
  return out.filter(Boolean);
}

// Fin de partie : camp gagnant + tous les rôles dévoilés.
export function renderLoupGarouFinal(final, ctx) {
  const result = final.lg;
  if (!result) return null;
  const winners = new Set(result.winners);
  return h(
    'section',
    { class: 'card lg-final' },
    h('h2', {}, 'Les rôles'),
    h(
      'ul',
      { class: 'lg-final-list' },
      result.roles.map(({ id, role, alive }) =>
        h(
          'li',
          { class: `${winners.has(id) ? 'is-winner' : ''}${alive ? '' : ' is-dead'}` },
          ctx.avatar(ctx.getPlayer(id), 'sm'),
          h('span', { class: 'final-name' }, ctx.getPlayer(id).name, result.lovers?.includes(id) ? ' 💘' : ''),
          h('span', {}, `${ROLES[role].emoji} ${ROLES[role].label}`),
          h('span', {}, alive ? '' : '💀'),
        ),
      ),
    ),
    h('p', { class: 'hint' }, `Partie terminée en ${result.nights} nuit${result.nights > 1 ? 's' : ''}.`),
  );
}
