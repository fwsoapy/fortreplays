import { fmt } from "./format.js";

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");

const state = {
  route: "matches",
  matchId: null,
  showEveryone: false,
};

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Bad response from ${path}`);
  }
  if (!response.ok) throw new Error(data.error || `${response.status} on ${path}`);
  return data;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function tile(label, value, sub) {
  return `<div class="tile">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ""}
  </div>`;
}

function playerLabel(p) {
  if (p.is_me) return "You";
  return p.display_name || (p.is_bot ? "Bot" : p.player_id.slice(0, 8));
}

// ------------------------------------------------------------------- matches

async function renderMatches() {
  const data = await api("/api/matches");
  const matches = data.matches;

  if (!matches.length) {
    view.innerHTML = `<div class="empty">
        <h2>No replays yet</h2>
        <p>Upload a .replay file and your squad's stats will show up here.</p>
        <button class="btn primary" id="go-import" style="margin-top:14px">Upload a replay</button>
      </div>`;
    view.querySelector("#go-import").addEventListener("click", () => go("import"));
    return;
  }

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Matches</h1><p>${matches.length} replay(s). Open one to see you and your squad.</p></div>
      <button class="btn primary" id="add">Upload a replay</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Played</th><th>Mode</th><th class="num">Length</th>
          <th class="num">Your damage</th><th class="num">Your elims</th>
          <th class="num">Accuracy</th><th class="num">Place</th>
        </tr></thead>
        <tbody>
          ${matches
            .map(
              (m) => `<tr class="clickable ${m.has_stats ? "" : "dim"}" data-match="${m.replay_id}">
            <td><span class="stack"><strong>${fmt.time(m.recorded_at)}</strong>
              <span>${fmt.dayLabel(m.recorded_at)}</span></span></td>
            <td><span class="stack"><strong>${escapeHtml(m.mode || "Unknown")}</strong>
              ${m.map_name ? `<span>${escapeHtml(m.map_name)}</span>` : ""}</span></td>
            <td class="num">${fmt.duration(m.length_ms)}</td>
            <td class="num">${m.has_stats ? fmt.int(m.total_damage) : `<span class="tag">no stats</span>`}</td>
            <td class="num">${m.has_stats ? fmt.int(m.eliminations) : "-"}</td>
            <td class="num">${m.has_stats && m.accuracy != null ? fmt.pct(m.accuracy, 0) : "-"}</td>
            <td class="num">${
              m.placement === 1
                ? `<span class="tag win">Win</span>`
                : m.placement
                ? "#" + m.placement
                : `<span style="color:var(--text-muted)">-</span>`
            }</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;

  view.querySelector("#add").addEventListener("click", () => go("import"));
  view.querySelectorAll("[data-match]").forEach((row) =>
    row.addEventListener("click", () => go("match", row.dataset.match))
  );
}

// -------------------------------------------------------------- match detail

