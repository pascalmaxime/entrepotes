// L'Imposteur (façon Undercover) : les civils ont un mot, les imposteurs un mot proche,
// Mr. White n'a rien. Indices, vote, élimination… jusqu'à ce qu'un camp gagne.

export const IMPOSTOR_MIN_PLAYERS = 4;

// Points de fin de manche (à ajuster ici).
export const IMPOSTOR_POINTS = Object.freeze({
  civil: 2, // chaque civil quand les civils gagnent
  impostor: 10, // chaque imposteur quand les infiltrés gagnent
  white: 6, // Mr. White quand les infiltrés gagnent
  whiteGuess: 10, // Mr. White qui trouve le mot des civils une fois éliminé (il gagne seul)
});

export const CLUE_MAX = 40;
export const CLUE_MODES = Object.freeze(['ecrit', 'oral']);

/**
 * Combien de « méchants » selon le nombre de joueurs :
 * - au moins 1 imposteur ;
 * - Mr. White : 1 max (2 à partir de 8 joueurs) ;
 * - imposteurs + Mr. White ≤ la moitié des joueurs (jamais plus de méchants que de civils).
 */
export function roleLimits(playerCount) {
  const maxBad = Math.max(1, Math.floor(playerCount / 2));
  return {
    maxBad,
    whiteMax: Math.min(playerCount >= 8 ? 2 : 1, maxBad - 1),
    impostorsMax: maxBad,
  };
}

// Applique les limites au souhait de l'hôte (Mr. White passe en priorité, il reste ≥ 1 imposteur).
export function effectiveRoles({ impostors = 1, whites = 1 } = {}, playerCount) {
  const limits = roleLimits(playerCount);
  const w = Math.min(Math.max(0, whites), Math.max(0, limits.whiteMax));
  const i = Math.min(Math.max(1, impostors), Math.max(1, limits.maxBad - w));
  return { impostors: i, whites: w, civils: Math.max(0, playerCount - i - w), limits };
}

export default {
  id: 'imposteur',
  kind: 'impostor',
  label: 'L’Imposteur',
  description: 'Tout le monde a le même mot… sauf l’imposteur, et Mr. White qui n’en a pas. Indices, votes, démasquez-les !',
  minPlayers: IMPOSTOR_MIN_PLAYERS,
};
