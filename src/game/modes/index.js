import quiDeNous from './quiDeNous.js';
import tierList from './tierList.js';
import topMeme from './topMeme.js';
import mCulture from './mCulture.js';
import imposteur from './imposteur.js';
import justePrix from './justePrix.js';
import paint from './paint.js';
import loupGarou from './loupGarou.js';
import ticTacBoum from './ticTacBoum.js';
import coqAne from './coqAne.js';

// Pour ajouter un mode : créer son fichier puis l'ajouter à cette liste.
// kind 'question' : une question + un vote (Qui de nous, Tier List) ; kind 'meme' : Top Meme ;
// kind 'quiz' : M-Culture ; kind 'impostor' : L'Imposteur ; kind 'juste-prix' : Le Juste Prix ; kind 'paint' : Paint ;
// kind 'loup-garou' : Loup-Garou ; kind 'tic-tac-boum' : Tic Tac Boum ;
// kind 'coq-ane' : Du coq à l'âne.
const PLAYABLE = [quiDeNous, tierList, topMeme, mCulture, imposteur, justePrix, paint, loupGarou, ticTacBoum, coqAne];

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
