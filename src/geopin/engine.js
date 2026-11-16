import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GameError } from '../game/errors.js';

/**
 * Géo Pin : un lieu s'affiche, chacun pose une épingle sur la carte.
 *   gp-guess  : chacun place et valide son épingle (chrono)
 *   gp-reveal : la vraie position, les épingles de tous, les distances et les points → question suivante → … → finished
 * Points : de 0 à 1000 selon la distance (plus on est proche, plus on marque).
 * La vraie position n'est JAMAIS envoyée aux navigateurs avant la révélation.
 */

// group « monde » : sur la carte du monde ; group « region » : sur une carte zoomée, où il faut être plus précis.
export const GP_CATEGORIES = Object.freeze([
  { id: 'monde', label: 'Villes', emoji: '🌍', view: 'monde', group: 'monde' },
  { id: 'pays', label: 'Pays', emoji: '🗺️', view: 'monde', group: 'monde' },
  { id: 'monuments', label: 'Monuments', emoji: '🗿', view: 'monde', group: 'monde' },
  { id: 'europe', label: 'Europe', emoji: '🏰', view: 'europe', group: 'region' },
  { id: 'asie', label: 'Asie', emoji: '🏯', view: 'asie', group: 'region' },
  { id: 'amerique', label: 'Amérique', emoji: '🗽', view: 'amerique', group: 'region' },
  { id: 'afrique', label: 'Afrique', emoji: '🦁', view: 'afrique', group: 'region' },
  { id: 'france', label: 'France', emoji: '🇫🇷', view: 'france', group: 'region' },
]);
const REGION_IDS = ['europe', 'asie', 'amerique', 'afrique'];
const DEFAULT_CATEGORIES = ['monde', 'pays', 'monuments', 'france'];
export const GP_CATEGORY_IDS = GP_CATEGORIES.map((c) => c.id);
const VIEW_OF = Object.fromEntries(GP_CATEGORIES.map((c) => [c.id, c.view]));
export const MIN_PLAYERS = 2;
export const GP_LIMITS = Object.freeze({
  timers: [20, 30, 45, 60],
  defaults: { timer: 30, hint: true },
});
export const MAX_POINTS = 1000;
// Distance (km) à laquelle on ne garde plus que ~37 % des points : large sur le monde, serrée sur la France.
const SCALE_KM = { monde: 2000, amerique: 1200, asie: 1000, afrique: 900, europe: 500, france: 150 };
const GRACE_MS = 1_000;
export const GEOPIN_FILE = fileURLToPath(new URL('../../data/geopin.json', import.meta.url));
const COUNTRIES_FILE = fileURLToPath(new URL('../../data/mculture/carte.json', import.meta.url));
const WORLD_FILE = fileURLToPath(new URL('../../public/mculture/world-110m.json', import.meta.url));

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Distance à vol d'oiseau entre deux points du globe, en km.
export function distanceKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// --- Mode « Pays » : dans le pays = 0 km, sinon distance jusqu'à sa frontière la plus proche ------------------

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point.lat !== yj > point.lat && point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToCountry(guess, rings) {
  if (rings.some((ring) => inRing(guess, ring))) return 0;
  let best = Infinity;
  for (const ring of rings) for (const [lon, lat] of ring) best = Math.min(best, distanceKm(guess, { lat, lon }));
  return best;
}

export function distanceTo(guess, place) {
  return place.rings ? distanceToCountry(guess, place.rings) : distanceKm(guess, place);
}