async function renderMatch(id) {
  const m = await api(`/api/match/${encodeURIComponent(id)}`);
  const ratio = m.damage_taken ? m.total_damage / m.damage_taken : null;
  const squad = m.squad || [];
  const candidates = m.squad_candidates || [];
  const everyone = (m.players || []).filter((p) => !p.is_me && !p.is_teammate);
  const me = (m.players || []).find((p) => p.is_me);

  // One table for the whole squad, you first. Your own stats always come from
  // this replay; a teammate's come from theirs once it has been uploaded.
  const everyoneOnMyTeam = [
    ...(me ? [{ ...me, own_stats: m.has_stats ? myStatsBlock(m) : null }] : []),
    ...squad,
  ];
  const withStats = everyoneOnMyTeam.filter((p) => p.own_stats).length;
  const missing = everyoneOnMyTeam.length - withStats;

  view.innerHTML = `
    <div class="view-head">
      <div>
        <button class="btn quiet" id="back" style="margin-bottom:8px">Back to matches</button>
        <h1>${escapeHtml(m.mode || "Match")}${m.map_name ? ` · ${escapeHtml(m.map_name)}` : ""}</h1>
        <p>${fmt.dayLabel(m.recorded_at)} at ${fmt.time(m.recorded_at)} ·
           ${fmt.duration(m.length_ms)}
           ${m.placement ? ` · finished #${m.placement}${m.total_players ? " of " + m.total_players : ""}` : ""}</p>
      </div>
      ${
        (m.players || []).some((p) => !p.display_name && !p.is_bot)
          ? `<button class="btn" id="lookup-names">Look up missing names</button>`
          : ""
      }
    </div>
    <div id="lookup-result"></div>

    ${
      m.has_stats
        ? `<h2 style="margin-bottom:10px">Your stats</h2>
    <div class="tiles">
      ${tile("Damage dealt", fmt.int(m.total_damage), `${fmt.int(m.weapon_damage)} weapon, ${fmt.int(m.other_damage)} other`)}
      ${tile("Damage taken", fmt.int(m.damage_taken), ratio ? `ratio ${fmt.dec(ratio, 2)}` : "")}
      ${tile("Eliminations", fmt.int(m.eliminations), `${fmt.int(m.assists)} assists`)}
      ${tile("Accuracy", fmt.pct(m.accuracy, 1), me ? `${me.knocks} knock(s)` : "")}
      ${tile("Damage per minute", fmt.int(m.total_damage / (m.length_ms / 60000)), "")}
      ${tile("Structure damage", fmt.int(m.damage_to_structures), "")}
      ${tile("Materials used", fmt.int(m.materials_used), `${fmt.int(m.materials_gathered)} gathered`)}
      ${tile("Distance", `${fmt.dec(m.total_traveled / 100000, 2)} km`, "")}
      ${tile("Revives", fmt.int(m.revives), "teammates picked up")}
    </div>`
        : `<p class="note" style="margin-bottom:18px">This replay has no match stats block, so your
           damage and accuracy are not available for it. Squad eliminations below still work.</p>`
    }

    <div class="card" style="margin-bottom:14px">
      <div class="card-head">
        <div><h2>Your squad</h2>
          <p>${
            squad.length
              ? `You and ${squad.length} teammate(s), from the match's own team number.
                 ${withStats} of ${withStats + missing} have full stats.`
              : "No teammates in this match"
          }</p></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Player</th>
            <th class="num">Damage</th><th class="num">Taken</th><th class="num">Accuracy</th>
            <th class="num">Elims</th><th class="num">Knocks</th>
            <th class="num">Deaths</th><th class="num">Mats used</th>
            <th class="num">Longest</th><th class="num">First death</th>
          </tr></thead>
          <tbody>
            ${squadRows(everyoneOnMyTeam)}
            ${squadTotalRow(everyoneOnMyTeam)}
          </tbody>
        </table>
      </div>
      ${
        squad.some((p) => !p.own_stats)
          ? `<div class="add-replay" id="teammate-drop">
              <strong>Add a teammate's replay to this match</strong>
              <span>Drop their .replay file here, or
                <a href="#" id="teammate-pick">browse</a>.
                A replay only records damage for whoever made it, so theirs fills in their row.</span>
              <input type="file" id="teammate-input" multiple accept=".replay" hidden>
            </div>`
          : ""
      }
      <div id="damage-result"></div>
      ${
        candidates.length
          ? `<div class="suggestions">
              <div class="suggestions-head">Likely teammates in this match</div>
              ${candidates
                .map(
                  (c) => `<div class="suggestion">
                <span class="stack">
                  <strong>${escapeHtml(c.display_name || c.player_id.slice(0, 8))}</strong>
                  <span>in ${c.matches_together} of your replays${
                    c.shared_eliminations
                      ? `, traded ${c.shared_eliminations} knock/finish with you`
                      : ""
                  }</span>
                </span>
                <button class="btn" data-add-teammate="${escapeHtml(c.player_id)}">Add to squad</button>
              </div>`
                )
                .join("")}
            </div>`
          : squad.length
          ? ""
          : `<p class="note">Nothing to suggest yet. Open the full lobby below and use
             "Add to squad" on whoever you played with. Once marked, they are recognised
             automatically in every other match.</p>`
      }
      <p class="note" style="margin-top:12px">Damage is not shown per teammate because it is not in
        the replay. Fortnite only ever sends your own damage totals to your PC, so no tool can
        report anyone else's. Everything else here is read straight from the match.</p>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h2>Everyone else</h2><p>${everyone.length} other players in the lobby</p></div>
        <button class="btn quiet" id="toggle-everyone">
          ${state.showEveryone ? "Hide" : "Show"}
        </button>
      </div>
      ${
        state.showEveryone
          ? `<div class="table-wrap">
              <table>
                <thead><tr>
                  <th>Player</th><th class="num">Elims</th><th class="num">Knocks</th>
                  <th class="num">Deaths</th><th class="num">K/D</th><th class="num">Avg range</th>
                  <th class="num">Longest</th><th class="num">First death</th>
                  <th>Most used</th><th></th>
                </tr></thead>
                <tbody>${playerRows(everyone, { squad: false })}</tbody>
              </table>
            </div>`
          : ""
      }
    </div>`;

  view.querySelector("#back").addEventListener("click", () => go("matches"));

  // Adding a teammate's replay from the match you are already looking at.
  const dropzone = view.querySelector("#teammate-drop");
  const teammateInput = view.querySelector("#teammate-input");
  const damageResult = view.querySelector("#damage-result");

  async function addTeammateReplays(files) {
    if (!files.length) return;
    damageResult.innerHTML = `<p class="note" style="margin-top:12px"><span class="spinner"></span>
      Reading ${files.length} file(s) and checking whether they belong to this match.</p>`;
    const lines = [];
    let merged = 0;
    for (const file of files) {
      try {
        const result = await api("/api/upload", {
          method: "POST",
          headers: { "X-File-Name": encodeURIComponent(file.name) },
          body: file,
        });
        if (result.status === "teammate" && result.replay_id === id) {
          merged++;
          lines.push(
            `<div><span>${escapeHtml(file.name)}</span><span class="ok">merged: ${escapeHtml(
              result.owner_name || result.owner_id.slice(0, 8)
            )}'s stats added</span></div>`
          );
        } else if (result.status === "teammate") {
          lines.push(
            `<div><span>${escapeHtml(file.name)}</span><span class="warn">belongs to a different match, merged there instead</span></div>`
          );
        } else if (result.status === "duplicate") {
          lines.push(
            `<div><span>${escapeHtml(file.name)}</span><span class="warn">this is your own recording of this match</span></div>`
          );
        } else if (result.status === "added") {
          const pct =
            result.similarity != null ? ` (best overlap ${Math.round(result.similarity * 100)}%)` : "";
          lines.push(
            `<div><span>${escapeHtml(file.name)}</span><span class="warn">not the same match${escapeHtml(
              pct
            )}, imported separately</span></div>`
          );
        } else {
          lines.push(
            `<div><span>${escapeHtml(file.name)}</span><span class="err">${escapeHtml(
              result.error || "failed"
            )}</span></div>`
          );
        }
      } catch (error) {
        lines.push(
          `<div><span>${escapeHtml(file.name)}</span><span class="err">${escapeHtml(error.message)}</span></div>`
        );
      }
    }
    if (merged) {
      toast(`Merged ${merged} teammate replay(s)`);
      renderMatch(id);
      return;
    }
    damageResult.innerHTML = `<div class="log" style="margin-top:12px">${lines.join("")}</div>`;
  }

  if (dropzone) {
    view.querySelector("#teammate-pick").addEventListener("click", (event) => {
      event.preventDefault();
      teammateInput.click();
    });
    teammateInput.addEventListener("change", () => addTeammateReplays([...teammateInput.files]));
    ["dragenter", "dragover"].forEach((name) =>
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.add("over");
      })
    );
    ["dragleave", "drop"].forEach((name) =>
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.remove("over");
      })
    );
    dropzone.addEventListener("drop", (event) => {
      const files = [...event.dataTransfer.files].filter((f) =>
        f.name.toLowerCase().endsWith(".replay")
      );
      if (!files.length) return toast("No .replay files in that drop");
      addTeammateReplays(files);
    });
  }

  view.querySelector("#toggle-everyone").addEventListener("click", () => {
    state.showEveryone = !state.showEveryone;
    renderMatch(id);
  });

  view.querySelectorAll("[data-add-teammate], [data-remove-teammate]").forEach((button) =>
    button.addEventListener("click", async () => {
      const add = "addTeammate" in button.dataset;
      await api("/api/players/teammate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          player_id: add ? button.dataset.addTeammate : button.dataset.removeTeammate,
          is_teammate: add,
        }),
      });
      toast(add ? "Added to your squad" : "Removed from your squad");
      renderMatch(id);
    })
  );

  view.querySelectorAll("[data-rename]").forEach((button) =>
    button.addEventListener("click", async () => {
      const playerId = button.dataset.rename;
      const player = (m.players || []).find((p) => p.player_id === playerId);
      const entered = prompt(
        `Name for this player\n\nAccount id: ${playerId}\n\nLeave blank to clear.`,
        player?.display_name || ""
      );
      if (entered === null) return;
      await api("/api/players/name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: playerId, name: entered }),
      });
      toast(entered.trim() ? `Saved as ${entered.trim()}` : "Name cleared");
      renderMatch(id);
    })
  );

  const lookupResult = view.querySelector("#lookup-result");
  const carried = sessionStorage.getItem("fr.lookupNote");
  if (carried) {
    lookupResult.innerHTML = `<p class="note" style="margin-bottom:14px">${escapeHtml(carried)}</p>`;
    sessionStorage.removeItem("fr.lookupNote");
  }
  view.querySelector("#lookup-names")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    lookupResult.innerHTML = `<p class="note" style="margin-bottom:14px">
      <span class="spinner"></span> Looking up names. This sends account ids to the lookup service.</p>`;
    try {
      const result = await api("/api/players/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replay_id: id }),
      });
      if (result.error) {
        lookupResult.innerHTML = `<p class="note" style="margin-bottom:14px">${escapeHtml(result.error)}</p>`;
        button.disabled = false;
        return;
      }
      if (result.rate_limited) {
        sessionStorage.setItem(
          "fr.lookupNote",
          `Resolved ${result.resolved} before the service throttled. ${result.remaining} left. ` +
            `Press "Look up names" again in a minute to carry on.`
        );
      }
      toast(`Resolved ${result.resolved} name(s)`);
      renderMatch(id);
    } catch (error) {
      lookupResult.innerHTML = `<p class="note" style="margin-bottom:14px">${escapeHtml(error.message)}</p>`;
      button.disabled = false;
    }
  });
}

