/* FortReplays, standalone build.
 *
 * Match aggregation, squad detection, storage and UI. Everything lives in the
 * browser: matches are kept in localStorage, so closing the page loses nothing
 * and there is no server involved.
 */

/* ------------------------------------------------------------- formatting */

const fmt = {
  int: (n) => (n == null ? "-" : Math.round(n).toLocaleString()),
  dec: (n, places = 1) => (n == null ? "-" : n.toFixed(places)),
  pct: (n, places = 1) => (n == null ? "-" : (n * 100).toFixed(places) + "%"),
  duration: (ms) => {
    if (!ms) return "-";
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  },
  clock: (ms) => {
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  },
  time: (iso) =>
    iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "-",
  dayLabel: (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  },
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/* ---------------------------------------------------------------- storage */

const KEYS = {
  matches: "fr.matches",
  squad: "fr.squad",
  names: "fr.names",
  weapons: "fr.weapons",
  apiKey: "fr.apikey",
  account: "fr.account",
  theme: "fr.theme",
};

/*
 * Matches live in IndexedDB, which has room for thousands of them. Everything
 * else is small and stays in localStorage. All matches are loaded into memory
 * once at start-up, so every read below is synchronous and cheap; writes go to
 * memory first and then to disk.
 *
 * Older builds kept matches in localStorage (about 200 fit). Those are moved
 * across on first run. If IndexedDB is unavailable, localStorage is used as
 * before.
 */
const IDB_NAME = "fortreplays";
const IDB_STORE = "matches";
let matchCache = [];
let libraryVersion = 0; // bumped on every change, for caches built from matches
let idb = null;

function openIdb() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE, { keyPath: "replayId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Run one IndexedDB transaction. Resolves true once it is on disk. */
function idbRun(mode, work) {
  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(IDB_STORE, mode);
      const result = work(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : true);
      tx.onerror = tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function initStorage() {
  idb = await openIdb();
  const legacy = db.read(KEYS.matches, []);
  if (!idb) {
    matchCache = legacy;
    return;
  }
  const stored = await idbRun("readonly", (s) => s.getAll());
  matchCache = Array.isArray(stored) ? stored : [];
  if (legacy.length) {
    const known = new Set(matchCache.map((m) => m.replayId));
    const moving = legacy.filter((m) => m && m.replayId && !known.has(m.replayId));
    const ok = await idbRun("readwrite", (s) => moving.forEach((m) => s.put(m)));
    if (ok) {
      matchCache.push(...moving);
      localStorage.removeItem(KEYS.matches);
    }
  }
}

function storageFull() {
  alert(
    "Browser storage is full, so that could not be saved.\n\n" +
      "Remove some older matches, or export a backup from Settings and clear space."
  );
}

const db = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      storageFull();
      return false;
    }
  },
  backend: () => (idb ? "IndexedDB" : "localStorage"),
  matches: () => matchCache,
  findMatch: (id) => matchCache.find((m) => m.replayId === id) || null,
  async addMatches(list) {
    if (!list.length) return true;
    const ok = idb
      ? await idbRun("readwrite", (s) => list.forEach((m) => s.put(m)))
      : db.write(KEYS.matches, matchCache.concat(list));
    if (ok) matchCache.push(...list), libraryVersion++;
    else if (idb) storageFull();
    return ok;
  },
  async removeMatches(ids) {
    const drop = new Set(ids);
    const keep = matchCache.filter((m) => !drop.has(m.replayId));
    const ok = idb ? await idbRun("readwrite", (s) => ids.forEach((id) => s.delete(id))) : db.write(KEYS.matches, keep);
    if (ok) (matchCache = keep), libraryVersion++;
    return ok;
  },
  async clearMatches() {
    const ok = idb ? await idbRun("readwrite", (s) => s.clear()) : true;
    localStorage.removeItem(KEYS.matches);
    if (ok) (matchCache = []), libraryVersion++;
    return ok;
  },
  squad: () => new Set(db.read(KEYS.squad, [])),
  saveSquad: (set) => db.write(KEYS.squad, [...set]),
  names: () => db.read(KEYS.names, {}),
  saveNames: (map) => db.write(KEYS.names, map),
  weapons: () => db.read(KEYS.weapons, {}),
  saveWeapons: (map) => db.write(KEYS.weapons, map),
};

/* ------------------------------------------------------- weapon labelling */