// Contours des pays (les mêmes que la carte affichée), pour le mode « Pays ».
function loadCountries() {
  try {
    const topology = JSON.parse(readFileSync(WORLD_FILE, 'utf8'));
    const names = JSON.parse(readFileSync(COUNTRIES_FILE, 'utf8')).questions;
    const { scale, translate } = topology.transform;
    const arcs = topology.arcs.map((arc) => {
      let x = 0;
      let y = 0;
      return arc.map(([dx, dy]) => {
        x += dx;
        y += dy;
        return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
      });
    });
    const ring = (indexes) => indexes.flatMap((index, i) => (index < 0 ? [...arcs[~index]].reverse() : arcs[index]).slice(i ? 1 : 0));
    const byId = new Map(topology.objects.countries.geometries.filter((g) => g.arcs).map((g) => [g.id, (g.type === 'Polygon' ? [g.arcs] : g.arcs).map((poly) => ring(poly[0]))]));
    return names
      // Seulement les pays connus (1 ou 2 points dans M-Culture) : les plus durs restent pour le quiz.
      .filter((c) => byId.has(c.id) && (c.pts ?? 3) <= 2)
      .map((c) => {
        const rings = byId.get(c.id);
        // Point de repère : le centre du plus grand morceau du pays (la France sans la Guyane).
        const box = (r) => [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1])), Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))];
        const main = rings.map(box).filter((b) => b[2] - b[0] < 180).sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0] ?? box(rings[0]);
        return { key: `pays:${c.id}`, cat: 'pays', name: c.a, hint: '', countryId: c.id, lat: (main[1] + main[3]) / 2, lon: (main[0] + main[2]) / 2, view: 'monde', rings };
      });
  } catch (error) {
    console.warn('[geopin] Mode « Pays » indisponible :', error.message);
    return [];
  }
}

export function pointsFor(km, view) {
  return Math.round(MAX_POINTS * Math.exp(-km / SCALE_KM[view]));
}

// --- Banque de lieux (data/geopin.json, relu automatiquement s'il change) -------------------------------

function parseBank(raw) {
  const data = JSON.parse(raw);
  const ok = (n, max) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max;
  const list = [];
  for (const q of Array.isArray(data.questions) ? data.questions : []) {
    if (typeof q?.name !== 'string' || !q.name.trim() || !ok(q.lat, 90) || !ok(q.lon, 180)) continue;
    // Une ville sort dans « Villes du monde » (sauf "monde": false) et dans la catégorie de sa région.
    const cats = q.cat === 'villes' ? [q.monde === false ? null : 'monde', REGION_IDS.includes(q.region) ? q.region : null] : [q.cat];
    for (const cat of cats) {
      if (!GP_CATEGORY_IDS.includes(cat)) continue;
      list.push({ key: `${cat}:${q.name}`, cat, name: q.name.trim(), hint: typeof q.hint === 'string' ? q.hint.trim() : '', lat: q.lat, lon: q.lon, view: VIEW_OF[cat] });
    }
  }
  if (list.length === 0) throw new Error('Aucun lieu valide.');
  return [...list, ...loadCountries()];
}

export function createGeoBank(places) {
  let list = [...places];
  return {
    get size() {
      return list.length;
    },
    replace(next) {
      list = [...next];
    },
    counts() {
      return Object.fromEntries(GP_CATEGORY_IDS.map((id) => [id, list.filter((q) => q.cat === id).length]));
    },
    // Lieux répartis entre les catégories choisies, sans répéter ceux déjà joués dans le lobby.
    pick({ categories, count }, used = new Set()) {
      const chosen = GP_CATEGORY_IDS.filter((id) => categories.includes(id) && list.some((q) => q.cat === id));
      if (chosen.length === 0) return [];
      const queues = new Map(
        chosen.map((id) => {
          const all = list.filter((q) => q.cat === id);
          let fresh = all.filter((q) => !used.has(q.key));
          if (fresh.length === 0) {
            for (const q of all) used.delete(q.key);
            fresh = all;
          }
          return [id, shuffle(fresh)];
        }),
      );
      const picked = [];
      let order = shuffle(chosen);
      while (picked.length < count && order.length) {
        for (const id of order) {
          if (picked.length >= count) break;
          const next = queues.get(id).shift();
          if (next) picked.push(next);
        }
        order = order.filter((id) => queues.get(id).length > 0);
      }
      for (const q of picked) used.add(q.key);
      return shuffle(picked);
    },
  };
}

