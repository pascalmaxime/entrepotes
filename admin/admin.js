// Espace admin : catalogue des images Top Meme, doublons et suppression.
(() => {
  const PAGE_SIZE = 60;
  const $ = (selector) => document.querySelector(selector);
  const state = { images: [], groups: [], stats: null, threshold: 8, shown: PAGE_SIZE };

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const formatBytes = (n) => {
    if (n < 1024) return `${n} o`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
    return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
  };
  const formatDate = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

  async function api(path, options = {}) {
    const res = await fetch(`/admin/api${path}`, {
      ...options,
      headers: { 'X-Admin-Request': '1', ...(options.headers ?? {}) },
    });
    if (res.status === 401) {
      location.href = '/admin/login';
      throw new Error('Session expirée');
    }
    return res.json();
  }

  async function load() {
    const [library, duplicates] = await Promise.all([api('/library'), api(`/duplicates?threshold=${state.threshold}`)]);
    state.images = library.images;
    state.stats = library.stats;
    state.groups = duplicates.groups;
    render();
  }

  async function removeImage(id) {
    const res = await api(`/images/${id}`, { method: 'DELETE' });
    if (!res.ok) window.alert(res.message ?? 'Suppression impossible.');
    return res.ok;
  }

  async function removeOne(id, button) {
    if (!window.confirm('Supprimer définitivement cette image ?')) return;
    button.disabled = true;
    await removeImage(id);
    await load();
  }

  async function keepBest(group, button) {
    const toDelete = group.images.filter((img) => img.id !== group.keepId);
    if (!window.confirm(`Garder la meilleure version et supprimer ${toDelete.length} doublon(s) ?`)) return;
    button.disabled = true;
    for (const img of toDelete) await removeImage(img.id);
    await load();
  }

  function imageCard(img, { keep = false, duplicate = false } = {}) {
    const remove = h('button', { type: 'button', class: 'danger', onClick: (event) => removeOne(img.id, event.currentTarget) }, 'Supprimer');
    return h(
      'figure',
      { class: `img-card${keep ? ' is-keep' : ''}${duplicate ? ' is-dup' : ''}` },
      h('a', { href: img.url, target: '_blank', rel: 'noopener', title: 'Ouvrir en grand' }, h('img', { src: img.url, loading: 'lazy', alt: '' })),
      h(
        'figcaption',
        {},
        keep ? h('span', { class: 'tag tag-keep' }, 'À garder') : null,
        duplicate ? h('span', { class: 'tag tag-dup' }, `Doublon · écart ${img.distance}`) : null,
        h('span', {}, `${img.width}×${img.height} · ${formatBytes(img.bytes)}`),
        h('span', { class: 'muted' }, `${img.uploadedBy} · ${formatDate(img.uploadedAt)}`),
        remove,
      ),
    );
  }

  function render() {
    const { stats } = state;
    const duplicateCount = state.groups.reduce((sum, group) => sum + group.images.length - 1, 0);
    const savable = state.groups.reduce(
      (sum, group) => sum + group.images.filter((img) => img.id !== group.keepId).reduce((s, img) => s + img.bytes, 0),
      0,
    );
    $('#stats').replaceChildren(
      h('div', { class: 'stat' }, h('strong', {}, stats.count), h('span', {}, `images (max ${stats.maxImages})`)),
      h('div', { class: 'stat' }, h('strong', {}, formatBytes(stats.bytes)), h('span', {}, 'sur le disque')),
      h('div', { class: 'stat' }, h('strong', {}, duplicateCount), h('span', {}, 'doublons probables')),
      h('div', { class: 'stat' }, h('strong', {}, formatBytes(savable)), h('span', {}, 'récupérables')),
    );

    $('#groups').replaceChildren(
      ...(state.groups.length
        ? state.groups.map((group) =>
            h(
              'div',
              { class: 'group' },
              h(
                'div',
                { class: 'group-head' },
                h('span', {}, `${group.images.length} images similaires`),
                h('button', { type: 'button', class: 'danger', onClick: (event) => keepBest(group, event.currentTarget) }, 'Garder la meilleure, supprimer les autres'),
              ),
              h(
                'div',
                { class: 'grid' },
                group.images.map((img) => imageCard(img, { keep: img.id === group.keepId, duplicate: img.id !== group.keepId })),
              ),
            ),
          )
        : [h('p', { class: 'empty' }, 'Aucun doublon détecté avec cette sensibilité. 👌')]),
    );

    const visible = state.images.slice(0, state.shown);
    $('#all').replaceChildren(
      ...(visible.length ? visible.map((img) => imageCard(img)) : [h('p', { class: 'empty' }, 'La bibliothèque est vide pour le moment.')]),
    );
    $('#more').hidden = state.images.length <= state.shown;
  }

  $('#threshold').addEventListener('change', (event) => {
    state.threshold = Number(event.target.value);
    load();
  });
  $('#more').addEventListener('click', () => {
    state.shown += PAGE_SIZE;
    render();
  });

  load().catch((error) => console.error(error));
})();
