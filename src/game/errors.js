// Erreur "métier" : son message est affiché tel quel au joueur.
export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}
