import { assignRanks } from '../ranking.js';

const ID = 'top-meme';

// Points d'un meme : 👍 Top = +1 · 😐 Bof = 0 · 👎 Flop = −1 (à ajuster ici si besoin).
export const MEME_POINTS = Object.freeze({ up: 1, neutral: 0, down: -1 });
export const MEME_REROLLS = 2; // changements d'image autorisés par manche
export const MEME_MAX_ITEMS = 10;
export const MEME_TEXT_MAX = 120;

const COLOR = /^#[0-9a-f]{6}$/i;
const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

export default {
  id: ID,
  kind: 'meme',
  label: 'Top Meme',
  description: 'Chacun reçoit une image au hasard et en fait un meme. Ensuite : pouce en l’air, bof ou pouce en bas !',
  minPlayers: 3,

  // Nettoie ce qu'envoie l'éditeur : textes/emojis, position (0..1), taille, couleur.
  sanitizeItems(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .slice(0, MEME_MAX_ITEMS)
      .map((item) => {
        if (!item || typeof item !== 'object' || typeof item.text !== 'string') return null;
        const text = item.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, MEME_TEXT_MAX);
        if (!text) return null;
        return {
          text,
          x: clamp(Number(item.x), 0, 1, 0.5),
          y: clamp(Number(item.y), 0, 1, 0.5),
          size: clamp(Number(item.size), 0.03, 0.25, 0.08),
          color: COLOR.test(item.color) ? item.color.toLowerCase() : '#ffffff',
        };
      })
      .filter(Boolean);
  },

  aggregate({ submissions, memeVotes, voteOrder }) {
    const memes = voteOrder
      .filter((authorId) => submissions.has(authorId))
      .map((authorId) => {
        const { id, templateId, items } = submissions.get(authorId);
        let up = 0;
        let neutral = 0;
        let down = 0;
        for (const votes of memeVotes.values()) {
          const vote = votes.get(authorId);
          if (vote === 1) up += 1;
          else if (vote === 0) neutral += 1;
          else if (vote === -1) down += 1;
        }
        const score = up * MEME_POINTS.up + neutral * MEME_POINTS.neutral + down * MEME_POINTS.down;
        return { id, authorId, templateId, items, up, neutral, down, score };
      })
      .sort((a, b) => b.score - a.score || b.up - a.up);
    assignRanks(memes, (m) => `${m.score}:${m.up}`);
    return { type: ID, memes, totalVoters: memeVotes.size };
  },

  topPlayerIds(result) {
    return result.memes.filter((m) => m.rank === 1).map((m) => m.authorId);
  },
};
