// Attribue un rang à une liste déjà triée. Les ex aequo partagent le même rang (1, 1, 3…).
export function assignRanks(entries, tieKey) {
  let rank = 0;
  entries.forEach((entry, index) => {
    if (index === 0 || tieKey(entry) !== tieKey(entries[index - 1])) rank = index + 1;
    entry.rank = rank;
  });
  return entries;
}
