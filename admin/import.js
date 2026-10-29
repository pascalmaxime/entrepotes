// Import en masse d'images dans la bibliothèque Top Meme (depuis l'espace admin).
// Chaque image est préparée dans le navigateur (redressée, réduite, convertie en JPEG)
// comme pour les joueurs ; le serveur ignore les doublons.
import { prepareImage } from '/js/meme.js';

const input = document.getElementById('import-input');
const button = document.getElementById('import-btn');
const status = document.getElementById('import-status');

button.addEventListener('click', () => input.click());

input.addEventListener('change', async () => {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  button.disabled = true;
  let added = 0;
  let duplicates = 0;
  const errors = [];
  for (const [index, file] of files.entries()) {
    status.textContent = `Import ${index + 1}/${files.length}…`;
    try {
      const blob = await prepareImage(file);
      const res = await fetch('/admin/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Admin-Request': '1' },
        body: blob,
      });
      if (res.status === 401) {
        location.href = '/admin/login';
        return;
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.message);
      if (data.duplicate) duplicates += 1;
      else added += 1;
    } catch (error) {
      errors.push(`${file.name} : ${error.message}`);
    }
  }
  status.textContent = `${added} image(s) ajoutée(s) · ${duplicates} déjà présente(s)${errors.length ? ` · ${errors.length} erreur(s)` : ''}`;
  if (errors.length) console.warn('Images non importées :', errors);
  button.disabled = false;
  window.adminReload?.();
});
