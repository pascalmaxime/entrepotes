/* global io */
import { h } from './dom.js';
import { VOTE_CHOICES, createMemeEditor, prepareImage, renderMeme } from './meme.js';
import { buildQuizScreen, quizScreenKey, renderQuizRecap, renderQuizSettings, renderReview } from './mculture.js';
import { buildImpostorScreen, impostorScreenKey, renderImpostorSettings } from './imposteur.js';
import { buildJustePrixScreen, justePrixScreenKey, renderJustePrixSettings } from './justeprix.js';
import { attachPaintSocket, buildPaintScreen, paintScreenKey, renderPaintSettings } from './paint.js';
import { buildLoupGarouScreen, loupGarouScreenKey, renderLoupGarouFinal, renderLoupGarouSettings } from './loupgarou.js';
import { buildCoqAneScreen, coqAneScreenKey, renderCoqAneSettings } from './coqane.js';
import { attachTicTacBoumSocket, buildTicTacBoumScreen, renderTicTacBoumFinal, renderTicTacBoumSettings, ticTacBoumScreenKey } from './tictacboum.js';

const SESSION_KEY = 'entre-potes:session'; // sessionStorage : un joueur par onglet (pratique pour tester à plusieurs)
const NAME_KEY = 'entre-potes:name';
const SEEN_VERSION_KEY = 'entre-potes:seen-version';
const TIER_COLORS = ['var(--tier-1)', 'var(--tier-2)', 'var(--tier-3)', 'var(--tier-4)', 'var(--tier-5)'];
const AVATAR_COLORS = ['#ff5ca8', '#4fd1ff', '#ffd23f', '#4ade80', '#fb923c', '#a78bfa', '#2dd4bf', '#f87171', '#60a5fa', '#f472b6'];
const MODE_ICONS = { 'qui-de-nous': '🫵', 'tier-list': '🏆', 'top-meme': '🖼️', 'm-culture': '🧠', imposteur: '🕵️', 'juste-prix': '💰', paint: '🎨', 'loup-garou': '🐺', 'tic-tac-boum': '💣', 'coq-ane': '🐓' };

const socket = io();

const state = {
  lobby: null,
  me: null,
  modes: [],
  selectedMode: 'qui-de-nous',
  version: null,
  draftRanking: [],
  editingVote: false,
  showDetails: false,
  phaseKey: null,
  entering: false,
  memeScreen: null, // écran Top Meme / M-Culture affiché, conservé entre deux messages du serveur
  memeEditing: false,
  memeDraft: null,
  memeVote: null,
  uploading: null,
  quizUi: { editing: false },
};

const $ = (selector) => document.querySelector(selector);
const els = {
  home: $('[data-screen="home"]'),
  game: $('[data-screen="game"]'),
  gameView: $('#game-view'),
  nameInput: $('#name-input'),
  codeInput: $('#code-input'),
  createBtn: $('#create-btn'),
  joinBtn: $('#join-btn'),
  modeCards: $('#mode-cards'),
  inviteBanner: $('#invite-banner'),
  banner: $('#connection-banner'),
  toasts: $('#toasts'),
  versionLabel: $('#version-label'),
  versionBtn: $('#version-info-btn'),
  versionPopover: $('#version-popover'),
  versionTitle: $('#version-title'),
  versionDate: $('#version-date'),
  versionNotes: $('#version-notes'),
};

// ---------------------------------------------------------------------------
// Petits utilitaires
// ---------------------------------------------------------------------------

function readStore(kind, key) {
  try { return window[kind].getItem(key); } catch { return null; }
}
function writeStore(kind, key, value) {
  try { window[kind].setItem(key, value); } catch { /* stockage indisponible (navigation privée…) */ }
}
function removeStore(kind, key) {
  try { window[kind].removeItem(key); } catch { /* idem */ }
}

const session = {
  load() {
    try { return JSON.parse(readStore('sessionStorage', SESSION_KEY)); } catch { return null; }
  },
  save(data) { writeStore('sessionStorage', SESSION_KEY, JSON.stringify(data)); },
  clear() { removeStore('sessionStorage', SESSION_KEY); },
};

function emit(event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (error, response) => {
      if (error) resolve({ ok: false, error: 'TIMEOUT', message: 'Le serveur ne répond pas, réessaie.' });
      else resolve(response ?? { ok: false, error: 'EMPTY', message: 'Réponse vide du serveur.' });
    });
  });
}

function toast(message, type = 'info') {
  const el = h('div', { class: `toast toast-${type}`, role: 'status' }, message);
  els.toasts.append(el);
  setTimeout(() => el.classList.add('is-leaving'), 3200);
  setTimeout(() => el.remove(), 3550);
}

const plural = (n, one, many) => `${n} ${Math.abs(n) > 1 ? many : one}`;
const isHost = () => state.lobby?.hostId === state.me;
const getPlayer = (id) =>
  state.lobby?.players.find((p) => p.id === id) ?? { id, name: 'Joueur parti', connected: false, isHost: false };
const modeInfo = (id) =>
  state.modes.find((m) => m.id === id) ?? { id, label: id, description: '', minPlayers: 2, available: true };

function tierColor(rank, total) {
  const index = Math.floor(((rank - 1) * TIER_COLORS.length) / Math.max(total, 1));
  return TIER_COLORS[Math.min(TIER_COLORS.length - 1, index)];
}

function colorFor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initials(name) {
  const parts = name.trim().split(/\s+/).map((part) => Array.from(part));
  const letters = parts.length > 1 ? [parts[0][0], parts[1][0]] : parts[0].slice(0, 2);
  return letters.join('').toUpperCase();
}