const KNOWN_CAUSES = { 50: "Storm", 0: "Environment" };
const RANGE_PROFILE = [
  [3, "Melee / pickaxe"],
  [12, "Shotgun"],
  [25, "SMG"],
  [45, "Assault rifle"],
  [80, "Marksman rifle"],
  [Infinity, "Sniper"],
];

function percentile(values, fraction) {
  const clean = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!clean.length) return null;
  return clean[Math.min(clean.length - 1, Math.floor(clean.length * fraction))];
}

let lobbyRanges = { version: -1, byCode: {} };

/** Every kill range in every stored lobby, by cause code. Cached per library size. */
function lobbyKillsByCode() {
  if (lobbyRanges.version === libraryVersion) return lobbyRanges.byCode;
  const byCode = {};
  for (const match of matchCache) {
    for (const [, killer, , gunType, knocked, self, distanceM] of match.elims || []) {
      if (knocked || self || killer < 0 || distanceM == null) continue;
      (byCode[gunType] = byCode[gunType] || []).push(distanceM);
    }
  }
  lobbyRanges = { version: libraryVersion, byCode };
  return byCode;
}

/**
 * Cause code to display name. Guessed from how far kills with that code happen
 * across every lobby you have imported (far more data than your own kills),
 * then overridden by any names you set yourself.
 */
function weaponNames() {
  return { ...guessedWeaponNames(), ...db.weapons() };
}

/** Range-based guesses only, before anything you renamed. */
function guessedWeaponNames() {
  const byCode = lobbyKillsByCode();
  const names = {};
  for (const code of Object.keys(byCode)) {
    const p75 = percentile(byCode[code], 0.75);
    names[code] =
      KNOWN_CAUSES[code] ??
      (p75 == null ? `Weapon type ${code}` : RANGE_PROFILE.find(([limit]) => p75 <= limit)[1]);
  }
  return names;
}

/** Your kill ranges grouped by cause code, across every stored match. */
function myKillsByCode(accountId) {
  const byCode = {};
  if (!accountId) return byCode;
  for (const match of db.matches()) {
    for (const kill of myKillsFor(match, accountId)) {
      (byCode[kill.gunType] = byCode[kill.gunType] || []).push(kill.distanceM);
    }
  }
  return byCode;
}

function causeLabel(code, names) {
  if (code == null) return "Unknown";
  return names[code] || KNOWN_CAUSES[code] || `Weapon type ${code}`;
}

/* ------------------------------------------------ per-match aggregation */

/** Collapse a match's killfeed into one row per player, plus squad signals. */
function summarise(parsed) {
  const players = new Map();
  const entry = (id, type) => {
    if (!id) return null;
    if (!players.has(id)) {
      players.set(id, {
        id,
        type: type || "player",
        kills: 0,
        knocks: 0,
        deaths: 0,
        timesKnocked: 0,
        selfElims: 0,
        distances: [],
        weapons: {},
        diedAtMs: null,
        killedByCode: null,
      });
    }
    const record = players.get(id);
    if (type && record.type === "player") record.type = type;
    return record;
  };

  const sorted = [...parsed.eliminations].sort((a, b) => a.timeMs - b.timeMs);
  for (const e of sorted) {
    const killer = entry(e.eliminatorId, e.eliminatorType);
    const victim = entry(e.eliminatedId, e.eliminatedType);
    if (e.isSelfElim) {
      if (victim) {
        victim.selfElims++;
        if (!e.knocked && victim.diedAtMs == null) {
          victim.diedAtMs = e.timeMs;
          victim.killedByCode = e.gunType;
        }
      }
      continue;
    }
    if (killer) {
      if (e.knocked) killer.knocks++;
      else {
        killer.kills++;
        killer.weapons[e.gunType] = (killer.weapons[e.gunType] || 0) + 1;
        if (e.distanceM != null) killer.distances.push(e.distanceM);
      }
    }
    if (victim) {
      if (e.knocked) victim.timesKnocked++;
      else {
        victim.deaths++;
        if (victim.diedAtMs == null) {
          victim.diedAtMs = e.timeMs;
          victim.killedByCode = e.gunType;
        }
      }
    }
  }

  const rows = [...players.values()].map((r) => {
    const top = Object.entries(r.weapons).sort((a, b) => b[1] - a[1])[0];
    return {
      id: r.id,
      type: r.type,
      kills: r.kills,
      knocks: r.knocks,
      deaths: r.deaths,
      timesKnocked: r.timesKnocked,
      selfElims: r.selfElims,
      kd: r.deaths ? r.kills / r.deaths : r.kills,
      avgDistance: r.distances.length
        ? Math.round((r.distances.reduce((a, b) => a + b, 0) / r.distances.length) * 10) / 10
        : null,
      longest: r.distances.length ? Math.max(...r.distances) : null,
      topWeaponCode: top ? Number(top[0]) : null,
      diedAtMs: r.diedAtMs,
      survivedToEnd: r.diedAtMs == null,
      killedByCode: r.killedByCode,
    };
  });
  rows.sort((a, b) => b.kills - a.kills || b.knocks - a.knocks);
  return { players: rows, eliminations: sorted };
}

