import { readFileSync, statSync } from 'node:fs';
import { randomInt } from 'node:crypto';

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function parseQuestions(raw) {
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(list)) throw new Error('Le fichier doit contenir un tableau "questions".');
  const texts = [...new Set(list.filter((q) => typeof q === 'string').map((q) => q.trim()).filter(Boolean))];
  if (texts.length === 0) throw new Error('Le fichier de questions est vide.');
  return texts;
}

export function createQuestionBank(texts) {
  let questions = [...texts];
  return {
    get size() {
      return questions.length;
    },
    replace(next) {
      questions = [...next];
    },
    // Tire `count` questions au hasard en évitant celles déjà posées dans ce lobby.
    pick(count, used = new Set()) {
      let pool = questions.filter((q) => !used.has(q));
      if (pool.length < count) {
        used.clear();
        pool = [...questions];
      }
      const picked = shuffle(pool).slice(0, count);
      for (const q of picked) used.add(q);
      return picked;
    },
  };
}

// Charge data/questions.json et le relit automatiquement s'il a été modifié
// (pris en compte à la partie suivante, sans redémarrer le serveur).
export function loadQuestionBank(fileUrl) {
  let mtime = statSync(fileUrl).mtimeMs;
  const bank = createQuestionBank(parseQuestions(readFileSync(fileUrl, 'utf8')));
  const basePick = bank.pick;
  bank.pick = (count, used) => {
    try {
      const current = statSync(fileUrl).mtimeMs;
      if (current !== mtime) {
        bank.replace(parseQuestions(readFileSync(fileUrl, 'utf8')));
        mtime = current;
        console.log(`[questions] Fichier rechargé (${bank.size} questions).`);
      }
    } catch (error) {
      console.warn('[questions] Rechargement impossible, on garde la version précédente :', error.message);
    }
    return basePick(count, used);
  };
  return bank;
}
