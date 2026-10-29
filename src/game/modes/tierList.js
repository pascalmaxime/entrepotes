import { assignRanks } from '../ranking.js';

const ID = 'tier-list';

// Chaque joueur classe TOUT le groupe (Top 1 → Top N).
// Agrégation façon Borda : Top 1 = N points, Top 2 = N-1 points… dernier = 1 point.
export default {
  id: ID,
  label: 'Tier List',
  kind: 'question',
  description: 'Classe tout le groupe du Top 1 au dernier. Les classements sont cumulés en un Top commun.',
  minPlayers: 3,

  normalizeVote(vote, { playerIds }) {
    if (!Array.isArray(vote) || vote.length !== playerIds.length) return null;
    const unique = new Set(vote);
    if (unique.size !== playerIds.length || !vote.every((id) => playerIds.includes(id))) return null;
    return [...vote];
  },

  aggregate(votes, playerIds) {
    const size = playerIds.length;
    const stats = new Map(
      playerIds.map((id) => [id, { playerId: id, points: 0, firsts: 0, positionSum: 0, positionCount: 0 }]),
    );
    for (const ranking of votes.values()) {
      ranking
        .filter((id) => stats.has(id))
        .forEach((id, index) => {
          const s = stats.get(id);
          s.points += size - index;
          s.positionSum += index + 1;
          s.positionCount += 1;
          if (index === 0) s.firsts += 1;
        });
    }
    const ranking = [...stats.values()]
      .map(({ playerId, points, firsts, positionSum, positionCount }) => ({
        playerId,
        points,
        firsts,
        averagePosition: positionCount ? Math.round((positionSum / positionCount) * 10) / 10 : null,
      }))
      // À points égaux, celui qui a le plus de Top 1 passe devant.
      .sort((a, b) => b.points - a.points || b.firsts - a.firsts);
    assignRanks(ranking, (e) => `${e.points}:${e.firsts}`);
    // Le classement complet de chaque joueur, révélé avec les résultats.
    const details = [...votes].map(([voterId, order]) => ({ voterId, ranking: order.filter((id) => stats.has(id)) }));
    return { type: ID, ranking, totalVotes: votes.size, details };
  },

  scoreDelta(result) {
    return Object.fromEntries(result.ranking.map((e) => [e.playerId, e.points]));
  },

  topPlayerIds(result) {
    return result.ranking.filter((e) => e.rank === 1).map((e) => e.playerId);
  },
};