/**
 * Build the record that gets stored.
 *
 * Nothing here depends on knowing which account is yours, because on a first
 * import it is not known yet. The killfeed is kept in a compact form (player
 * indexes rather than 32-character ids) so that anything account-specific can
 * be worked out later, and re-worked out if the account changes.
 */
function buildStoredMatch(parsed) {
  const { players, eliminations } = summarise(parsed);
  const index = new Map(players.map((p, i) => [p.id, i]));
  const elims = eliminations.map((e) => [
    e.timeMs,
    index.has(e.eliminatorId) ? index.get(e.eliminatorId) : -1,
    index.has(e.eliminatedId) ? index.get(e.eliminatedId) : -1,
    e.gunType,
    e.knocked ? 1 : 0,
    e.isSelfElim ? 1 : 0,
    e.distanceM,
  ]);
  return {
    replayId: parsed.replayId,
    fileName: parsed.fileName,
    recordedAt: parsed.recordedAt,
    lengthMs: parsed.lengthMs,
    fortniteVersion: parsed.fortniteVersion,
    mode: parsed.mode,
    mapName: parsed.mapName,
    hasStats: parsed.hasStats,
    stats: parsed.stats,
    placement: parsed.placement,
    totalPlayers: parsed.totalPlayers,
    players,
    elims,
  };
}

/** Decode the compact killfeed back into ids. */
function matchElims(match) {
  const ids = match.players.map((p) => p.id);
  return (match.elims || []).map(([timeMs, ki, vi, gunType, knocked, self, distanceM]) => ({
    timeMs,
    eliminatorId: ki >= 0 ? ids[ki] : null,
    eliminatedId: vi >= 0 ? ids[vi] : null,
    gunType,
    knocked: !!knocked,
    isSelfElim: !!self,
    distanceM,
  }));
}

/** Knock-to-finish pairs. Squads trade these constantly; opponents do not. */
function chainsFor(match, accountId) {
  const chains = {};
  if (!accountId) return chains;
  const elims = matchElims(match);
  for (let i = 0; i < elims.length; i++) {
    const first = elims[i];
    if (first.isSelfElim || !first.knocked) continue;
    for (let j = i + 1; j < elims.length; j++) {
      const second = elims[j];
      if (second.timeMs - first.timeMs > 30000) break;
      if (second.isSelfElim || second.knocked) continue;
      if (second.eliminatedId !== first.eliminatedId) continue;
      const a = first.eliminatorId;
      const b = second.eliminatorId;
      if (a === accountId && b && b !== accountId) chains[b] = (chains[b] || 0) + 1;
      else if (b === accountId && a && a !== accountId) chains[a] = (chains[a] || 0) + 1;
    }
  }
  return chains;
}

/** Everyone you traded an elimination with in this match. Never teammates. */
function tradedFor(match, accountId) {
  const out = new Set();
  if (!accountId) return out;
  for (const e of matchElims(match)) {
    if (e.isSelfElim) continue;
    if (e.eliminatorId === accountId && e.eliminatedId) out.add(e.eliminatedId);
    if (e.eliminatedId === accountId && e.eliminatorId) out.add(e.eliminatorId);
  }
  return out;
}

/** Your own kills in a match, with the detail the weapon naming needs. */
function myKillsFor(match, accountId) {
  if (!accountId) return [];
  return matchElims(match)
    .filter((e) => e.eliminatorId === accountId && !e.knocked && !e.isSelfElim)
    .map((e) => ({ gunType: e.gunType, distanceM: e.distanceM }));
}

/* ------------------------------------------------------ account detection */

function currentAccount() {
  const stored = db.read(KEYS.account, null);
  if (stored) return stored;
  return detectAccount().id;
}

/**
 * Work out which account is you.
 *
 * Replays never say. Two signals: your killfeed kill count should equal the
 * eliminations figure in that match's own stats block, and you appear in every
 * one of your replays while nobody else does. Agreement is ranked first because
 * it works on a single upload.
 */