export function loadGeoBank(file = GEOPIN_FILE) {
  let mtime = statSync(file).mtimeMs;
  const bank = createGeoBank(parseBank(readFileSync(file, 'utf8')));
  const refresh = () => {
    try {
      const current = statSync(file).mtimeMs;
      if (current === mtime) return;
      bank.replace(parseBank(readFileSync(file, 'utf8')));
      mtime = current;
      console.log(`[geopin] Fichier rechargé (${bank.size} lieux).`);
    } catch (error) {
      console.warn('[geopin] Rechargement impossible, on garde la version précédente :', error.message);
    }
  };
  const basePick = bank.pick;
  const baseCounts = bank.counts;
  bank.pick = (options, used) => {
    refresh();
    return basePick(options, used);
  };
  bank.counts = () => {
    refresh();
    return baseCounts();
  };
  return bank;
}

let sharedBank = null;
export function getBank() {
  if (!sharedBank) sharedBank = loadGeoBank();
  return sharedBank;
}

// --- Déroulé de la partie -------------------------------------------------------------------------------

const gpOf = (lobby) => lobby.game.geoPin;
const current = (gp) => gp.questions[gp.index];

export function startGeoPin(lobby, base) {
  if (lobby.connectedPlayers.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS', `Il faut au moins ${MIN_PLAYERS} joueurs.`);
  const settings = { ...lobby.settings.geoPin };
  lobby.geoBank ??= getBank();
  lobby.usedGeo ??= new Set();
  const questions = lobby.geoBank.pick({ categories: settings.categories, count: lobby.settings.rounds }, lobby.usedGeo);
  if (questions.length === 0) throw new GameError('NO_QUESTIONS', 'Aucun lieu disponible dans les catégories choisies.');
  lobby.clearQuizTimer();
  lobby.game = { ...base, totalRounds: questions.length, geoPin: { settings, questions, index: 0, token: 0, deadline: null, guesses: new Map(), best: null } };
  openGuess(lobby);
}

function openGuess(lobby) {
  const gp = gpOf(lobby);
  gp.guesses = new Map(); // joueur → { lat, lon }
  lobby.game.result = null;
  lobby.state = 'gp-guess';
  lobby.clearQuizTimer();
  const token = ++gp.token;
  gp.deadline = Date.now() + gp.settings.timer * 1000;
  lobby.quizTimer = setTimeout(() => {
    lobby.quizTimer = null;
    if (lobby.game?.geoPin !== gp || gp.token !== token) return;
    reveal(lobby);
    lobby.onChange?.(lobby);
  }, gp.settings.timer * 1000 + GRACE_MS);
  lobby.quizTimer.unref?.();
}

export function submitGuess(lobby, playerId, { index, lat, lon } = {}) {
  if (lobby.game?.kind !== 'geo-pin' || lobby.state !== 'gp-guess') throw new GameError('NOT_NOW', 'Ce n’est plus le moment de placer ton épingle.');
  const gp = gpOf(lobby);
  if (index !== gp.index) throw new GameError('TOO_LATE', 'Trop tard, on est passé à la suite !');
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new GameError('INVALID_GUESS', 'Position invalide.');
  }
  if (gp.guesses.has(playerId)) throw new GameError('ALREADY_DONE', 'Ton épingle est déjà validée.');
  gp.guesses.set(playerId, { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 });
  progress(lobby);
}

export function progress(lobby) {
  if (lobby.state !== 'gp-guess') return false;
  const gp = gpOf(lobby);
  const players = lobby.connectedPlayers;
  if (players.length === 0 || !players.every((p) => gp.guesses.has(p.id))) return false;
  reveal(lobby);
  return true;
}