/** Squad table. Damage columns fill in once a match's damage is fetched. */
/** Your own stats block, shaped like a teammate's contributed one. */
function myStatsBlock(m) {
  return {
    total_damage: m.total_damage,
    damage_taken: m.damage_taken,
    accuracy: m.accuracy,
    eliminations: m.eliminations,
    assists: m.assists,
    materials_used: m.materials_used,
    revives: m.revives,
    damage_to_structures: m.damage_to_structures,
  };
}

/** Squad totals, adding up only the players whose real stats are present. */
function squadTotalRow(players) {
  const known = players.filter((p) => p.own_stats);
  if (known.length < 2) return "";
  const sum = (field) => known.reduce((total, p) => total + (p.own_stats[field] || 0), 0);
  const damage = sum("total_damage");
  const taken = sum("damage_taken");
  return `<tr class="total-row">
    <td><strong>Squad total</strong><br><span style="font-size:11px;color:var(--text-muted)">
      ${known.length} of ${players.length} players</span></td>
    <td class="num"><strong>${fmt.int(damage)}</strong></td>
    <td class="num">${fmt.int(taken)}</td>
    <td class="num">${taken ? fmt.dec(damage / taken, 2) + " ratio" : "-"}</td>
    <td class="num">${fmt.int(sum("eliminations"))}</td>
    <td class="num"></td>
    <td class="num"></td>
    <td class="num">${fmt.int(sum("materials_used"))}</td>
    <td class="num"></td>
    <td class="num"></td>
  </tr>`;
}

