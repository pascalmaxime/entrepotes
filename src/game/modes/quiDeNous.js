import { assignRanks } from '../ranking.js';

const ID = 'qui-de-nous';

// Chaque joueur désigne UNE personne (lui-même compris). Le plus désigné l'emporte.
export default {
  id: ID,
  label: 'Qui de nous',
  kind: 'question',
  description: 'Une question, chacun désigne la personne du groupe qui correspond le mieux.',
  minPlayers: 2,

  normalizeVote(vote, { playerIds }) {
    return typeof vote === 'string' && playerIds.includes(vote) ? vote : null;
  },

  aggregate(votes, playerIds) {
    const counts = new Map(playerIds.map((id) => [id, 0]));
    const details = [];
    for (const [voterId, targetId] of votes) {
      if (!counts.has(targetId)) continue;
      counts.set(targetId, counts.get(targetId) + 1);
      details.push({ voterId, targetId });
    }
    const ranking = [...counts]
      .map(([playerId, count]) => ({ playerId, votes: count }))
      .sort((a, b) => b.votes - a.votes);
    assignRanks(ranking, (entry) => entry.votes);
    const topVotes = ranking[0]?.votes ?? 0;
    const winners = topVotes > 0 ? ranking.filter((e) => e.votes === topVotes).map((e) => e.playerId) : [];
    return { type: ID, ranking, winners, totalVotes: details.length, details };
  },

  // Points cumulés sur la partie = nombre de fois où le joueur a été désigné.
  scoreDelta(result) {
    return Object.fromEntries(result.ranking.map((e) => [e.playerId, e.votes]));
  },

  topPlayerIds(result) {
    return result.winners;
  },
};
