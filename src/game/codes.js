import { randomInt } from 'node:crypto';

// Pas de I, O, 0 ni 1 : trop faciles à confondre quand on dicte le code à voix haute.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

export function generateCode(isTaken = () => false, length = CODE_LENGTH) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = '';
    for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
  throw new Error('Impossible de générer un code de lobby unique.');
}