function avatar(player, size = 'md') {
  return h('span', { class: `avatar avatar-${size}`, style: `--avatar:${colorFor(player.id)}`, 'aria-hidden': 'true' }, initials(player.name));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function readName() {
  const name = els.nameInput.value.replace(/\s+/g, ' ').trim();
  if (!name) {
    toast('Choisis d’abord un pseudo 😉', 'error');
    els.nameInput.focus();
    return null;
  }
  writeStore('localStorage', NAME_KEY, name);
  return name;
}

async function withBusy(button, task) {
  button.disabled = true;
  try { await task(); } finally { button.disabled = false; }
}

function onSessionStart(response) {
  state.me = response.playerId;
  session.save({ code: response.code, playerId: response.playerId, token: response.token });
  els.inviteBanner.hidden = true;
  history.replaceState(null, '', `/?code=${response.code}`);
  render();
}

async function createLobby() {
  const name = readName();
  if (!name) return;
  await withBusy(els.createBtn, async () => {
    const res = await emit('lobby:create', { name, mode: state.selectedMode });
    if (!res.ok) return toast(res.message, 'error');
    onSessionStart(res);
  });
}

async function joinLobby() {
  const code = els.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 5) {
    toast('Le code de la partie fait 5 caractères.', 'error');
    els.codeInput.focus();
    return;
  }
  const name = readName();
  if (!name) return;
  await withBusy(els.joinBtn, async () => {
    const res = await emit('lobby:join', { code, name });
    if (!res.ok) return toast(res.message, 'error');
    onSessionStart(res);
  });
}

async function leaveLobby() {
  await emit('lobby:leave');
  session.clear();
  state.lobby = null;
  state.me = null;
  state.phaseKey = null;
  els.codeInput.value = '';
  history.replaceState(null, '', '/');
  render();
}

function confirmLeave() {
  if (state.lobby.state === 'lobby' || window.confirm('Quitter la partie en cours ?')) leaveLobby();
}

async function action(event, payload) {
  const res = await emit(event, payload);
  if (!res.ok) toast(res.message, 'error');
  return res;
}

async function submitVote(vote) {
  state.editingVote = false;
  const res = await action('game:vote', { vote });
  if (!res.ok) state.editingVote = true;
  render();
}