function squadRows(players) {
  return players
    .map((p) => {
      // Damage exists only in the stats block of whoever recorded a replay, so
      // these columns fill in per player as each one's file is added.
      const own = p.own_stats;
      const sub = p.is_me
        ? "from your replay"
        : own
        ? "from their replay"
        : "replay not added yet";
      return `<tr class="${p.is_me ? "is-me" : "is-squad"}">
        <td><button class="linklike" data-rename="${escapeHtml(p.player_id)}" title="Click to set a name">
          <span class="stack"><strong>${escapeHtml(playerLabel(p))}</strong>
          <span>${sub}</span></span></button></td>
        <td class="num">${own ? `<strong>${fmt.int(own.total_damage)}</strong>` : "-"}</td>
        <td class="num">${own ? fmt.int(own.damage_taken) : "-"}</td>
        <td class="num">${own && own.accuracy != null ? fmt.pct(own.accuracy, 0) : "-"}</td>
        <td class="num">${own && own.eliminations != null ? own.eliminations : p.kills}</td>
        <td class="num">${p.knocks}</td>
        <td class="num">${p.deaths}</td>
        <td class="num">${own ? fmt.int(own.materials_used) : "-"}</td>
        <td class="num">${p.longest_kill != null ? p.longest_kill + " m" : "-"}</td>
        <td class="num">${
          p.survived_to_end ? `<span class="tag win">survived</span>` : fmt.clock(p.died_at_ms)
        }</td>
      </tr>`;
    })
    .join("");
}

