// Pré-correction automatique de M-Culture : l'hôte garde toujours le dernier mot,
// ceci ne fait que pré-cocher les réponses qui ressemblent à la bonne.

const ARTICLES = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'the', 'a', 'an']);

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word, index, words) => !(ARTICLES.has(word) && words.length > 1))
    .join(' ');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// Fautes de frappe tolérées selon la longueur de la réponse.
const tolerance = (length) => (length <= 3 ? 0 : length <= 6 ? 1 : length <= 12 ? 2 : 3);

export function isCloseEnough(given, expected) {
  const a = normalize(given);
  const b = normalize(expected);
  if (!a || !b) return false;
  if (a === b) return true;
  // Sans espaces : « spider man » = « spiderman »
  const ca = a.replace(/ /g, '');
  const cb = b.replace(/ /g, '');
  if (ca === cb) return true;
  if (/^\d+$/.test(cb)) return ca === cb; // un nombre doit être exact
  return levenshtein(ca, cb) <= tolerance(cb.length);
}

// Suggestion pour une question : vrai si la réponse correspond à la réponse ou à une variante.
export function suggestCorrect(question, given) {
  if (!given || !String(given).trim()) return false;
  if (question.cat === 'petit-bac') {
    const word = normalize(given).replace(/ /g, '');
    return word.length >= 2 && word.startsWith(question.letter.toLowerCase());
  }
  return [question.answer, ...(question.alt ?? [])].some((expected) => isCloseEnough(given, expected));
}
