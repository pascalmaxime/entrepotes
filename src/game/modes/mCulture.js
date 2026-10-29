// M-Culture : quiz de culture générale façon K-Culture.
// Les questions défilent avec un chrono, chacun écrit sa réponse, puis l'hôte corrige
// tout à la fin (pré-cochage automatique des réponses qui ressemblent à la bonne).
export const QUIZ_LIMITS = Object.freeze({
  questions: { min: 5, max: 40, default: 20 },
  timers: [0, 15, 20, 30, 45, 60, 90], // 0 = pas de chrono, l'hôte passe à la suite
  defaultTimer: 30,
  answerMax: 80,
});

export default {
  id: 'm-culture',
  kind: 'quiz',
  label: 'M-Culture',
  description: 'Quiz de culture G : drapeaux, carte, rébus, musique, petit bac… L’hôte corrige à la fin.',
  minPlayers: 2,
};