function playerRows(players, { squad }) {
  if (!players.length) {
    return `<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:24px">
      Nobody to show.</td></tr>`;
  }
  return players
    .map((p) => {
      const sub = p.is_bot
        ? "bot"
        : p.display_name
        ? p.player_id.slice(0, 8)
        : "name not looked up";
      return `<tr class="${p.is_teammate ? "is-squad" : p.is_bot ? "dim" : ""}">
        <td><button class="linklike" data-rename="${escapeHtml(p.player_id)}"
              title="Click to set a name">
              <span class="stack"><strong>${escapeHtml(playerLabel(p))}</strong>
              <span>${escapeHtml(sub)}</span></span></button></td>
        <td class="num">${p.kills}</td>
        <td class="num">${p.knocks}</td>
        <td class="num">${p.deaths}</td>
        <td class="num">${fmt.dec(p.kd, 2)}</td>
        <td class="num">${p.avg_kill_distance != null ? p.avg_kill_distance + " m" : "-"}</td>
        <td class="num">${p.longest_kill != null ? p.longest_kill + " m" : "-"}</td>
        <td class="num">${
          p.survived_to_end ? `<span class="tag win">survived</span>` : fmt.clock(p.died_at_ms)
        }</td>
        <td>${p.top_weapon ? escapeHtml(p.top_weapon) : "-"}</td>
        <td class="num">${
          p.is_me
            ? ""
            : squad
            ? `<button class="btn quiet" data-remove-teammate="${escapeHtml(p.player_id)}">Remove</button>`
            : `<button class="btn quiet" data-add-teammate="${escapeHtml(p.player_id)}">Add to squad</button>`
        }</td>
      </tr>`;
    })
    .join("");
}

