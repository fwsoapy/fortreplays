/* Fortnite .replay parsing, in the browser.
 *
 * A direct port of the Python parser: AES-256-ECB decryption, the Unreal binary
 * reader, and the event chunks that carry match results. No dependencies, so
 * the whole thing runs from a file:// page with nothing installed.
 */

/* ---------------------------------------------------------------- AES-256 */

const SBOX = (() => {
  const hex =
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0" +
    "b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275" +
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf" +
    "d0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2" +
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb" +
    "e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08" +
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e" +
    "e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16";
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
})();

const INV_SBOX = (() => {
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[SBOX[i]] = i;
  return out;
})();

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c];

function gmul(a, b) {
  let result = 0;
  while (b) {
    if (b & 1) result ^= a;
    a = a & 0x80 ? ((a << 1) ^ 0x1b) & 0xff : (a << 1) & 0xff;
    b >>= 1;
  }
  return result;
}

// Td0..Td3 fold InvSubBytes and InvMixColumns into one lookup each.
const [TD0, TD1, TD2, TD3] = (() => {
  const td0 = new Uint32Array(256);
  for (let x = 0; x < 256; x++) {
    const s = INV_SBOX[x];
    td0[x] =
      ((gmul(s, 0x0e) << 24) | (gmul(s, 0x09) << 16) | (gmul(s, 0x0d) << 8) | gmul(s, 0x0b)) >>> 0;
  }
  const rot = (w, n) => ((w >>> n) | (w << (32 - n))) >>> 0;
  const make = (n) => Uint32Array.from(td0, (w) => rot(w, n));
  return [td0, make(8), make(16), make(24)];
})();

function expandKey(key) {
  const nk = 8;
  const nr = 14;
  const w = new Uint32Array(4 * (nr + 1));
  for (let i = 0; i < nk; i++) {
    w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  }
  for (let i = nk; i < w.length; i++) {
    let t = w[i - 1];
    if (i % nk === 0) {
      t = ((t << 8) | (t >>> 24)) >>> 0;
      t =
        ((SBOX[(t >>> 24) & 0xff] << 24) |
          (SBOX[(t >>> 16) & 0xff] << 16) |
          (SBOX[(t >>> 8) & 0xff] << 8) |
          SBOX[t & 0xff]) >>> 0;
      t = (t ^ (RCON[i / nk - 1] << 24)) >>> 0;
    } else if (i % nk === 4) {
      t =
        ((SBOX[(t >>> 24) & 0xff] << 24) |
          (SBOX[(t >>> 16) & 0xff] << 16) |
          (SBOX[(t >>> 8) & 0xff] << 8) |
          SBOX[t & 0xff]) >>> 0;
    }
    w[i] = (w[i - nk] ^ t) >>> 0;
  }
  return w;
}

/** Key schedule for the equivalent inverse cipher. */
function decryptSchedule(key) {
  const nr = 14;
  const enc = expandKey(key);
  const rk = new Uint32Array(enc.length);
  for (let r = 0; r <= nr; r++) {
    for (let c = 0; c < 4; c++) rk[4 * r + c] = enc[4 * (nr - r) + c];
  }
  for (let i = 4; i < 4 * nr; i++) {
    const w = rk[i];
    rk[i] =
      (TD0[SBOX[(w >>> 24) & 0xff]] ^
        TD1[SBOX[(w >>> 16) & 0xff]] ^
        TD2[SBOX[(w >>> 8) & 0xff]] ^
        TD3[SBOX[w & 0xff]]) >>> 0;
  }
  return rk;
}

