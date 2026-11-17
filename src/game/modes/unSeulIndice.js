// Un seul indice (façon Just One), coopératif : chacun écrit un indice d'un mot, les doublons s'annulent. Moteur : src/unseulindice/engine.js.
export default {
  id: 'un-seul-indice',
  kind: 'un-seul-indice',
  label: 'Un seul indice',
  description: 'Jeu coopératif : chacun écrit UN indice pour faire deviner un mot au devineur… mais les indices identiques s’annulent ! Combien de mots trouverez-vous ensemble ?',
  minPlayers: 3,
};