async function shareInvite(code) {
  const url = `${location.origin}/?code=${code}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Rejoins ma partie !', text: `Code de la partie : ${code}`, url });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Lien d’invitation copié !', 'success');
  } catch {
    toast(url);
  }
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

let enterTimer;

function render() {
  const inGame = Boolean(state.lobby && state.me);
  els.home.hidden = inGame;
  els.game.hidden = !inGame;
  if (!inGame) {
    document.querySelector('.app')?.classList.remove('is-wide', 'is-night');
    state.memeScreen = null;
    renderModeCards();
    return;
  }
  const { lobby } = state;

  // Top Meme et M-Culture : l'éditeur, le vote et la saisie ne sont PAS reconstruits à chaque
  // message du serveur (sinon on perdrait le texte en cours de saisie ou le glisser-déposer).
  // On ne met à jour que la zone d'avancement, sauf si l'écran doit vraiment changer.
  const kind = lobby.game?.kind;
  const isQuiz = kind === 'quiz';
  const isImpostor = kind === 'impostor' && lobby.state !== 'finished' && lobby.state !== 'lobby';
  let memeView;
  const isJustePrix = kind === 'juste-prix' && ['jp-question', 'jp-reveal'].includes(lobby.state);
  const isPaint = kind === 'paint' && ['paint-choose', 'paint-draw', 'paint-end'].includes(lobby.state);
  // Paint a besoin de place : chat à gauche, tableau au milieu, joueurs à droite sur grand écran.
  const isLoupGarou = kind === 'loup-garou' && lobby.state.startsWith('lg-');
  const isTicTacBoum = kind === 'tic-tac-boum' && lobby.state.startsWith('tb-');
  document.querySelector('.app')?.classList.toggle('is-wide', isPaint || isLoupGarou || isTicTacBoum);
  if (!isLoupGarou) document.querySelector('.app')?.classList.remove('is-night');
  const isCoqAne = kind === 'coq-ane' && lobby.state.startsWith('cc-');
  if (isCoqAne) memeView = (current) => buildCoqAneScreen(current, quizContext);
  else if (isTicTacBoum) memeView = (current) => buildTicTacBoumScreen(current, quizContext);
  else if (isLoupGarou) memeView = (current) => buildLoupGarouScreen(current, quizContext);
  else if (isPaint) memeView = (current) => buildPaintScreen(current, quizContext);
  else if (isJustePrix) memeView = (current) => buildJustePrixScreen(current, quizContext, state.quizUi);
  else if (isImpostor) memeView = (current) => buildImpostorScreen(current, quizContext);
  else if (isQuiz) memeView = { quiz: (current) => buildQuizScreen(current, quizContext, state.quizUi) }[lobby.state];
  else memeView = { create: buildMemeCreate, vote: buildMemeVote }[lobby.state];
  if (memeView) {
    const key = isCoqAne ? coqAneScreenKey(lobby) : isTicTacBoum ? ticTacBoumScreenKey(lobby) : isLoupGarou ? loupGarouScreenKey(lobby) : isPaint ? paintScreenKey(lobby) : isJustePrix ? justePrixScreenKey(lobby, state.quizUi) : isImpostor ? impostorScreenKey(lobby) : isQuiz ? quizScreenKey(lobby, state.quizUi) : memeScreenKey(lobby);
    if (state.memeScreen?.key !== key || !els.gameView.contains(state.memeScreen.el)) {
      const screen = memeView(lobby);
      state.memeScreen = { key, ...screen };
      els.gameView.replaceChildren(renderTopBar(), screen.el);
      playEntering();
    }
    state.memeScreen.update(lobby);
    return;
  }
  state.memeScreen = null;

  const isMeme = lobby.game?.kind === 'meme';
  const views = {
    lobby: renderLobby,
    question: renderQuestion,
    results: isMeme ? renderMemeResults : renderResults,
    review: (current) => renderReview(current, quizContext),
    finished: renderFinal,
  };
  const view = views[lobby.state] ?? renderLobby;
  els.gameView.replaceChildren(renderTopBar(), view(lobby));
  playEntering();
}

// Les animations d'arrivée ne se jouent qu'au changement d'écran, pas à chaque vote reçu.
function playEntering() {
  if (!state.entering) return;
  state.entering = false;
  els.gameView.classList.add('is-entering');
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => els.gameView.classList.remove('is-entering'), 1600);
}

function renderModeCards() {
  els.modeCards.replaceChildren(
    ...state.modes.map((mode) => {
      const selected = mode.id === state.selectedMode;
      return h(
        'button',
        {
          type: 'button',
          class: `mode-card${selected ? ' is-selected' : ''}${mode.available ? '' : ' is-locked'}`,
          'aria-pressed': String(selected),
          disabled: !mode.available,
          onClick: () => {
            state.selectedMode = mode.id;
            renderModeCards();
          },
        },
        h('span', { class: 'mode-icon', 'aria-hidden': 'true' }, MODE_ICONS[mode.id] ?? '🎲'),
        h(
          'span',
          { class: 'mode-body' },
          h('span', { class: 'mode-title' }, mode.label, mode.available ? null : h('span', { class: 'soon' }, 'Bientôt')),
          h('span', { class: 'mode-desc' }, mode.description),
          h('span', { class: 'mode-meta' }, `${mode.minPlayers} joueurs minimum`),
        ),
      );
    }),
  );
}

function renderTopBar() {
  const { lobby } = state;
  const mode = modeInfo(lobby.game?.modeId ?? lobby.mode);
  const inProgress = lobby.game && lobby.state !== 'finished';
  return h(
    'div',
    { class: 'topbar' },
    h('button', { type: 'button', class: 'chip chip-code', title: 'Partager le lien', onClick: () => shareInvite(lobby.code) }, lobby.code),
    // Pendant la partie : juste l'icône du mode, pour que la barre tienne sur une ligne.
    h('span', { class: 'chip', title: mode.label }, inProgress ? (MODE_ICONS[mode.id] ?? mode.label) : `${MODE_ICONS[mode.id] ?? ''} ${mode.label}`),
    inProgress && lobby.state !== 'review' && !['loup-garou', 'tic-tac-boum', 'coq-ane'].includes(lobby.game.kind)
      ? h('span', { class: 'chip', title: ['meme', 'impostor', 'paint'].includes(lobby.game.kind) ? 'Manche en cours' : 'Question en cours' }, `${['meme', 'impostor', 'paint'].includes(lobby.game.kind) ? 'M' : 'Q'}${lobby.game.round}/${lobby.game.totalRounds}`)
      : null,
    lobby.state === 'review' ? h('span', { class: 'chip' }, '✏️ Correction') : null,
    h('button', { type: 'button', class: 'chip chip-leave', onClick: confirmLeave }, 'Quitter'),
  );
}

function renderWaiting(text) {
  return h('p', { class: 'waiting' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

// ----- Lobby -----

function renderLobby(lobby) {
  const host = isHost();
  const mode = modeInfo(lobby.mode);
  const connected = lobby.players.filter((p) => p.connected).length;
  const missing = Math.max(0, mode.minPlayers - connected);
  const isMeme = lobby.mode === 'top-meme';
  const needsImages = isMeme && (lobby.library?.count ?? 0) === 0;
  let startHint = null;
  if (missing > 0) startHint = `Encore ${plural(missing, 'joueur', 'joueurs')} pour lancer ${mode.label}.`;
  else if (needsImages) startHint = 'Ajoutez au moins une image à la bibliothèque pour lancer Top Meme.';

  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card card-code' },
      h('span', { class: 'eyebrow' }, 'Code de la partie'),
      h('div', { class: 'code-big', 'aria-label': `Code ${lobby.code.split('').join(' ')}` }, lobby.code.split('').map((c) => h('span', {}, c))),
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => shareInvite(lobby.code) }, '🔗 Inviter des potes'),
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Joueurs'), h('span', { class: 'count' }, `${lobby.players.length}/${lobby.limits.maxPlayers}`)),
      h('ul', { class: 'player-list' }, lobby.players.map(renderPlayerRow)),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Réglages'),
      host
        ? renderModePicker(lobby)
        : h('p', { class: 'mode-readonly' }, h('strong', {}, `${MODE_ICONS[mode.id] ?? ''} ${mode.label}`), h('br'), mode.description),
      lobby.mode === 'm-culture' ? renderQuizSettings(lobby, host, quizContext) : lobby.mode === 'paint' ? renderPaintSettings(lobby, host, quizContext) : lobby.mode === 'loup-garou' ? renderLoupGarouSettings(lobby, host, quizContext) : lobby.mode === 'tic-tac-boum' ? renderTicTacBoumSettings(lobby, host, quizContext) : lobby.mode === 'coq-ane' ? renderCoqAneSettings(lobby, host, quizContext) : renderRounds(lobby, host),
      lobby.mode === 'imposteur' ? renderImpostorSettings(lobby, host, quizContext) : null,
      lobby.mode === 'juste-prix' ? renderJustePrixSettings(lobby, host, quizContext) : null,
    ),
    isMeme ? renderLibraryCard(lobby) : null,
    host
      ? h(
          'div',
          { class: 'cta' },
          h('button', { type: 'button', class: 'btn btn-primary btn-big', disabled: Boolean(startHint), onClick: () => action('game:start') }, 'Lancer la partie 🚀'),
          startHint ? h('p', { class: 'hint' }, startHint) : null,
        )
      : renderWaiting('En attente du lancement par l’hôte…'),
  );
}

function renderPlayerRow(player) {
  return h(
    'li',
    { class: `player-row${player.connected ? '' : ' is-offline'}` },
    avatar(player),
    h('span', { class: 'player-name' }, player.name, player.id === state.me ? h('span', { class: 'you' }, ' (toi)') : null),
    player.isHost ? h('span', { class: 'badge badge-host' }, '👑 Hôte') : null,
    player.connected ? null : h('span', { class: 'badge badge-offline' }, 'Hors ligne'),
  );
}

function renderModePicker(lobby) {
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Mode de jeu' },
      state.modes.map((mode) =>
        h(
          'button',
          {
            type: 'button',
            class: `segment${mode.id === lobby.mode ? ' is-active' : ''}`,
            disabled: !mode.available,
            'aria-pressed': String(mode.id === lobby.mode),
            onClick: () => mode.id !== lobby.mode && action('lobby:set-mode', { mode: mode.id }),
          },
          `${MODE_ICONS[mode.id] ?? ''} ${mode.label}${mode.available ? '' : ' (bientôt)'}`,
        ),
      ),
    ),
    h('p', { class: 'hint' }, modeInfo(lobby.mode).description),
  );
}

function renderRounds(lobby, host) {
  const { rounds } = lobby.settings;
  const { min, max } = lobby.limits.rounds;
  const set = (value) => action('lobby:set-settings', { rounds: value });
  return h(
    'div',
    { class: 'rounds' },
    h('span', { class: 'rounds-label' }, ['top-meme', 'imposteur'].includes(lobby.mode) ? 'Nombre de manches' : 'Nombre de questions'),
    host
      ? h(
          'div',
          { class: 'stepper' },
          h('button', { type: 'button', class: 'step', 'aria-label': 'Moins de questions', disabled: rounds <= min, onClick: () => set(rounds - 1) }, '−'),
          h('span', { class: 'step-value', 'aria-live': 'polite' }, rounds),
          h('button', { type: 'button', class: 'step', 'aria-label': 'Plus de questions', disabled: rounds >= max, onClick: () => set(rounds + 1) }, '+'),
        )
      : h('strong', {}, rounds),
  );
}

// ----- Question -----

function renderQuestion(lobby) {
  const { game } = lobby;
  const voted = game.votedIds.includes(state.me);
  const isTier = game.modeId === 'tier-list';
  let voteArea = renderVoted();
  if (!voted || state.editingVote) voteArea = isTier ? renderTierVote(lobby) : renderSingleVote(lobby);

  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'question-card' },
      h('span', { class: 'eyebrow' }, `Question ${game.round} sur ${game.totalRounds}`),
      h('h1', { class: 'question' }, game.question),
      h('p', { class: 'question-hint' }, isTier ? 'Classe tout le monde, du Top 1 au dernier.' : 'Désigne la personne qui correspond le mieux.'),
    ),
    voteArea,
    renderVoteProgress(lobby),
    isHost()
      ? h('button', { type: 'button', class: 'btn btn-ghost', disabled: game.votedIds.length === 0, onClick: () => action('game:reveal') }, 'Révéler les résultats maintenant')
      : null,
  );
}

function renderSingleVote(lobby) {
  return h(
    'section',
    { class: 'vote-grid' },
    lobby.players.map((player) =>
      h(
        'button',
        { type: 'button', class: 'vote-tile', onClick: () => submitVote(player.id) },
        avatar(player, 'lg'),
        h('span', { class: 'vote-name' }, player.name),
        player.id === state.me ? h('span', { class: 'you' }, 'toi') : null,
      ),
    ),
  );
}

function renderTierVote(lobby) {
  const ids = lobby.players.map((p) => p.id);
  state.draftRanking = state.draftRanking.filter((id) => ids.includes(id));
  const ranked = state.draftRanking;
  const remaining = lobby.players.filter((p) => !ranked.includes(p.id));
  const update = (next) => {
    state.draftRanking = next;
    render();
  };

  return h(
    'section',
    { class: 'card' },
    h(
      'ol',
      { class: 'tier-slots' },
      ids.map((_, index) => {
        const playerId = ranked[index];
        const player = playerId ? getPlayer(playerId) : null;
        return h(
          'li',
          { class: 'tier-slot' },
          h('span', { class: 'tier-label', style: `--tier:${tierColor(index + 1, ids.length)}` }, `TOP ${index + 1}`),
          player
            ? h(
                'button',
                { type: 'button', class: 'tier-chip', title: 'Retirer de ce rang', onClick: () => update(ranked.filter((id) => id !== playerId)) },
                avatar(player, 'sm'),
                h('span', {}, player.name),
                h('span', { class: 'remove', 'aria-hidden': 'true' }, '×'),
              )
            : h('span', { class: 'tier-empty' }, index === ranked.length ? 'Touche un joueur ci-dessous ↓' : '—'),
        );
      }),
    ),
    remaining.length
      ? h(
          'div',
          { class: 'tier-pool' },
          remaining.map((player) =>
            h('button', { type: 'button', class: 'pool-chip', onClick: () => update([...ranked, player.id]) }, avatar(player, 'sm'), h('span', {}, player.name)),
          ),
        )
      : null,
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-ghost', disabled: ranked.length === 0, onClick: () => update([]) }, 'Recommencer'),
      h('button', { type: 'button', class: 'btn btn-primary', disabled: ranked.length !== ids.length, onClick: () => submitVote([...ranked]) }, 'Valider'),
    ),
  );
}

function renderVoted() {
  return h(
    'section',
    { class: 'card voted' },
    h('div', { class: 'voted-check', 'aria-hidden': 'true' }, '✓'),
    h('p', {}, 'Vote enregistré ! On attend les autres…'),
    h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { state.editingVote = true; render(); } }, 'Modifier mon vote'),
  );
}

function renderVoteProgress(lobby) {
  const voted = new Set(lobby.game.votedIds);
  const connected = lobby.players.filter((p) => p.connected);
  const done = connected.filter((p) => voted.has(p.id)).length;
  const percent = connected.length ? (done / connected.length) * 100 : 0;
  return h(
    'section',
    { class: 'progress', 'aria-label': 'Avancement des votes' },
    h('div', { class: 'progress-head' }, h('span', {}, 'Votes'), h('strong', {}, `${done}/${connected.length}`)),
    h('div', { class: 'progress-bar' }, h('span', { style: `width:${percent}%` })),
    h(
      'ul',
      { class: 'progress-players' },
      lobby.players.map((p) =>
        h(
          'li',
          { class: `${voted.has(p.id) ? 'has-voted' : ''}${p.connected ? '' : ' is-offline'}`, title: `${p.name}${voted.has(p.id) ? ' a voté' : ''}` },
          avatar(p, 'sm'),
          voted.has(p.id) ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓') : null,
        ),
      ),
    ),
  );
}

// ----- Résultats -----

function renderResults(lobby) {
  const { game } = lobby;
  const last = game.round >= game.totalRounds;
  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'question-card is-compact' },
      h('span', { class: 'eyebrow' }, `Résultats · question ${game.round}/${game.totalRounds}`),
      h('h1', { class: 'question' }, game.question),
    ),
    game.result.type === 'tier-list' ? renderTierResult(game.result) : renderSingleResult(game.result),
    isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => action('game:next') }, last ? 'Voir le classement final 🏁' : 'Question suivante →')
      : renderWaiting('L’hôte va lancer la suite…'),
  );
}

function renderSingleResult(result) {
  const max = Math.max(1, ...result.ranking.map((e) => e.votes));
  const winners = result.winners.map(getPlayer);
  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card winner-card' },
      winners.length === 0
        ? h('p', {}, 'Personne n’a été désigné…')
        : [
            h('span', { class: 'eyebrow' }, winners.length > 1 ? 'Égalité entre…' : 'Et c’est…'),
            h('div', { class: 'winners' }, winners.map((p) => h('div', { class: 'winner' }, avatar(p, 'xl'), h('strong', {}, p.name)))),
            h('p', { class: 'winner-score' }, plural(result.ranking[0].votes, 'vote', 'votes')),
          ],
    ),
    h(
      'section',
      { class: 'card' },
      h(
        'ul',
        { class: 'bars' },
        result.ranking.map((entry) => {
          const p = getPlayer(entry.playerId);
          return h(
            'li',
            { class: 'bar-row' },
            avatar(p, 'sm'),
            h('span', { class: 'bar-name' }, p.name),
            h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${(entry.votes / max) * 100}%` })),
            h('strong', { class: 'bar-count' }, entry.votes),
          );
        }),
      ),
      result.details.length
        ? h('button', { type: 'button', class: 'link-btn', onClick: () => { state.showDetails = !state.showDetails; render(); } }, state.showDetails ? 'Masquer les votes' : 'Voir qui a voté pour qui 👀')
        : null,
      state.showDetails
        ? h('ul', { class: 'details' }, result.details.map(({ voterId, targetId }) => h('li', {}, h('strong', {}, getPlayer(voterId).name), ' → ', getPlayer(targetId).name)))
        : null,
    ),
  );
}

