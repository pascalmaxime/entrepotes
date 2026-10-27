import express from 'express';
import { fileURLToPath } from 'node:url';

const VIEWS = new URL('../../admin/', import.meta.url);
const view = (name) => fileURLToPath(new URL(name, VIEWS));

export function createAdminRouter({ auth, memeLibrary }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (auth.isBlockedOrigin(req)) return res.status(404).type('text/plain').send('Not found');
    if (!auth.enabled) {
      return res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('Espace admin désactivé : définis ADMIN_PASSWORD dans le fichier .env puis redémarre le serveur.');
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  // --- Pages publiques (connexion) ---
  router.get('/admin.css', (req, res) => res.sendFile(view('admin.css')));
  router.get('/login', (req, res) =>
    auth.isAuthenticated(req) ? res.redirect(303, '/admin') : res.sendFile(view('login.html')),
  );
  router.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    if (auth.isLocked(req)) return res.redirect(303, '/admin/login?error=locked');
    if (!auth.checkCredentials(req, req.body?.username, req.body?.password)) {
      return res.redirect(303, auth.isLocked(req) ? '/admin/login?error=locked' : '/admin/login?error=1');
    }
    auth.startSession(req, res);
    res.redirect(303, '/admin');
  });
  router.post('/logout', (req, res) => {
    auth.endSession(req, res);
    res.redirect(303, '/admin/login');
  });

  // --- Tout ce qui suit exige d'être connecté ---
  router.use((req, res, next) => {
    if (auth.isAuthenticated(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, message: 'Session expirée, reconnecte-toi.' });
    res.redirect(303, '/admin/login');
  });

  router.get('/', (req, res) => res.sendFile(view('index.html')));
  router.get('/admin.js', (req, res) => res.sendFile(view('admin.js')));

  router.get('/api/library', (req, res) => {
    res.json({ ok: true, stats: memeLibrary.stats(), images: memeLibrary.list() });
  });

  router.get('/api/duplicates', (req, res) => {
    const threshold = Math.min(20, Math.max(0, Number.parseInt(req.query.threshold, 10) || 8));
    res.json({ ok: true, threshold, groups: memeLibrary.similarGroups(threshold) });
  });

  router.delete('/api/images/:id', async (req, res) => {
    // En-tête maison : un autre site ne peut pas déclencher une suppression à ta place.
    if (req.get('x-admin-request') !== '1') return res.status(403).json({ ok: false, message: 'Requête refusée.' });
    const removed = await memeLibrary.remove(req.params.id);
    if (removed) console.log(`[admin] image ${req.params.id} supprimée`);
    res.status(removed ? 200 : 404).json({ ok: removed, message: removed ? undefined : 'Image introuvable.' });
  });

  return router;
}
