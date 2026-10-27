import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

// Charge le fichier .env (identifiants admin…) s'il existe. Il n'est jamais versionné.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('[env] Fichier .env illisible :', error.message);
}

const PORT = Number(process.env.PORT) || 3000;
// 0.0.0.0 : accessible depuis les autres appareils du réseau local (téléphones pour tester).
const HOST = process.env.HOST || '0.0.0.0';

const { httpServer, io, auth } = createApp();

httpServer.listen(PORT, HOST, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  console.log(
    auth.enabled
      ? `Espace admin : http://localhost:${PORT}/admin`
      : 'Espace admin désactivé (ADMIN_PASSWORD non défini dans .env).',
  );
});

const shutdown = (signal) => {
  console.log(`${signal} reçu, arrêt du serveur…`);
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