// ------------------------------------------------------------------- import

async function renderImport() {
  const settings = await api("/api/settings");
  view.innerHTML = `
    <div class="view-head"><div><h1>Upload replays</h1>
      <p>Files are read on this machine. Nothing is uploaded anywhere.</p></div></div>

    <div class="card" style="margin-bottom:14px">
      <div class="dropzone" id="dropzone">
        <strong>Drop .replay files here</strong>
        <span>Yours, or a teammate's. You can select as many as you like, or
          <a href="#" id="pick">browse for files</a>.</span>
        <input type="file" id="file-input" multiple accept=".replay" hidden>
      </div>
      <div class="progress" id="upload-progress" hidden><div></div></div>
      <div class="log" id="upload-log"></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><div><h2>Teammate replays</h2>
        <p>The exact way to get their damage</p></div></div>
      <p style="color:var(--text-secondary);font-size:13px;margin:0">
        A replay only contains a damage figure for the person who recorded it, which is why your
        teammates show no damage from your own file. Their replay of the same match contains theirs.
        Ask them to send you the file and drop it here: the app recognises it as the same match,
        works out who recorded it, and fills in their real damage, accuracy and materials.
        It does not create a duplicate match.</p>
    </div>

    <div class="card">
      <div class="card-head"><div><h2>Where your replays are</h2></div></div>
      <p style="color:var(--text-secondary);font-size:13px;margin:0 0 8px">
        Paste this into the File Explorer address bar, then drag files onto the box above:</p>
      <div class="copy-row">
        <code id="demos-path">${escapeHtml(settings.demos_dir)}</code>
        <button class="btn" id="copy-path">Copy</button>
      </div>
      <p class="note" style="margin-top:12px">Fortnite deletes its own "UnsavedReplay" files as you
        keep playing, so import the ones you care about while they still exist. Once imported, the
        stats are kept here even after the file is gone.</p>
    </div>`;

  view.querySelector("#copy-path").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(settings.demos_dir);
      toast("Folder path copied");
    } catch {
      const range = document.createRange();
      range.selectNodeContents(view.querySelector("#demos-path"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast("Path selected. Press Ctrl+C to copy.");
    }
    event.currentTarget.blur();
  });

  const dropzone = view.querySelector("#dropzone");
  const fileInput = view.querySelector("#file-input");
  view.querySelector("#pick").addEventListener("click", (event) => {
    event.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => uploadFiles([...fileInput.files]));
  ["dragenter", "dragover"].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove("over");
    })
  );
  dropzone.addEventListener("drop", (event) => {
    const files = [...event.dataTransfer.files].filter((f) =>
      f.name.toLowerCase().endsWith(".replay")
    );
    if (!files.length) return toast("No .replay files in that drop");
    uploadFiles(files);
  });
}

