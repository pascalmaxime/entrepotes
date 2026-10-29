import express from 'express';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { GameError } from './game/errors.js';
import { LobbyManager } from './game/LobbyManager.js';
import { loadQuestionBank } from './game/questionBank.js';
import { loadQuizBank } from './mculture/quizBank.js';
import { loadWordBank } from './imposteur/wordBank.js';
import { loadJustePrixBank } from './justeprix/engine.js';
import { loadPaintWords } from './paint/engine.js';
import { MODE_CATALOG } from './game/modes/index.js';
import { MemeLibrary } from './memes/MemeLibrary.js';
import { createAdminAuth } from './admin/auth.js';
import { createAdminRouter } from './admin/routes.js';
import { registerSocketHandlers } from './socket/handlers.js';

const ROOT = new URL('../', import.meta.url);

export const PATHS = {
  public: fileURLToPath(new URL('public/', ROOT)),
  memes: fileURLToPath(new URL('data/memes/', ROOT)),
  version: new URL('version.json', ROOT),
  questions: new URL('data/questions.json', ROOT),
  mculture: new URL('data/mculture/', ROOT),
  imposteur: new URL('data/imposteur.json', ROOT),
  justePrix: new URL('data/justeprix.json', ROOT),
  paint: new URL('data/paint.json', ROOT),
};

const MAX_UPLOADS_PER_PLAYER = 50;

// version.json est relu à chaque requête : une modif est visible sans redémarrer.
async function readVersion(fileUrl) {
  try {
    const data = JSON.parse(await readFile(fileUrl, 'utf8'));
    return {
      version: String(data.version ?? 'dev'),
      name: typeof data.name === 'string' ? data.name : '',
      date: typeof data.date === 'string' ? data.date : '',
      notes: Array.isArray(data.notes) ? data.notes.filter((note) => typeof note === 'string') : [],
    };
  } catch (error) {
    console.warn('[version] Lecture de version.json impossible :', error.message);
    return { version: 'dev', name: '', date: '', notes: [] };
  }
}

export function createApp({
  questionBank = loadQuestionBank(PATHS.questions),
  quizBank = loadQuizBank(PATHS.mculture),
  wordBank = loadWordBank(PATHS.imposteur),
  justePrixBank = loadJustePrixBank(PATHS.justePrix),
  paintWords = loadPaintWords(PATHS.paint),
  versionFile = PATHS.version,
  memeLibrary,
  admin,
  sweepIntervalMs = 10_000,
  graceMs,
} = {}) {
  const library =
    memeLibrary ??
    new MemeLibrary({ dir: process.env.MEMES_DIR || PATHS.memes, maxImages: Number(process.env.MEMES_MAX_IMAGES) || 2000 });
  const auth = createAdminAuth(
    admin ?? {
      user: process.env.ADMIN_USER || 'admin',
      password: process.env.ADMIN_PASSWORD || '',
      secret: process.env.SESSION_SECRET,
      localOnly: process.env.ADMIN_LOCAL_ONLY === 'true',
    },
  );

  const app = express();
  app.disable('x-powered-by');
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  const manager = new LobbyManager({ questionBank, memeLibrary: library, quizBank, wordBank, justePrixBank, paintWords, graceMs });
  const { broadcast } = registerSocketHandlers(io, manager);

  app.use(express.static(PATHS.public));
  // Les images ont pour nom leur empreinte : elles ne changent jamais, on peut les garder en cache.
  app.use('/memes', express.static(library.imagesDir, { index: false, immutable: true, maxAge: '30d', dotfiles: 'deny' }));

  app.get('/health', (req, res) => res.json({ status: 'ok', lobbies: manager.size, memes: library.count }));
  app.get('/api/version', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await readVersion(versionFile));
  });
  app.get('/api/modes', (req, res) => res.json(MODE_CATALOG));

  // Envoi d'une image dans la bibliothèque : réservé aux joueurs présents dans une partie.
  const uploadCounts = new Map();
  app.post('/api/memes', express.raw({ type: 'image/jpeg', limit: '4mb' }), async (req, res) => {
    const lobby = manager.get(req.get('x-lobby-code'));
    const player = lobby?.players.get(req.get('x-player-id'));
    if (!player || player.token !== req.get('x-player-token')) {
      return res.status(401).json({ ok: false, message: 'Rejoins une partie pour ajouter des images.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, message: 'Image manquante ou format non supporté.' });
    }
    const count = uploadCounts.get(player.id) ?? 0;
    if (count >= MAX_UPLOADS_PER_PLAYER) {
      return res.status(429).json({ ok: false, message: `Limite de ${MAX_UPLOADS_PER_PLAYER} images par joueur atteinte.` });
    }
    try {
      const { entry, duplicate } = await library.add(req.body, { uploadedBy: player.name });
      if (!duplicate) uploadCounts.set(player.id, count + 1);
      broadcast(lobby);
      res.json({ ok: true, id: entry.id, duplicate, count: library.count });
    } catch (error) {
      if (error instanceof GameError) return res.status(400).json({ ok: false, message: error.message });
      console.error('[memes] Envoi impossible :', error);
      res.status(500).json({ ok: false, message: 'Erreur lors de l’enregistrement de l’image.' });
    }
  });

  app.use('/admin', createAdminRouter({ auth, memeLibrary: library }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, message: 'Image trop lourde (4 Mo maximum).' });
    }
    console.error('[http]', error);
    res.status(500).json({ ok: false, message: 'Erreur interne du serveur.' });
  });

  const sweeper = setInterval(() => manager.sweep().forEach(broadcast), sweepIntervalMs);
  sweeper.unref();
  httpServer.on('close', () => clearInterval(sweeper));

  return { app, httpServer, io, manager, memeLibrary: library, auth };
}
