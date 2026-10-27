import { Lobby } from './Lobby.js';
import { generateCode } from './codes.js';
import { normalizeCode } from './names.js';

// Délai pendant lequel un joueur déconnecté garde sa place (téléphone en veille, refresh…).
export const DISCONNECT_GRACE_MS = 90_000;

export class LobbyManager {
  constructor({ questionBank, memeLibrary = null, graceMs = DISCONNECT_GRACE_MS }) {
    this.questionBank = questionBank;
    this.memeLibrary = memeLibrary;
    this.graceMs = graceMs;
    this.lobbies = new Map();
  }

  get size() {
    return this.lobbies.size;
  }

  create() {
    const code = generateCode((candidate) => this.lobbies.has(candidate));
    const lobby = new Lobby(code, { questionBank: this.questionBank, memeLibrary: this.memeLibrary });
    this.lobbies.set(code, lobby);
    return lobby;
  }

  get(code) {
    return this.lobbies.get(normalizeCode(code)) ?? null;
  }

  deleteIfEmpty(lobby) {
    if (!lobby.isEmpty) return false;
    this.lobbies.delete(lobby.code);
    return true;
  }

  // Retire les joueurs partis depuis trop longtemps et supprime les lobbies vides.
  // Renvoie les lobbies modifiés (pour prévenir les joueurs restants).
  sweep(now = Date.now()) {
    const changed = [];
    for (const lobby of this.lobbies.values()) {
      let touched = false;
      for (const player of [...lobby.players.values()]) {
        if (!player.connected && now - player.disconnectedAt >= this.graceMs) {
          lobby.removePlayer(player.id);
          touched = true;
        }
      }
      if (lobby.isEmpty) this.lobbies.delete(lobby.code);
      else if (touched) changed.push(lobby);
    }
    return changed;
  }
}
