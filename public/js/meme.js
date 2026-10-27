import { h } from './dom.js';

export const MEME_COLORS = ['#ffffff', '#000000', '#ffd23f', '#ff4d4d', '#4fd1ff', '#ff5ca8', '#4ade80'];
export const MEME_EMOJIS = ['😂', '🤣', '😭', '💀', '🔥', '😎', '🤡', '👀', '😱', '🥲', '🙃', '😤', '🤯', '🥶', '🤔', '💯', '👑', '🐐', '🗿', '🫠', '❤️', '🎉', '👍', '👎'];
export const VOTE_CHOICES = [
  { value: 1, key: 'up', emoji: '👍', label: 'Top' },
  { value: 0, key: 'neutral', emoji: '😐', label: 'Bof' },
  { value: -1, key: 'down', emoji: '👎', label: 'Flop' },
];

const MAX_ITEMS = 10;
const MAX_SIDE = 1280; // les images sont réduites dans le navigateur avant l'envoi
const TEXT_MAX = 120;

export const memeUrl = (templateId) => `/memes/${templateId}.jpg`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const makeKey = () => Math.random().toString(36).slice(2, 10);

// Contour blanc pour un texte foncé, noir sinon (le style "meme" classique).
function strokeFor(color) {
  const n = Number.parseInt(color.slice(1), 16);
  const luminance = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance < 0.35 ? '#ffffff' : '#000000';
}

// Ancrage vertical : un texte placé en haut grandit vers le bas, un texte en bas grandit
// vers le haut (comme les memes classiques) : un texte sur plusieurs lignes ne sort pas de l'image.
function verticalAnchor(y) {
  if (y < 1 / 3) return '0%';
  if (y > 2 / 3) return '-100%';
  return '-50%';
}

function applyItemStyle(el, item) {
  el.style.left = `${item.x * 100}%`;
  el.style.top = `${item.y * 100}%`;
  el.style.transform = `translate(-50%, ${verticalAnchor(item.y)})`;
  el.style.color = item.color;
  el.style.setProperty('--size', item.size);
  el.style.setProperty('--stroke', strokeFor(item.color));
}

function memeImage(templateId) {
  const img = h('img', { class: 'meme-img', src: memeUrl(templateId), alt: '', draggable: 'false' });
  img.addEventListener('error', () => img.parentElement?.classList.add('is-missing'), { once: true });
  return img;
}

// Affiche un meme : l'image + les textes posés par-dessus. Tout est en % de la largeur de
// l'image, donc le rendu est identique sur un téléphone et sur un grand écran.
export function renderMeme(templateId, items, { className = '' } = {}) {
  return h(
    'div',
    { class: `meme ${className}`.trim() },
    memeImage(templateId),
    items.map((item) => {
      const el = h('span', { class: 'meme-item' }, item.text);
      applyItemStyle(el, item);
      return el;
    }),
  );
}

/**
 * Éditeur de meme : ajouter du texte ou des emojis, les déplacer au doigt ou à la souris,
 * changer la taille et la couleur. getItems() renvoie ce qu'il faut envoyer au serveur.
 */