function renderTierResult(result) {
  const total = result.ranking.length;
  return h('div', { class: 'stack' }, renderTierBoard(result, total), renderTierDetails(result, total));
}

// Le classement de chaque joueur : « Maxime a mis Top 1 Clément, Top 2 Victor… »
function renderTierDetails(result, total) {
  const details = result.details ?? [];
  if (!details.length) return null;
  return h(
    'section',
    { class: 'card' },
    h(
      'button',
      { type: 'button', class: 'link-btn link-btn-top', onClick: () => { state.showDetails = !state.showDetails; render(); } },
      state.showDetails ? 'Masquer les classements' : 'Voir le classement de chacun 👀',
    ),
    state.showDetails
      ? h(
          'div',
          { class: 'voter-rankings' },
          details.map(({ voterId, ranking }) => {
            const voter = getPlayer(voterId);
            return h(
              'div',
              { class: 'voter-ranking' },
              h('div', { class: 'voter-head' }, avatar(voter, 'sm'), h('strong', {}, voter.id === state.me ? 'Ton classement' : `Le classement de ${voter.name}`)),
              h(
                'ol',
                { class: 'voter-list' },
                ranking.map((playerId, index) => {
                  const p = getPlayer(playerId);
                  return h(
                    'li',
                    { class: playerId === voterId ? 'is-self' : '' },
                    h('span', { class: 'voter-rank', style: `--tier:${tierColor(index + 1, total)}` }, `TOP ${index + 1}`),
                    avatar(p, 'sm'),
                    h('span', { class: 'voter-name' }, p.name, playerId === voterId ? h('span', { class: 'you' }, ' (lui-même)') : null),
                  );
                }),
              ),
            );
          }),
        )
      : null,
  );
}

