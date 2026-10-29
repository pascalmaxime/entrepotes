// Le Juste Prix : estimer au plus près (prix, poids, distances, population, PIB…) et classer des
// propositions dans le bon ordre. Le moteur est dans src/justeprix/engine.js.
export default {
  id: 'juste-prix',
  kind: 'juste-prix',
  label: 'Le Juste Prix',
  description: 'Prix, poids, distances, population, PIB… Le plus proche de la bonne réponse gagne. Plus des classements Top 1, 2, 3 !',
  minPlayers: 2,
};