export function createMemeEditor({ templateId, items: initial = [], onLimit = () => {} }) {
  let items = initial.map((item) => ({ ...item, key: makeKey() }));
  let selectedKey = null;
  const nodes = new Map();

  const stage = h('div', { class: 'meme meme-editor' }, memeImage(templateId));
  const textInput = h('textarea', { class: 'meme-text-input', rows: '2', maxlength: String(TEXT_MAX), placeholder: 'Écris ton texte…', 'aria-label': 'Texte sélectionné' });
  const sizeInput = h('input', { type: 'range', min: '0.04', max: '0.2', step: '0.005', 'aria-label': 'Taille du texte' });
  const swatches = MEME_COLORS.map((color) =>
    h('button', { type: 'button', class: 'swatch', style: `--swatch:${color}`, 'aria-label': `Couleur ${color}`, onClick: () => update({ color }) }),
  );
  const panel = h(
    'div',
    { class: 'card meme-panel', hidden: true },
    textInput,
    h('label', { class: 'panel-row' }, h('span', {}, 'Taille'), sizeInput),
    h('div', { class: 'color-row', role: 'group', 'aria-label': 'Couleur' }, swatches),
    h('button', { type: 'button', class: 'btn btn-ghost btn-small', onClick: () => removeSelected() }, '🗑️ Supprimer cet élément'),
  );

  const current = () => items.find((item) => item.key === selectedKey) ?? null;

  function paint(item) {
    const el = nodes.get(item.key);
    el.textContent = item.text || 'Ton texte';
    el.classList.toggle('is-placeholder', !item.text);
    el.classList.toggle('is-selected', item.key === selectedKey);
    applyItemStyle(el, item);
  }

  function select(key) {
    selectedKey = key;
    items.forEach(paint);
    const item = current();
    panel.hidden = !item;
    if (!item) return;
    textInput.value = item.text;
    sizeInput.value = String(item.size);
    swatches.forEach((swatch, index) => swatch.classList.toggle('is-active', MEME_COLORS[index] === item.color));
  }

  function update(patch) {
    const item = current();
    if (!item) return;
    Object.assign(item, patch);
    paint(item);
    if (patch.color) swatches.forEach((swatch, index) => swatch.classList.toggle('is-active', MEME_COLORS[index] === item.color));
  }

  function startDrag(event, item) {
    event.preventDefault();
    select(item.key);
    const el = nodes.get(item.key);
    const rect = stage.getBoundingClientRect();
    const offsetX = event.clientX - (rect.left + item.x * rect.width);
    const offsetY = event.clientY - (rect.top + item.y * rect.height);
    el.setPointerCapture?.(event.pointerId);
    const move = (e) => {
      item.x = clamp((e.clientX - offsetX - rect.left) / rect.width, 0, 1);
      item.y = clamp((e.clientY - offsetY - rect.top) / rect.height, 0, 1);
      applyItemStyle(el, item);
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function mount(item) {
    const el = h('span', { class: 'meme-item is-editable', role: 'button', tabindex: '0', 'aria-label': 'Élément du meme : touche pour modifier, glisse pour déplacer' });
    el.addEventListener('pointerdown', (event) => startDrag(event, item));
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select(item.key);
        textInput.focus();
      }
    });
    nodes.set(item.key, el);
    stage.append(el);
    paint(item);
  }

  function add(partial) {
    if (items.length >= MAX_ITEMS) {
      onLimit();
      return;
    }
    const item = { key: makeKey(), text: '', x: 0.5, y: 0.5, size: 0.08, color: '#ffffff', ...partial };
    items.push(item);
    mount(item);
    select(item.key);
    if (!item.text) textInput.focus();
  }

  function removeSelected() {
    const item = current();
    if (!item) return;
    nodes.get(item.key).remove();
    nodes.delete(item.key);
    items = items.filter((other) => other !== item);
    select(null);
  }

  textInput.addEventListener('input', () => update({ text: textInput.value.slice(0, TEXT_MAX) }));
  sizeInput.addEventListener('input', () => update({ size: Number(sizeInput.value) }));
  stage.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.meme-item')) select(null);
  });

  items.forEach(mount);

  const el = h(
    'div',
    { class: 'stack meme-workbench' },
    stage,
    h(
      'div',
      { class: 'meme-tools' },
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onClick: () => add({ text: '', y: 0.5 }) }, '+ Texte'),
      h('div', { class: 'emoji-row', role: 'group', 'aria-label': 'Ajouter un emoji' }, MEME_EMOJIS.map((emoji) => h('button', { type: 'button', class: 'emoji-btn', onClick: () => add({ text: emoji, size: 0.12 }) }, emoji))),
    ),
    panel,
  );

  return {
    el,
    // Sans les éléments vides (sauf includeEmpty) et sans la clé interne.
    getItems({ includeEmpty = false } = {}) {
      return items
        .filter((item) => includeEmpty || item.text.trim())
        .map(({ key, ...item }) => ({ ...item, text: includeEmpty ? item.text : item.text.trim() }));
    },
  };
}

// Prépare une photo avant l'envoi : redressée, réduite à 1280 px, convertie en JPEG.
// La conversion supprime aussi les métadonnées (position GPS…) côté téléphone.
export async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('ce fichier n’est pas une image');
  const source = await loadImage(file);
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; // fond blanc pour les PNG transparents
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('conversion impossible'))), 'image/jpeg', 0.85);
  });
}

async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* format non géré par createImageBitmap : on essaie avec <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('format d’image non reconnu par ce navigateur');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