function renderTierBoard(result, total) {
  return h(
    'section',
    { class: 'tier-board' },
    result.ranking.map((entry, index) => {
      const p = getPlayer(entry.playerId);
      // --i inversé : le dernier apparaît en premier, le Top 1 en dernier (suspense).
      return h(
        'div',
        { class: 'tier-row', style: `--tier:${tierColor(entry.rank, total)};--i:${total - 1 - index}` },
        h('span', { class: 'tier-rank' }, `TOP ${entry.rank}`),
        h('span', { class: 'tier-player' }, avatar(p), h('strong', {}, p.name)),
        h(
          'span',
          { class: 'tier-stats' },
          h('strong', {}, `${entry.points} pts`),
          entry.averagePosition ? h('small', {}, `place moy. ${String(entry.averagePosition).replace('.', ',')}`) : null,
        ),
      );
    }),
  );
}

// ----- Fin de partie -----

function renderFinal(lobby) {
  const { final } = lobby.game;
  const isTier = final.type === 'tier-list';
  const isMeme = final.type === 'top-meme';
  const isQuiz = final.type === 'm-culture';
  const isImpostor = final.type === 'imposteur';
  const isJustePrix = final.type === 'juste-prix';
  const isPaint = final.type === 'paint';
  const isCoqAne = final.type === 'coq-ane';
  const unit = (n) => (isTier || isMeme || isQuiz || isImpostor || isJustePrix || isPaint || isCoqAne ? plural(n, 'pt', 'pts') : plural(n, 'vote', 'votes'));
  const [first, second, third] = final.ranking;
  const podium = [[second, 2], [first, 1], [third, 3]].filter(([entry]) => entry);
  if (final.type === 'loup-garou' && final.lg) return renderLoupGarouEnd(final);
  if (final.type === 'tic-tac-boum' && final.tb) return renderTicTacBoumEnd(final);

  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'question-card is-compact' },
      h('span', { class: 'eyebrow' }, 'Fin de la partie'),
      h('h1', { class: 'question' }, isCoqAne ? 'Les artistes de la soirée' : isPaint ? 'Les Picasso de la soirée' : isJustePrix ? 'Les rois de l’estimation' : isImpostor ? 'Les meilleurs menteurs' : isQuiz ? 'Les cerveaux de la soirée' : isMeme ? 'Les rois du meme' : isTier ? 'Classement général' : 'Les plus désignés de la partie'),
    ),
    h(
      'section',
      { class: 'podium' },
      podium.map(([entry, position]) => {
        const p = getPlayer(entry.playerId);
        return h(
          'div',
          { class: `podium-step pos-${position}` },
          avatar(p, 'lg'),
          h('strong', {}, p.name),
          h('span', { class: 'podium-points' }, unit(entry.total)),
          h('div', { class: 'podium-block' }, entry.rank),
        );
      }),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Classement complet'),
      h(
        'ol',
        { class: 'final-list' },
        final.ranking.map((entry) => {
          const p = getPlayer(entry.playerId);
          return h('li', {}, h('span', { class: 'final-rank' }, `#${entry.rank}`), avatar(p, 'sm'), h('span', { class: 'final-name' }, p.name), h('strong', {}, unit(entry.total)));
        }),
      ),
    ),
    isMeme
      ? renderMemeRecap(final)
      : isQuiz || isJustePrix || isPaint || isCoqAne
      ? renderQuizRecap(final, quizContext)
      : final.recap.length
      ? h(
          'section',
          { class: 'card' },
          h('h2', {}, isImpostor ? 'Récap des manches' : 'Récap des questions'),
          h(
            'ul',
            { class: 'recap' },
            final.recap.map((item) =>
              h(
                'li',
                {},
                h('span', { class: 'recap-q' }, item.question),
                h('span', { class: 'recap-a' }, item.topPlayerIds.length ? item.topPlayerIds.map((id) => getPlayer(id).name).join(', ') : '—'),
              ),
            ),
          ),
        )
      : null,
    isHost()
      ? h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => action('game:back-to-lobby') }, 'Retour au lobby'),
          h('button', { type: 'button', class: 'btn btn-primary', onClick: () => action('game:start') }, 'Rejouer 🔁'),
        )
      : renderWaiting('L’hôte choisit la suite…'),
  );
}