async function uploadFiles(files) {
  const log = view.querySelector("#upload-log");
  const progress = view.querySelector("#upload-progress");
  const bar = progress.firstElementChild;
  progress.hidden = false;
  log.innerHTML = "";
  let added = 0;
  let teammatesAdded = 0;
  let lastId = null;

  for (const [index, file] of files.entries()) {
    bar.style.width = `${(index / files.length) * 100}%`;
    const row = document.createElement("div");
    row.innerHTML = `<span>${escapeHtml(file.name)}</span><span class="warn">reading…</span>`;
    log.prepend(row);
    try {
      const result = await api("/api/upload", {
        method: "POST",
        headers: { "X-File-Name": encodeURIComponent(file.name) },
        body: file,
      });
      const status =
        result.status === "added"
          ? `<span class="ok">imported${result.has_stats ? "" : " (no stats block)"}</span>`
          : result.status === "teammate"
          ? `<span class="ok">same match, added ${escapeHtml(
              result.owner_name || result.owner_id.slice(0, 8)
            )}'s stats</span>`
          : result.status === "duplicate"
          ? `<span class="warn">already imported</span>`
          : `<span class="err">${escapeHtml(result.error || "failed")}</span>`;
      row.innerHTML = `<span>${escapeHtml(file.name)}</span>${status}`;
      if (result.status === "added" || result.status === "teammate") {
        added++;
        lastId = result.replay_id;
        if (result.status === "teammate") teammatesAdded++;
      }
    } catch (error) {
      row.innerHTML = `<span>${escapeHtml(file.name)}</span><span class="err">${escapeHtml(error.message)}</span>`;
    }
  }

  bar.style.width = "100%";
  setTimeout(() => (progress.hidden = true), 700);
  if (added) {
    toast(
      teammatesAdded
        ? `Added ${teammatesAdded} teammate replay(s)`
        : `Imported ${added} replay(s)`
    );
    refreshNavCount();
    if (added === 1 && lastId) setTimeout(() => go("match", lastId), 600);
  }
}

// ------------------------------------------------------------------ settings

async function renderSettings() {
  const s = await api("/api/settings");
  const weapons = s.weapons || [];

  view.innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-head">
        <div><h2>Player names</h2><p>Fallback only. Names normally come from the replay itself</p></div>
        <button class="btn" id="test-key">Test key</button>
      </div>
      <p class="note" style="margin-bottom:14px">Names are not stored in the part of a replay this
        app reads, so the only way to get them is to ask an online service. This is the one feature
        that sends anything off your machine, and it only sends account ids, only when you press
        "Look up names" on a match. Leave the key blank and nothing is ever sent. You can also just
        click any player and type a name yourself.</p>
      <div class="field">
        <label for="lookup-key">fortnite-api.com API key</label>
        <input type="password" id="lookup-key" autocomplete="off" placeholder="${
          s.has_lookup_key ? "saved, enter a new key to replace it" : "not set"
        }">
        <div class="hint">${
          s.names ? `${s.names.named} name(s) cached, ${s.names.unresolved} unresolved.` : ""
        }</div>
      </div>
      <div id="key-result"></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><div><h2>Your account</h2></div></div>
      <div class="field">
        <label for="account-id">Account id</label>
        <input type="text" id="account-id" value="${escapeHtml(s.account_id || "")}"
               placeholder="${escapeHtml(s.detected_account_id || "not detected yet")}">
        <div class="hint">Worked out automatically by matching your killfeed eliminations against
          the match stats block. Leave blank to keep using detection.</div>
      </div>
      <button class="btn primary" id="save-settings">Save</button>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><div><h2>Weapon names</h2>
        <p>Rename each elimination code to the weapon it actually is</p></div>
        <button class="btn" id="save-weapons">Save names</button></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th class="num">Your elims</th>
            <th class="num">Typical range</th><th class="num">Longest</th><th class="num">Code</th></tr></thead>
          <tbody>
            ${
              weapons.length
                ? weapons
                    .map(
                      (w) => `<tr>
                <td><input type="text" data-weapon="${w.code}" value="${escapeHtml(w.label)}" style="width:170px"></td>
                <td class="num">${w.kills}</td>
                <td class="num">${w.median_distance != null ? w.median_distance + " m" : "-"}</td>
                <td class="num">${w.max_distance != null ? w.max_distance + " m" : "-"}</td>
                <td class="num" style="color:var(--text-muted)">${w.code}</td>
              </tr>`
                    )
                    .join("")
                : `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">
                     Upload a replay first.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h2>Library</h2>
        <p>Stored at ${escapeHtml(s.library.db_path)}</p></div></div>
      <dl class="kv">
        <dt>Replays stored</dt><dd>${s.library.total || 0}</dd>
        <dt>With a stats block</dt><dd>${s.library.with_stats || 0}</dd>
        <dt>Eliminations recorded</dt><dd>${fmt.int(s.library.eliminations)}</dd>
      </dl>
      <div style="margin-top:16px">
        <button class="btn danger" id="clear-library">Clear everything</button>
      </div>
    </div>`;

  view.querySelector("#save-settings").addEventListener("click", async () => {
    const key = view.querySelector("#lookup-key").value.trim();
    await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: view.querySelector("#account-id").value,
        ...(key ? { lookup_api_key: key } : {}),
      }),
    });
    toast("Settings saved");
    renderSettings();
  });

  view.querySelector("#save-weapons").addEventListener("click", async () => {
    const labels = {};
    view.querySelectorAll("[data-weapon]").forEach((input) => {
      if (input.value.trim()) labels[input.dataset.weapon] = input.value.trim();
    });
    await api("/api/weapons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels }),
    });
    toast("Weapon names saved");
  });


  const keyResult = view.querySelector("#key-result");
  view.querySelector("#test-key").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    keyResult.innerHTML = `<p class="note"><span class="spinner"></span> Testing…</p>`;
    try {
      const result = await api("/api/players/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: view.querySelector("#lookup-key").value.trim() }),
      });
      keyResult.innerHTML = `<p class="note">${result.ok ? "✓ " : ""}${escapeHtml(result.message)}</p>`;
    } catch (error) {
      keyResult.innerHTML = `<p class="note">${escapeHtml(error.message)}</p>`;
    }
    button.disabled = false;
  });

  view.querySelector("#clear-library").addEventListener("click", async () => {
    if (
      !confirm(
        "Delete every stored replay?\n\n" +
          "Your .replay files are not touched, only the stats stored by this app."
      )
    )
      return;
    const result = await api("/api/clear", { method: "POST" });
    toast(`Cleared ${result.cleared} replay(s)`);
    refreshNavCount();
    renderSettings();
  });
}