export function reveal(lobby) {
  const gp = gpOf(lobby);
  const { game } = lobby;
  lobby.clearQuizTimer();
  gp.deadline = null;
  const place = current(gp);
  const entries = lobby.playerIds
    .map((playerId) => {
      const guess = gp.guesses.get(playerId);
      if (!guess) return { playerId, lat: null, lon: null, km: null, points: 0 };
      const km = distanceTo(guess, place);
      return { playerId, ...guess, km: Math.round(km), points: pointsFor(km, place.view) };
    })
    .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
  for (const e of entries) if (e.points) game.totals[e.playerId] = (game.totals[e.playerId] ?? 0) + e.points;
  const placed = entries.filter((e) => e.km !== null);
  const bestKm = placed[0]?.km ?? null;
  if (placed[0] && (!gp.best || placed[0].km < gp.best.km)) gp.best = { playerId: placed[0].playerId, km: placed[0].km, name: place.name };
  game.history.push({
    question: place.name,
    answer: bestKm === null ? 'Personne n’a répondu' : `le plus proche à ${bestKm} km`,
    topPlayerIds: placed.filter((e) => e.km === bestKm).map((e) => e.playerId),
  });
  game.result = {
    type: 'geo-pin',
    place: { cat: place.cat, name: place.name, hint: place.hint, lat: place.lat, lon: place.lon, view: place.view, countryId: place.countryId ?? null },
    entries,
    scores: { ...game.totals },
  };
  lobby.state = 'gp-reveal';
}

export function next(lobby) {
  const gp = gpOf(lobby);
  if (gp.index + 1 >= gp.questions.length) {
    lobby.game.index = lobby.game.totalRounds;
    lobby.finish();
    lobby.game.final.geoPin = { best: gp.best };
    return 'finish';
  }
  gp.index += 1;
  lobby.game.index = gp.index;
  openGuess(lobby);
  return 'next';
}

export function playerGone(lobby, playerId) {
  lobby.game.geoPin.guesses.delete(playerId);
}

// --- Ce que voit chaque joueur -------------------------------------------------------------------------

export function geoPinPublic(lobby, viewerId) {
  const gp = lobby.game?.geoPin;
  if (!gp || !lobby.state.startsWith('gp-')) return null;
  const place = current(gp);
  return {
    phase: lobby.state,
    index: gp.index,
    total: gp.questions.length,
    // Jamais la position avant la révélation : seulement le nom, la carte à utiliser et l'indice si l'hôte l'a activé.
    question: { cat: place.cat, name: place.name, view: place.view, hint: gp.settings.hint ? place.hint : '' },
    deadline: gp.deadline,
    timer: gp.settings.timer,
    serverNow: Date.now(),
    maxPoints: MAX_POINTS,
    doneIds: [...gp.guesses.keys()].filter((id) => lobby.players.has(id)),
    myGuess: lobby.state === 'gp-guess' ? (gp.guesses.get(viewerId) ?? null) : null,
  };
}

export function geoPinLimits(lobby) {
  const counts = (lobby.geoBank ?? getBank()).counts();
  return {
    minPlayers: MIN_PLAYERS,
    timers: [...GP_LIMITS.timers],
    maxPoints: MAX_POINTS,
    categories: GP_CATEGORIES.map(({ id, label, emoji, group }) => ({ id, label, emoji, group, count: counts[id] ?? 0 })),
  };
}

export function defaultSettings() {
  return { categories: [...DEFAULT_CATEGORIES], ...GP_LIMITS.defaults };
}

export function sanitizeSettings(currentSettings, { gpCategories, gpTimer, gpHint }) {
  const nextSettings = { ...currentSettings };
  if (gpCategories !== undefined) {
    if (!Array.isArray(gpCategories)) throw new GameError('INVALID_SETTINGS', 'Catégories invalides.');
    nextSettings.categories = GP_CATEGORY_IDS.filter((id) => gpCategories.includes(id));
    if (nextSettings.categories.length === 0) throw new GameError('INVALID_SETTINGS', 'Garde au moins une catégorie.');
  }
  if (gpTimer !== undefined) {
    const v = Number.parseInt(gpTimer, 10);
    if (!GP_LIMITS.timers.includes(v)) throw new GameError('INVALID_SETTINGS', 'Chrono invalide.');
    nextSettings.timer = v;
  }
  if (gpHint !== undefined) nextSettings.hint = Boolean(gpHint);
  return nextSettings;
}
