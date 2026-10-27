import quiDeNous from './quiDeNous.js';
import tierList from './tierList.js';
import topMeme from './topMeme.js';

// Pour ajouter un mode : créer son fichier puis l'ajouter à cette liste.
// kind 'question' : une question + un vote (Qui de nous, Tier List) ; kind 'meme' : Top Meme.
const PLAYABLE = [quiDeNous, tierList, topMeme];

export const MODES = Object.fromEntries(PLAYABLE.map((mode) => [mode.id, mode]));
export const DEFAULT_MODE = quiDeNous.id;

// Ce que voit le front (écran d'accueil).
export const MODE_CATALOG = PLAYABLE.map(({ id, kind = 'question', label, description, minPlayers }) => ({
  id,
  kind,
  label,
  description,
  minPlayers,
  available: true,
}));

export function getMode(id) {
  return MODES[id] ?? null;
}