// ---------------------------------------------------------------------------
// Top Meme
// ---------------------------------------------------------------------------

// Clé qui décide quand reconstruire l'écran (nouvelle image, meme envoyé, meme suivant…).
function memeScreenKey(lobby) {
  const { game, you } = lobby;
  if (lobby.state === 'create') {
    return `create:${game.round}:${you?.assignment?.templateId}:${Boolean(you?.submission)}:${state.memeEditing}`;
  }
  return `vote:${game.round}:${Boolean(you?.voted)}:${state.memeVote?.index ?? 0}`;
}

function renderLibraryCard(lobby) {
  const count = lobby.library?.count ?? 0;
  const input = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    hidden: true,
    onChange: (event) => uploadFiles([...event.target.files]),
  });
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Bibliothèque d’images'), h('span', { class: 'count' }, plural(count, 'image', 'images'))),
    h(
      'p',
      { class: 'hint hint-left' },
      'Ajoute des photos, captures ou templates : à chaque manche, chacun en reçoit une au hasard à transformer en meme. La bibliothèque est partagée entre toutes les parties.',
    ),
    h(
      'button',
      { type: 'button', class: 'btn btn-ghost btn-block', disabled: Boolean(state.uploading), onClick: () => input.click() },
      state.uploading ? `Envoi en cours… ${state.uploading}` : '📤 Ajouter des images',
    ),
    input,
  );
}

async function uploadFiles(files) {
  const saved = session.load();
  if (!files.length || !saved) return;
  const summary = { added: 0, duplicates: 0, errors: [] };
  for (const [index, file] of files.entries()) {
    state.uploading = `${index + 1}/${files.length}`;
    render();
    try {
      const blob = await prepareImage(file);
      const res = await fetch('/api/memes', {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Lobby-Code': saved.code,
          'X-Player-Id': saved.playerId,
          'X-Player-Token': saved.token,
        },
        body: blob,
      });
      const data = await res.json().catch(() => ({ ok: false, message: `erreur ${res.status}` }));
      if (!data.ok) throw new Error(data.message);
      if (data.duplicate) summary.duplicates += 1;
      else summary.added += 1;
    } catch (error) {
      summary.errors.push(`${file.name} : ${error.message}`);
    }
  }
  state.uploading = null;
  render();
  const parts = [];
  if (summary.added) parts.push(plural(summary.added, 'image ajoutée', 'images ajoutées'));
  if (summary.duplicates) parts.push(plural(summary.duplicates, 'image déjà présente', 'images déjà présentes'));
  if (parts.length) toast(parts.join(' · '), 'success');
  summary.errors.slice(0, 3).forEach((message) => toast(message, 'error'));
}

function renderProgress(label, players, doneIds) {
  const done = new Set(doneIds);
  const connected = players.filter((p) => p.connected);
  const count = connected.filter((p) => done.has(p.id)).length;
  const percent = connected.length ? (count / connected.length) * 100 : 0;
  return h(
    'section',
    { class: 'progress', 'aria-label': label },
    h('div', { class: 'progress-head' }, h('span', {}, label), h('strong', {}, `${count}/${connected.length}`)),
    h('div', { class: 'progress-bar' }, h('span', { style: `width:${percent}%` })),
    h(
      'ul',
      { class: 'progress-players' },
      players.map((p) =>
        h(
          'li',
          { class: `${done.has(p.id) ? 'has-voted' : ''}${p.connected ? '' : ' is-offline'}`, title: p.name },
          avatar(p, 'sm'),
          done.has(p.id) ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓') : null,
        ),
      ),
    ),
  );
}

function memeHeader(lobby, title, hint) {
  const { game } = lobby;
  return h(
    'section',
    { class: 'question-card is-compact' },
    h('span', { class: 'eyebrow' }, `Manche ${game.round} sur ${game.totalRounds}`),
    h('h1', { class: 'question' }, title),
    hint ? h('p', { class: 'question-hint' }, hint) : null,
  );
}

// ----- Création du meme -----

function buildMemeCreate(lobby) {
  const { you } = lobby;
  const status = h('div', { class: 'stack' });
  const update = (current) => {
    status.replaceChildren(
      ...[
      renderProgress('Memes envoyés', current.players, current.game.submittedIds),
      isHost()
        ? h('button', { type: 'button', class: 'btn btn-ghost', disabled: current.game.submittedIds.length === 0, onClick: () => action('game:reveal') }, 'Passer au vote maintenant')
        : null,
      ].filter(Boolean),
    );
  };
  const assignment = you?.assignment;

  if (!assignment) {
    return { el: h('div', { class: 'stack' }, memeHeader(lobby, 'Manche en cours'), renderWaiting('Tu joueras à la prochaine manche…'), status), update };
  }

  if (you.submission && !state.memeEditing) {
    const el = h(
      'div',
      { class: 'stack' },
      memeHeader(lobby, 'Meme envoyé !'),
      h(
        'section',
        { class: 'card voted' },
        h('div', { class: 'voted-check', 'aria-hidden': 'true' }, '✓'),
        h('p', {}, 'On attend les autres…'),
        renderMeme(assignment.templateId, you.submission, { className: 'meme-preview' }),
        h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { state.memeEditing = true; state.memeDraft = you.submission; render(); } }, 'Modifier mon meme'),
      ),
      status,
    );
    return { el, update };
  }

  const draft = state.memeDraft ?? [
    { text: '', x: 0.5, y: 0.03, size: 0.08, color: '#ffffff' },
    { text: '', x: 0.5, y: 0.97, size: 0.08, color: '#ffffff' },
  ];
  state.memeDraft = null;
  const editor = createMemeEditor({
    templateId: assignment.templateId,
    items: draft,
    onLimit: () => toast('10 éléments maximum par meme.', 'error'),
  });

  const reroll = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost',
      disabled: assignment.rerollsLeft <= 0,
      onClick: async () => {
        state.memeDraft = editor.getItems({ includeEmpty: true }); // on garde les textes sur la nouvelle image
        const res = await action('meme:reroll');
        if (!res.ok) state.memeDraft = null;
      },
    },
    `🔀 Autre image (${assignment.rerollsLeft})`,
  );
  const submit = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary',
      onClick: async () => {
        const items = editor.getItems();
        if (!items.length) {
          toast('Ajoute au moins un texte ou un emoji.', 'error');
          return;
        }
        const res = await action('meme:submit', { items });
        if (res.ok) {
          state.memeEditing = false;
          render();
        }
      },
    },
    'Envoyer mon meme',
  );

  const el = h(
    'div',
    { class: 'stack' },
    memeHeader(lobby, 'Fais ton meme !', 'Touche un texte pour l’écrire, glisse-le pour le placer.'),
    editor.el,
    h('div', { class: 'row' }, reroll, submit),
    status,
  );
  return { el, update };
}