// -------------------------------------------------------------------- router

const routes = {
  matches: renderMatches,
  match: () => renderMatch(state.matchId),
  import: renderImport,
  settings: renderSettings,
};

function go(route, matchId = null) {
  state.route = route;
  state.matchId = matchId;
  location.hash = matchId ? `#${route}/${matchId}` : `#${route}`;
}

async function render() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active =
      item.dataset.route === state.route ||
      (state.route === "match" && item.dataset.route === "matches");
    item.setAttribute("aria-current", active ? "page" : "false");
  });
  try {
    await (routes[state.route] || renderMatches)();
  } catch (error) {
    view.innerHTML = `<div class="empty"><h2>Something went wrong</h2>
      <p>${escapeHtml(error.message)}</p></div>`;
  }
  window.scrollTo(0, 0);
  refreshNavCount();
}

function readHash() {
  const [route, id] = location.hash.replace(/^#/, "").split("/");
  state.route = routes[route] ? route : "matches";
  state.matchId = id || null;
}

async function refreshNavCount() {
  try {
    const data = await api("/api/matches");
    document.getElementById("nav-match-count").textContent = data.matches.length || "";
  } catch {
    /* the count is decoration, so a failure here should not break the page */
  }
}

function applyTheme(mode) {
  if (mode === "system") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem("fr.theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
    localStorage.setItem("fr.theme", mode);
  }
  const current = localStorage.getItem("fr.theme") || "system";
  document
    .querySelectorAll("[data-theme-set]")
    .forEach((b) => b.setAttribute("aria-pressed", b.dataset.themeSet === current));
}

document.querySelectorAll("[data-theme-set]").forEach((button) =>
  button.addEventListener("click", () => applyTheme(button.dataset.themeSet))
);
document.querySelectorAll(".nav-item").forEach((item) =>
  item.addEventListener("click", () => go(item.dataset.route))
);
window.addEventListener("hashchange", () => {
  readHash();
  render();
});

applyTheme(localStorage.getItem("fr.theme") || "system");
readHash();
render();