function detectAccount() {
  const matches = db.matches();
  const presence = {};
  const agreement = {};
  for (const match of matches) {
    for (const p of match.players) {
      presence[p.id] = (presence[p.id] || 0) + 1;
      // Zero eliminations agrees with every player who got none, so it says nothing.
      if (match.hasStats && match.stats && match.stats.eliminations > 0 && p.kills === match.stats.eliminations) {
        agreement[p.id] = (agreement[p.id] || 0) + 1;
      }
    }
  }
  const ranked = Object.keys(presence)
    .filter((id) => id !== "Bot")
    .sort(
      (a, b) => (agreement[b] || 0) - (agreement[a] || 0) || presence[b] - presence[a] || a.localeCompare(b)
    );
  const best = ranked[0] || null;
  const runnerUp = ranked[1];
  const decisive =
    best &&
    ((agreement[best] || 0) >= Math.max(1, (agreement[runnerUp] || 0) * 2) ||
      presence[best] >= Math.max(3, (presence[runnerUp] || 0) * 2));
  return {
    id: best,
    confident: !!decisive,
    candidates: ranked.slice(0, 5).map((id) => ({
      id,
      matches: presence[id],
      agreement: agreement[id] || 0,
    })),
  };
}

/* -------------------------------------------------------- squad detection */

function squadCandidatesFor(match, accountId) {
  if (!accountId) return [];
  const squad = db.squad();
  const enemies = tradedFor(match, accountId);
  const present = new Set(match.players.map((p) => p.id));
  const chainCounts = chainsFor(match, accountId);

  const together = {};
  const rivalry = {};
  for (const m of db.matches()) {
    for (const p of m.players) if (p.id !== accountId) together[p.id] = (together[p.id] || 0) + 1;
    for (const id of tradedFor(m, accountId)) rivalry[id] = (rivalry[id] || 0) + 1;
  }

  const out = [];
  for (const id of present) {
    if (id === accountId || id === "Bot" || squad.has(id) || enemies.has(id)) continue;
    const chains = chainCounts[id] || 0;
    // Trading eliminations counts against a candidate but does not rule them
    // out: a regular squadmate turns up as an opponent in some other lobby.
    const score = (together[id] || 0) + 4 * chains - 2 * (rivalry[id] || 0);
    if (score < 2) continue;
    out.push({ id, matchesTogether: together[id] || 0, chains, traded: rivalry[id] || 0, score });
  }
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return out.slice(0, 6);
}

/* ----------------------------------------------------------- name lookup */

const LOOKUP_ENDPOINT = "https://prod.api-fortnite.com/api/v1/account/";

async function lookupOne(accountId, apiKey) {
  const response = await fetch(LOOKUP_ENDPOINT + accountId.toLowerCase(), {
    headers: { "x-api-key": apiKey },
  });
  if (response.status === 429) throw new Error("throttled");
  if (response.status === 401 || response.status === 403) throw new Error("bad-key");
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return (body && (body.displayName || body.display_name || body.name)) || null;
}

/** Resolve ids, keeping whatever succeeds if the service starts throttling. */
async function lookupNames(ids, onProgress) {
  const apiKey = db.read(KEYS.apiKey, "");
  if (!apiKey) throw new Error("No API key set. Add one in Settings to look up names.");
  const names = db.names();
  const pending = ids.filter((id) => id && id !== "Bot" && !(id in names));
  let resolved = 0;
  let throttled = false;

  for (let i = 0; i < pending.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 900));
    let name;
    try {
      name = await lookupOne(pending[i], apiKey);
    } catch (error) {
      if (error.message === "bad-key") throw new Error("The lookup service rejected that API key.");
      // One backoff, then stop and keep everything already resolved.
      await new Promise((r) => setTimeout(r, 6000));
      try {
        name = await lookupOne(pending[i], apiKey);
      } catch {
        throttled = true;
        break;
      }
    }
    names[pending[i]] = name || null;
    if (name) resolved++;
    if (onProgress) onProgress(i + 1, pending.length, resolved);
  }
  db.saveNames(names);
  return { resolved, attempted: pending.length, remaining: pending.length - resolved, throttled };
}

function displayNameFor(id, type) {
  const names = db.names();
  if (names[id]) return names[id];
  if (type === "named_bot") return id;
  return null;
}

/* ------------------------------------------------------------- backups */

const BACKUP_FORMAT = "fortreplays-backup";