function aesDecryptEcb(data, key) {
  const blocks = Math.floor(data.length / 16);
  const out = new Uint8Array(blocks * 16);
  const rk = decryptSchedule(key);
  const nr = 14;

  for (let b = 0; b < blocks; b++) {
    const o = b * 16;
    let s0 = (((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) ^ rk[0]) >>> 0;
    let s1 = (((data[o + 4] << 24) | (data[o + 5] << 16) | (data[o + 6] << 8) | data[o + 7]) ^ rk[1]) >>> 0;
    let s2 = (((data[o + 8] << 24) | (data[o + 9] << 16) | (data[o + 10] << 8) | data[o + 11]) ^ rk[2]) >>> 0;
    let s3 = (((data[o + 12] << 24) | (data[o + 13] << 16) | (data[o + 14] << 8) | data[o + 15]) ^ rk[3]) >>> 0;

    let k = 4;
    for (let round = 1; round < nr; round++) {
      const t0 = (TD0[s0 >>> 24] ^ TD1[(s3 >>> 16) & 0xff] ^ TD2[(s2 >>> 8) & 0xff] ^ TD3[s1 & 0xff] ^ rk[k]) >>> 0;
      const t1 = (TD0[s1 >>> 24] ^ TD1[(s0 >>> 16) & 0xff] ^ TD2[(s3 >>> 8) & 0xff] ^ TD3[s2 & 0xff] ^ rk[k + 1]) >>> 0;
      const t2 = (TD0[s2 >>> 24] ^ TD1[(s1 >>> 16) & 0xff] ^ TD2[(s0 >>> 8) & 0xff] ^ TD3[s3 & 0xff] ^ rk[k + 2]) >>> 0;
      const t3 = (TD0[s3 >>> 24] ^ TD1[(s2 >>> 16) & 0xff] ^ TD2[(s1 >>> 8) & 0xff] ^ TD3[s0 & 0xff] ^ rk[k + 3]) >>> 0;
      s0 = t0; s1 = t1; s2 = t2; s3 = t3;
      k += 4;
    }

    out[o] = INV_SBOX[s0 >>> 24] ^ ((rk[k] >>> 24) & 0xff);
    out[o + 1] = INV_SBOX[(s3 >>> 16) & 0xff] ^ ((rk[k] >>> 16) & 0xff);
    out[o + 2] = INV_SBOX[(s2 >>> 8) & 0xff] ^ ((rk[k] >>> 8) & 0xff);
    out[o + 3] = INV_SBOX[s1 & 0xff] ^ (rk[k] & 0xff);
    out[o + 4] = INV_SBOX[s1 >>> 24] ^ ((rk[k + 1] >>> 24) & 0xff);
    out[o + 5] = INV_SBOX[(s0 >>> 16) & 0xff] ^ ((rk[k + 1] >>> 16) & 0xff);
    out[o + 6] = INV_SBOX[(s3 >>> 8) & 0xff] ^ ((rk[k + 1] >>> 8) & 0xff);
    out[o + 7] = INV_SBOX[s2 & 0xff] ^ (rk[k + 1] & 0xff);
    out[o + 8] = INV_SBOX[s2 >>> 24] ^ ((rk[k + 2] >>> 24) & 0xff);
    out[o + 9] = INV_SBOX[(s1 >>> 16) & 0xff] ^ ((rk[k + 2] >>> 16) & 0xff);
    out[o + 10] = INV_SBOX[(s0 >>> 8) & 0xff] ^ ((rk[k + 2] >>> 8) & 0xff);
    out[o + 11] = INV_SBOX[s3 & 0xff] ^ (rk[k + 2] & 0xff);
    out[o + 12] = INV_SBOX[s3 >>> 24] ^ ((rk[k + 3] >>> 24) & 0xff);
    out[o + 13] = INV_SBOX[(s2 >>> 16) & 0xff] ^ ((rk[k + 3] >>> 16) & 0xff);
    out[o + 14] = INV_SBOX[(s1 >>> 8) & 0xff] ^ ((rk[k + 3] >>> 8) & 0xff);
    out[o + 15] = INV_SBOX[s0 & 0xff] ^ (rk[k + 3] & 0xff);
  }
  return out;
}

/** FIPS-197 AES-256 vector. Throws if the implementation is wrong. */
function aesSelfTest() {
  const key = Uint8Array.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f".match(/../g),
    (h) => parseInt(h, 16)
  );
  const cipher = Uint8Array.from("8ea2b7ca516745bfeafc49904b496089".match(/../g), (h) => parseInt(h, 16));
  const want = "00112233445566778899aabbccddeeff";
  const got = [...aesDecryptEcb(cipher, key)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (got !== want) throw new Error("AES self-test failed: " + got);
}

/* ------------------------------------------------- Unreal binary reading */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

class Archive {
  constructor(bytes, engineNetworkVersion = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    this.engineNetworkVersion = engineNetworkVersion;
  }
  get remaining() {
    return this.bytes.length - this.pos;
  }
  need(n) {
    if (this.pos + n > this.bytes.length) throw new RangeError("read past end of buffer");
  }
  skip(n) {
    this.need(n);
    this.pos += n;
  }
  seek(p) {
    this.pos = p;
  }
  readUint8() {
    this.need(1);
    return this.bytes[this.pos++];
  }
  readUint16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  readUint32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  readInt32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  readFloat() {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  readDouble() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  readBool32() {
    return this.readUint32() !== 0;
  }
  readBytes(n) {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** FString: length prefixed, negative length means UTF-16, includes a NUL. */
  readString() {
    const length = this.readInt32();
    if (length === 0) return "";
    if (length < 0) {
      const raw = this.readBytes(-length * 2);
      let s = "";
      for (let i = 0; i < raw.length - 2; i += 2) s += String.fromCharCode(raw[i] | (raw[i + 1] << 8));
      return s;
    }
    const raw = this.readBytes(length);
    return new TextDecoder("utf-8").decode(raw.subarray(0, raw.length - 1));
  }
  /** Lower case hex, which is Epic's canonical form for account ids. */
  readGuid(size = 16) {
    const raw = this.readBytes(size);
    let s = "";
    for (let i = 0; i < raw.length; i++) s += HEX[raw[i]];
    return s;
  }
  /** .NET DateTime.FromBinary: top two bits are a kind flag, the rest are ticks. */
  readDateTime() {
    this.need(8);
    const raw = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    const ticks = raw & 0x3fffffffffffffffn;
    const ms = Number(ticks / 10000n) - 62135596800000;
    const date = new Date(ms);
    return isNaN(date.getTime()) ? null : date;
  }
}

/* ------------------------------------------------------------ the parser */

const FILE_MAGIC = 0x1ca2e27f;
const NETWORK_MAGIC = 0x2cf5a13d;
const CHUNK_HEADER = 0;
const CHUNK_EVENT = 3;

const MODE_BY_ROOT = [
  ["CreativeRoot", "Creative"],
  ["BlitzRoot", "Blitz Royale"],
  ["BRRoot", "Battle Royale"],
  ["STWRoot", "Save the World"],
];

const MAP_NAMES = {
  Hera_V2_Terrain: "Hera",
  Hera_Terrain: "Hera",
  Athena_Empty: "Athena",
  Athena_Terrain: "Athena",
  VKPlay_EmptyOcean_VolumeSupport: "Creative island",
};

const PLAYER_TYPE = { 0x03: "bot", 0x10: "named_bot", 0x11: "player" };

function parseReplay(buffer, fileName) {
  const bytes = new Uint8Array(buffer);
  const ar = new Archive(bytes);

  if (ar.readUint32() !== FILE_MAGIC) throw new Error("That is not a Fortnite replay file.");

  const info = {};
  info.fileVersion = ar.readUint32();
  if (info.fileVersion >= 7) ar.skip(ar.readInt32() * 20);
  info.lengthMs = ar.readUint32();
  ar.readUint32(); // network version
  info.changelist = ar.readUint32();
  info.friendlyName = ar.readString().trim();
  info.isLive = ar.readBool32();
  if (info.fileVersion >= 4) info.recordedAt = ar.readDateTime();
  if (info.fileVersion >= 5) info.isCompressed = ar.readBool32();
  if (info.fileVersion >= 6) {
    info.isEncrypted = ar.readBool32();
    info.key = ar.readBytes(ar.readUint32());
  }
  if (info.isEncrypted && (!info.key || !info.key.length)) {
    throw new Error("This replay is encrypted but carries no key.");
  }

  const header = { engineNetworkVersion: 0, guid: "", branch: "", levelName: "", gameSpecificData: [] };
  const events = [];

  while (ar.remaining >= 8) {
    const chunkType = ar.readUint32();
    const chunkSize = ar.readInt32();
    const offset = ar.pos;
    if (chunkSize <= 0 || offset + chunkSize > bytes.length) break;

    if (chunkType === CHUNK_HEADER) {
      try {
        readHeaderChunk(new Archive(bytes.subarray(offset, offset + chunkSize)), header);
      } catch (e) {
        /* a damaged header costs the mode, nothing else */
      }
    } else if (chunkType === CHUNK_EVENT) {
      try {
        ar.readString(); // event id
        const group = ar.readString();
        const metadata = ar.readString();
        const startTime = ar.readUint32();
        ar.readUint32(); // end time
        const size = ar.readInt32();
        if (size > 0 && size <= chunkSize) {
          events.push({ group, metadata, startTime, offset: ar.pos, size });
        }
      } catch (e) {
        /* skip an unreadable event header */
      }
    }
    ar.seek(offset + chunkSize);
  }

  const payload = (event) => {
    let raw = bytes.subarray(event.offset, event.offset + event.size);
    if (info.isEncrypted) raw = aesDecryptEcb(raw, info.key);
    return new Archive(raw, header.engineNetworkVersion);
  };

  let stats = null;
  let placement = null;
  let totalPlayers = null;
  const eliminations = [];

  for (const event of events) {
    try {
      if (event.metadata === "AthenaMatchStats") {
        const a = payload(event);
        a.skip(4);
        const candidate = {
          accuracy: a.readFloat(),
          assists: a.readUint32(),
          eliminations: a.readUint32(),
          weaponDamage: a.readUint32(),
          otherDamage: a.readUint32(),
          revives: a.readUint32(),
          damageTaken: a.readUint32(),
          damageToStructures: a.readUint32(),
          materialsGathered: a.readUint32(),
          materialsUsed: a.readUint32(),
          totalTraveled: a.readUint32(),
        };
        candidate.totalDamage = candidate.weaponDamage + candidate.otherDamage;
        // Prefer the most populated block: some replays write an empty one first.
        if (!stats || statsWeight(candidate) > statsWeight(stats)) stats = candidate;
      } else if (event.metadata === "AthenaMatchTeamStats") {
        const a = payload(event);
        a.skip(4);
        placement = a.readUint32();
        totalPlayers = a.readUint32();
      } else if (event.group === "playerElim") {
        const elim = parseElimination(payload(event), event.startTime);
        if (elim) eliminations.push(elim);
      }
    } catch (e) {
      /* one unreadable event should not lose the rest of the match */
    }
  }

  // A block of all zeros is a placeholder. One with only damage taken or
  // distance filled in is a real, quiet match and is kept as such.
  const statsEmpty = !stats || statsWeight(stats) === 0;

  return {
    replayId: header.guid || `${info.lengthMs}-${info.recordedAt ? info.recordedAt.getTime() : 0}`,
    fileName,
    recordedAt: info.recordedAt ? info.recordedAt.toISOString() : null,
    lengthMs: info.lengthMs,
    fortniteVersion: (header.branch.match(/\+\+Fortnite\+Release-(\d+\.\d+)/) || [])[1] || "",
    mode: modeFromRoots(header.gameSpecificData),
    mapName: mapNameFrom(header.levelName),
    hasStats: !statsEmpty,
    stats: statsEmpty ? null : stats,
    placement,
    totalPlayers,
    eliminations,
  };
}

/** How many stats fields are filled in. Zero means a placeholder block. */
function statsWeight(s) {
  return [
    s.accuracy,
    s.assists,
    s.eliminations,
    s.totalDamage,
    s.revives,
    s.damageTaken,
    s.damageToStructures,
    s.materialsGathered,
    s.materialsUsed,
    s.totalTraveled > 1000 ? s.totalTraveled : 0, // a few metres is spawning, not playing
  ].filter((v) => v > 0).length;
}

function readHeaderChunk(a, header) {
  if (a.readUint32() !== NETWORK_MAGIC) throw new Error("bad network magic");
  const networkVersion = a.readUint32();
  if (networkVersion >= 19) a.skip(a.readInt32() * 20);
  a.readUint32(); // checksum
  header.engineNetworkVersion = a.readUint32();
  a.readUint32(); // game protocol version
  if (networkVersion >= 12) header.guid = a.readGuid();
  if (networkVersion >= 11) {
    a.readUint16();
    a.readUint16();
    a.readUint16();
    a.readUint32();
    header.branch = a.readString();
  } else {
    a.readUint32();
  }
  // The tail identifies the mode. Failing here loses that and nothing else.
  if (networkVersion >= 18) a.skip(12);
  const levelCount = a.readInt32();
  for (let i = 0; i < levelCount; i++) {
    const name = a.readString();
    a.readUint32();
    if (i === 0) header.levelName = name;
  }
  if (networkVersion >= 9) a.readUint32();
  const dataCount = a.readInt32();
  for (let i = 0; i < dataCount; i++) header.gameSpecificData.push(a.readString());
}

/** Read one FTransform and return just its location. */
function readTransformLocation(a) {
  if (a.engineNetworkVersion >= 34) {
    a.skip(32); // rotation quaternion, double precision
    const loc = [a.readDouble(), a.readDouble(), a.readDouble()];
    a.skip(24); // scale
    return loc;
  }
  a.skip(16);
  const loc = [a.readFloat(), a.readFloat(), a.readFloat()];
  a.skip(12);
  return loc;
}

function readElimPlayer(a, version) {
  if (version < 6) return { id: a.readString(), type: "player" };
  const raw = a.readUint8();
  const type = PLAYER_TYPE[raw];
  if (type === "bot") return { id: "Bot", type };
  if (type === "named_bot") return { id: a.readString(), type };
  if (type === "player") return { id: a.readGuid(a.readUint8()), type };
  throw new Error("unknown player type " + raw);
}

function parseElimination(a, timeMs) {
  const version = a.readInt32();
  let eliminatedPos = null;
  let eliminatorPos = null;
  if (version >= 3) {
    a.skip(1);
    if (version >= 6) eliminatedPos = readTransformLocation(a);
    eliminatorPos = readTransformLocation(a);
  }
  const eliminated = readElimPlayer(a, version);
  const eliminator = readElimPlayer(a, version);
  const gunType = a.readUint8();
  const knocked = a.readBool32();

  let distance = null;
  const live = (p) => p && p.some((v) => v !== 0);
  if (live(eliminatedPos) && live(eliminatorPos)) {
    const d = Math.hypot(
      eliminatedPos[0] - eliminatorPos[0],
      eliminatedPos[1] - eliminatorPos[1],
      eliminatedPos[2] - eliminatorPos[2]
    );
    distance = Math.round((d / 100) * 10) / 10;
  }

  return {
    timeMs,
    eliminatedId: eliminated.id,
    eliminatedType: eliminated.type,
    eliminatorId: eliminator.id,
    eliminatorType: eliminator.type,
    gunType,
    knocked,
    isSelfElim: eliminated.id === eliminator.id,
    distanceM: distance,
  };
}

function modeFromRoots(gameSpecificData) {
  const entry = gameSpecificData.find((d) => d.startsWith("VerseURI="));
  if (!entry) return "Unknown";
  const roots = entry
    .slice("VerseURI=".length)
    .split("+")
    .filter((p) => p.endsWith("Root"))
    .map((p) => p.split("/").pop());
  for (const [root, label] of MODE_BY_ROOT) if (roots.includes(root)) return label;
  return "Unknown";
}

function mapNameFrom(levelName) {
  if (!levelName) return "";
  const leaf = levelName.split("/").pop();
  if (MAP_NAMES[leaf]) return MAP_NAMES[leaf];
  // "Delilah_Terrain" reads as "Delilah": the suffixes are engine naming, not the map.
  const tidy = leaf.replace(/_(V\d+_)?Terrain$/i, "").replace(/_/g, " ").trim();
  return tidy || leaf;
}
