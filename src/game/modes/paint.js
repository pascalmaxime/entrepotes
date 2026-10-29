// Paint (façon Skribbl) : un joueur dessine, les autres devinent dans le chat.
// Le moteur est dans src/paint/engine.js.
export default {
  id: 'paint',
  kind: 'paint',
  label: 'Paint',
  description: 'Chacun son tour, dessine le mot choisi pendant que les autres devinent dans le chat. Le plus rapide gagne !',
  minPlayers: 2,
};