/** Everything worth keeping, except the API key, as one JSON-ready object. */
function buildBackup() {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    matches: db.matches(),
    squad: [...db.squad()],
    names: db.names(),
    weapons: db.weapons(),
    account: db.read(KEYS.account, null),
  };
}

/** Merge a backup into what is stored. Existing matches are never overwritten. */
async function restoreBackup(data) {
  if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.matches)) {
    throw new Error("That file is not a FortReplays backup.");
  }
  const known = new Set(db.matches().map((m) => m.replayId));
  const fresh = data.matches.filter(
    (m) => m && typeof m.replayId === "string" && Array.isArray(m.players) && !known.has(m.replayId)
  );
  if (!(await db.addMatches(fresh))) throw new Error("Browser storage is full.");

  const squad = db.squad();
  (Array.isArray(data.squad) ? data.squad : []).forEach((id) => typeof id === "string" && squad.add(id));
  db.saveSquad(squad);
  if (data.names && typeof data.names === "object") db.saveNames({ ...data.names, ...db.names() });
  if (data.weapons && typeof data.weapons === "object") db.saveWeapons({ ...data.weapons, ...db.weapons() });
  if (typeof data.account === "string" && !db.read(KEYS.account, null)) db.write(KEYS.account, data.account);
  return { added: fresh.length, skipped: data.matches.length - fresh.length };
}

/* -------------------------------------------------------- career stats */

const isWin = (m) => m.placement === 1;
const isTop10 = (m) => m.placement != null && m.placement <= 10;
const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) || 0), 0);
const avg = (list, pick) => (list.length ? sum(list, pick) / list.length : null);

/** Your elimination detail for one match: kills, knocks and longest kill. */
function myMatchLine(match, accountId) {
  const me = accountId ? match.players.find((p) => p.id === accountId) : null;
  return {
    kills: match.hasStats ? match.stats.eliminations : me ? me.kills : 0,
    knocks: me ? me.knocks : 0,
    longest: me ? me.longest : null,
  };
}

/** Totals and averages over a set of matches, for the Overview screen. */
function careerStats(matches, accountId) {
  const withStats = matches.filter((m) => m.hasStats && m.stats);
  const placed = matches.filter((m) => m.placement != null);
  const lines = matches.map((m) => ({ match: m, ...myMatchLine(m, accountId) }));
  const best = (list, pick) =>
    list.reduce((top, item) => (pick(item) > (top ? pick(top) : -Infinity) ? item : top), null);

  const totalDamage = sum(withStats, (m) => m.stats.totalDamage);
  const minutesWithStats = sum(withStats, (m) => m.lengthMs) / 60000;
  return {
    matches: matches.length,
    withStats: withStats.length,
    wins: matches.filter(isWin).length,
    top10: matches.filter(isTop10).length,
    placed: placed.length,
    avgPlacement: avg(placed, (m) => m.placement),
    kills: sum(lines, (l) => l.kills),
    knocks: sum(lines, (l) => l.knocks),
    totalDamage,
    avgDamage: avg(withStats, (m) => m.stats.totalDamage),
    damagePerMinute: minutesWithStats ? totalDamage / minutesWithStats : null,
    avgAccuracy: avg(
      withStats.filter((m) => m.stats.accuracy > 0),
      (m) => m.stats.accuracy
    ),
    damageTaken: sum(withStats, (m) => m.stats.damageTaken),
    playedMs: sum(matches, (m) => m.lengthMs),
    records: {
      damage: best(withStats, (m) => m.stats.totalDamage),
      kills: best(lines, (l) => l.kills),
      longest: best(
        lines.filter((l) => l.longest != null),
        (l) => l.longest
      ),
      placement: best(placed, (m) => -m.placement),
      survived: best(matches, (m) => m.lengthMs || 0),
    },
  };
}

/** Matches grouped by local calendar day, newest first. */
function sessionsOf(matches) {
  const byDay = new Map();
  for (const m of matches) {
    if (!m.recordedAt) continue;
    const d = new Date(m.recordedAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, { day: m.recordedAt, matches: [] });
    byDay.get(key).matches.push(m);
  }
  return [...byDay.values()].sort((a, b) => new Date(b.day) - new Date(a.day));
}

/** Newest first, the order every list in the app uses. */
function sortedMatches() {
  return db
    .matches()
    .slice()
    .sort((a, b) => new Date(b.recordedAt || 0) - new Date(a.recordedAt || 0));
}