// ----- Vote : un meme à la fois, pouce en l'air / bof / pouce en bas -----

function buildMemeVote(lobby) {
  const { game, you } = lobby;
  const status = h('div', { class: 'stack' });
  const update = (current) => {
    status.replaceChildren(
      ...[
      renderProgress('Votes', current.players, current.game.votedIds),
      isHost()
        ? h('button', { type: 'button', class: 'btn btn-ghost', disabled: current.game.votedIds.length === 0, onClick: () => action('game:reveal') }, 'Révéler les résultats maintenant')
        : null,
      ].filter(Boolean),
    );
  };
  const toRate = game.memes.filter((meme) => meme.id !== you?.memeId);

  if (you?.voted || toRate.length === 0) {
    const message = you?.voted ? 'Votes envoyés ! On attend les autres…' : 'Aucun meme à noter pour toi cette manche.';
    const el = h(
      'div',
      { class: 'stack' },
      memeHeader(lobby, 'Place aux votes'),
      h('section', { class: 'card voted' }, h('div', { class: 'voted-check', 'aria-hidden': 'true' }, '✓'), h('p', {}, message)),
      status,
    );
    return { el, update };
  }

  if (!state.memeVote || state.memeVote.round !== game.round) state.memeVote = { round: game.round, index: 0, votes: {} };
  const draft = state.memeVote;
  draft.index = Math.min(draft.index, toRate.length - 1);
  const meme = toRate[draft.index];

  const choose = async (value) => {
    draft.votes[meme.id] = value;
    if (draft.index < toRate.length - 1) {
      draft.index += 1;
      render();
      return;
    }
    const votes = Object.fromEntries(toRate.map((m) => [m.id, draft.votes[m.id]]));
    await action('meme:votes', { votes });
  };

  const el = h(
    'div',
    { class: 'stack' },
    memeHeader(lobby, 'Note les memes', 'Les auteurs restent secrets jusqu’aux résultats.'),
    h('p', { class: 'meme-counter' }, `Meme ${draft.index + 1} sur ${toRate.length}`),
    renderMeme(meme.templateId, meme.items, { className: 'meme-vote' }),
    h(
      'div',
      { class: 'vote-choices' },
      VOTE_CHOICES.map((choice) =>
        h(
          'button',
          { type: 'button', class: `vote-choice choice-${choice.key}${draft.votes[meme.id] === choice.value ? ' is-picked' : ''}`, onClick: () => choose(choice.value) },
          h('span', { class: 'choice-emoji', 'aria-hidden': 'true' }, choice.emoji),
          choice.label,
        ),
      ),
    ),
    draft.index > 0 ? h('button', { type: 'button', class: 'link-btn', onClick: () => { draft.index -= 1; render(); } }, '← Meme précédent') : null,
    status,
  );
  return { el, update };
}

// ----- Résultats d'une manche -----

function renderMemeResults(lobby) {
  const { game } = lobby;
  const { memes } = game.result;
  const last = game.round >= game.totalRounds;
  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'question-card is-compact' },
      h('span', { class: 'eyebrow' }, `Résultats · manche ${game.round}/${game.totalRounds}`),
      h('h1', { class: 'question' }, memes.length ? 'Le meme de la manche' : 'Aucun meme cette manche'),
    ),
    memes.map((meme, index) => renderMemeResultCard(meme, index)),
    isHost()
      ? h('button', { type: 'button', class: 'btn btn-primary btn-big', onClick: () => action('game:next') }, last ? 'Voir le classement final 🏁' : 'Manche suivante →')
      : renderWaiting('L’hôte va lancer la suite…'),
  );
}

function renderMemeResultCard(meme, index) {
  const author = getPlayer(meme.authorId);
  return h(
    'section',
    { class: `card meme-result${meme.rank === 1 ? ' is-best' : ''}`, style: `--i:${index}` },
    h(
      'div',
      { class: 'meme-result-head' },
      h('span', { class: 'meme-rank' }, meme.rank === 1 ? '👑' : `#${meme.rank}`),
      avatar(author, 'sm'),
      h('strong', {}, author.name),
      h('span', { class: 'meme-score' }, plural(meme.score, 'pt', 'pts')),
    ),
    renderMeme(meme.templateId, meme.items),
    h(
      'div',
      { class: 'meme-tally' },
      h('span', { title: 'Top' }, `👍 ${meme.up}`),
      h('span', { title: 'Bof' }, `😐 ${meme.neutral}`),
      h('span', { title: 'Flop' }, `👎 ${meme.down}`),
    ),
  );
}

// ----- Fin de partie : les meilleurs memes de chaque manche -----

function renderMemeRecap(final) {
  const rounds = final.recap.filter((round) => round.best);
  if (!rounds.length) return null;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Les meilleurs memes'),
    h(
      'div',
      { class: 'meme-recap' },
      rounds.map((round) =>
        h(
          'figure',
          { class: 'meme-recap-item' },
          renderMeme(round.best.templateId, round.best.items),
          h('figcaption', {}, `Manche ${round.round} · ${getPlayer(round.best.authorId).name}`),
        ),
      ),
    ),
  );
}


// ---------------------------------------------------------------------------
// Footer : version + nouveautés (lues dans version.json)
// ---------------------------------------------------------------------------

