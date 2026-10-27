import { GameError } from './errors.js';

export const NAME_MAX_LENGTH = 20;

// Nettoie un pseudo : retire les caractères de contrôle et compacte les espaces.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') throw new GameError('INVALID_NAME', 'Choisis un pseudo.');
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) throw new GameError('INVALID_NAME', 'Choisis un pseudo.');
  if ([...name].length > NAME_MAX_LENGTH) {
    throw new GameError('INVALID_NAME', `Ton pseudo doit faire ${NAME_MAX_LENGTH} caractères maximum.`);
  }
  return name;
}

export function normalizeCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