function formatDate(iso) {
  const date = new Date(`${iso}T12:00:00`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function loadVersion() {
  try {
    const info = await (await fetch('/api/version', { cache: 'no-store' })).json();
    state.version = info.version;
    els.versionLabel.textContent = `v${info.version}${info.name ? ` · ${info.name}` : ''}`;
    els.versionTitle.textContent = `Nouveautés de la v${info.version}`;
    els.versionDate.textContent = info.date ? `Publiée le ${formatDate(info.date)}` : '';
    els.versionDate.hidden = !info.date;
    els.versionNotes.replaceChildren(
      ...(info.notes.length ? info.notes.map((note) => h('li', {}, note)) : [h('li', {}, 'Pas de nouveautés listées pour cette version.')]),
    );
    // Petit signal animé tant que le joueur n'a pas lu les nouveautés de cette version.
    if (info.notes.length && readStore('localStorage', SEEN_VERSION_KEY) !== info.version) {
      els.versionBtn.classList.add('has-news');
    }
  } catch {
    els.versionLabel.textContent = 'v?';
  }
}

function toggleVersion(force) {
  const open = force ?? els.versionPopover.hidden;
  els.versionPopover.hidden = !open;
  els.versionBtn.setAttribute('aria-expanded', String(open));
  if (open && state.version) {
    els.versionBtn.classList.remove('has-news');
    writeStore('localStorage', SEEN_VERSION_KEY, state.version);
  }
}

// Fin d'une partie de Tic Tac Boum : le dernier survivant.
function renderTicTacBoumEnd(final) {
  const winner = getPlayer(final.tb.winner);
  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'question-card is-compact' },
      h('span', { class: 'eyebrow' }, 'Fin de la partie · dernier survivant'),
      h('div', { class: 'winners' }, h('div', { class: 'winner' }, avatar(winner, 'xl'), h('strong', {}, `💣 ${winner.name}`))),
    ),
    renderTicTacBoumFinal(final, quizContext),
    isHost()
      ? h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => action('game:back-to-lobby') }, 'Retour au lobby'),
          h('button', { type: 'button', class: 'btn btn-primary', onClick: () => action('game:start') }, 'Rejouer 🔁'),
        )
      : renderWaiting('L’hôte choisit la suite…'),
  );
}

// Fin d'une partie de Loup-Garou : le camp gagnant et tous les rôles.
function renderLoupGarouEnd(final) {
  return h(
    'div',
    { class: 'stack' },
    h('section', { class: 'question-card is-compact' }, h('span', { class: 'eyebrow' }, 'Fin de la partie'), h('h1', { class: 'question' }, final.lg.label)),
    renderLoupGarouFinal(final, quizContext),
    isHost()
      ? h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => action('game:back-to-lobby') }, 'Retour au lobby'),
          h('button', { type: 'button', class: 'btn btn-primary', onClick: () => action('game:start') }, 'Rejouer 🔁'),
        )
      : renderWaiting('L’hôte choisit la suite…'),
  );
}

// Ce dont le module M-Culture a besoin (défini ici pour partager les mêmes helpers).
const quizContext = {
  action,
  emit,
  toast,
  avatar,
  getPlayer,
  isHost,
  renderProgress,
  renderWaiting,
  rerender: () => render(),
  me: () => state.me,
};

// ---------------------------------------------------------------------------
// Connexion temps réel
// ---------------------------------------------------------------------------

socket.on('connect', async () => {
  els.banner.hidden = true;
  const saved = session.load();
  if (!saved) return;
  const res = await emit('lobby:rejoin', saved);
  if (res.ok) {
    state.me = res.playerId;
    render();
    return;
  }
  session.clear();
  state.lobby = null;
  state.me = null;
  render();
  toast(['LOBBY_NOT_FOUND', 'RECONNECT_FAILED'].includes(res.error) ? 'Ta dernière partie n’est plus disponible.' : res.message, 'error');
});

attachPaintSocket(socket);
attachTicTacBoumSocket(socket);

socket.on('disconnect', () => {
  if (state.lobby) els.banner.hidden = false;
});

socket.on('lobby:state', (next) => {
  const key = next.game ? `${next.state}:${next.game.round}:${next.game.review?.index ?? ''}` : next.state;
  if (key !== state.phaseKey) {
    state.phaseKey = key;
    state.draftRanking = [];
    state.editingVote = false;
    state.showDetails = false;
    state.memeEditing = false;
    state.memeDraft = null;
    state.memeVote = null;
    state.quizUi = { editing: false };
    state.entering = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  state.lobby = next;
  render();
});

socket.on('session:replaced', () => {
  state.lobby = null;
  state.me = null;
  render();
  toast('Ta partie a été ouverte dans un autre onglet ou sur un autre appareil.');
});

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function loadModes() {
  try {
    state.modes = await (await fetch('/api/modes')).json();
  } catch {
    state.modes = [{ id: 'qui-de-nous', label: 'Qui de nous', description: '', minPlayers: 2, available: true }];
  }
  if (!state.modes.some((m) => m.id === state.selectedMode && m.available)) {
    state.selectedMode = state.modes.find((m) => m.available)?.id ?? 'qui-de-nous';
  }
  render();
}

function init() {
  els.nameInput.value = readStore('localStorage', NAME_KEY) ?? '';
  const invitedCode = (new URLSearchParams(location.search).get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (invitedCode && !session.load()) {
    els.codeInput.value = invitedCode;
    els.inviteBanner.textContent = `Tu es invité dans la partie ${invitedCode} : choisis ton pseudo et rejoins !`;
    els.inviteBanner.hidden = false;
  }

  els.createBtn.addEventListener('click', createLobby);
  els.joinBtn.addEventListener('click', joinLobby);
  els.codeInput.addEventListener('input', () => {
    els.codeInput.value = els.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });
  els.codeInput.addEventListener('keydown', (event) => event.key === 'Enter' && joinLobby());
  els.nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') (els.codeInput.value ? joinLobby : createLobby)();
  });

  els.versionBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleVersion();
  });
  document.addEventListener('click', (event) => {
    if (!els.versionPopover.hidden && !els.versionPopover.contains(event.target)) toggleVersion(false);
  });
  document.addEventListener('keydown', (event) => event.key === 'Escape' && toggleVersion(false));

  loadModes();
  loadVersion();
}

init();
