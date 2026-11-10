/* Screens: Overview, Matches, Match, Upload and Settings. */

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");

const state = {
  route: "overview",
  matchId: null,
  showEveryone: false,
  feed: null, // "mine" or "all"; null picks a default per match
  overview: { range: "all", mode: "all" },
  list: { q: "", mode: "all", result: "all", hideEmpty: false, sort: "date", dir: -1 },
};

const REPO_URL = "https://github.com/fwsoapy/fortreplays";

/* ------------------------------------------------------------- helpers */

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

function tile(label, value, sub, tone = "") {
  return `<div class="tile ${tone}"><div class="label">${label}</div>
    <div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}

function go(route, matchId = null) {
  state.route = route;
  state.matchId = matchId;
  const hash = matchId ? `#${route}/${matchId}` : `#${route}`;
  if (location.hash === hash) render();
  else location.hash = hash;
}

const plural = (n, word, many = word + "s") => `${fmt.int(n)} ${n === 1 ? word : many}`;

function hours(ms) {
  if (!ms) return "0m";
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

function placeBadge(m) {
  if (m.placement === 1) return `<span class="tag win">Victory</span>`;
  if (m.placement == null) return `<span class="muted">-</span>`;
  return `<span class="place ${m.placement <= 10 ? "top10" : ""}">#${m.placement}</span>`;
}

function playerLabel(id, type) {
  if (!id) return "Unknown";
  if (type === "bot" || id === "Bot") return "Bot";
  return displayNameFor(id, type) || id.slice(0, 8);
}

function matchTitle(m) {
  return `${m.mode || "Match"}${m.mapName ? ` · ${m.mapName}` : ""}`;
}

function downloadFile(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "2026-11-09" in local time, which is what people mean by a day. */
function localDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");

/* -------------------------------------------------------------- charts */

const CHART_W = 760;

/**
 * Hover and click handling shared by both charts. `points` are in viewBox
 * coordinates; the nearest one on the x axis gets the tooltip.
 */
function bindChart(container, points, tooltipHtml) {
  const svg = container.querySelector("svg");
  const tip = container.querySelector(".tooltip");
  const marker = svg.querySelector(".hover-line");
  if (!svg || !points.length) return;

  const nearest = (event) => {
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * CHART_W;
    let best = points[0];
    for (const p of points) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    return { best, box };
  };

  svg.addEventListener("mousemove", (event) => {
    const { best, box } = nearest(event);
    tip.innerHTML = tooltipHtml(best);
    tip.classList.add("show");
    const scale = box.width / CHART_W;
    const left = best.x * scale;
    const flip = left > box.width - 190;
    tip.style.left = `${flip ? left - tip.offsetWidth - 12 : left + 12}px`;
    tip.style.top = `${Math.max(0, best.y * scale - 30)}px`;
    if (marker) {
      marker.setAttribute("x1", best.x);
      marker.setAttribute("x2", best.x);
      marker.style.opacity = 1;
    }
  });
  svg.addEventListener("mouseleave", () => {
    tip.classList.remove("show");
    if (marker) marker.style.opacity = 0;
  });
  svg.addEventListener("click", (event) => go("match", nearest(event).best.match.replayId));
}

function chartTooltip(p) {
  const m = p.match;
  return `<div class="tt-title">${escapeHtml(fmt.dayLabel(m.recordedAt))}, ${escapeHtml(fmt.time(m.recordedAt))}</div>
    <div class="tt-row">Placement <strong>${m.placement != null ? "#" + m.placement : "-"}</strong></div>
    <div class="tt-row">Damage <strong>${m.hasStats ? fmt.int(m.stats.totalDamage) : "-"}</strong></div>
    <div class="tt-row">Eliminations <strong>${m.hasStats ? fmt.int(m.stats.eliminations) : "-"}</strong></div>
    <div class="tt-row">Length <strong>${fmt.duration(m.lengthMs)}</strong></div>`;
}

/** Placement over time, oldest on the left, first place at the top. */
function placementChart(matches) {
  const list = matches.filter((m) => m.placement != null).slice(-80);
  if (list.length < 2) return "";
  const h = 210;
  const pad = { l: 36, r: 12, t: 12, b: 24 };
  const worst = Math.max(...list.map((m) => m.totalPlayers || m.placement), 10);
  const x = (i) => pad.l + (i / (list.length - 1)) * (CHART_W - pad.l - pad.r);
  // Square-root scale: the difference between 1st and 5th matters more than 60th and 64th.
  const y = (place) => pad.t + Math.sqrt((place - 1) / (worst - 1)) * (h - pad.t - pad.b);
  const points = list.map((m, i) => ({ x: x(i), y: y(m.placement), match: m }));
  const ticks = [1, 5, 10, 25, 50, 100].filter((t) => t <= worst);

  return `<div class="chart" id="placement-chart">
    <svg viewBox="0 0 ${CHART_W} ${h}" role="img" aria-label="Placement in each match">
      ${ticks
        .map(
          (t) => `<line class="grid-line" x1="${pad.l}" x2="${CHART_W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>
          <text class="axis-text" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">#${t}</text>`
        )
        .join("")}
      <line class="hover-line" x1="0" x2="0" y1="${pad.t}" y2="${h - pad.b}"/>
      <polyline class="series" style="--dash:3000" stroke-dasharray="3000" fill="none" stroke="var(--series-1)"
        stroke-width="2" stroke-linejoin="round" points="${points.map((p) => `${p.x},${p.y}`).join(" ")}"/>
      ${points
        .map((p) =>
          p.match.placement === 1
            ? `<circle class="dot win" data-x="${p.x}" data-y="${p.y}" cx="${p.x}" cy="${p.y}" r="4.5"/>`
            : `<circle class="dot" data-x="${p.x}" data-y="${p.y}" cx="${p.x}" cy="${p.y}" r="2.5"/>`
        )
        .join("")}
      <text class="axis-text" x="${pad.l}" y="${h - 6}">${escapeHtml(fmt.dayLabel(list[0].recordedAt))}</text>
      <text class="axis-text" x="${CHART_W - pad.r}" y="${h - 6}" text-anchor="end">${escapeHtml(
    fmt.dayLabel(list[list.length - 1].recordedAt)
  )}</text>
    </svg>
    <div class="tooltip"></div>
  </div>`;
}

/** Damage dealt per match as bars, eliminations as dots above them. */
function damageChart(matches) {
  const list = matches.filter((m) => m.hasStats).slice(-60);
  if (list.length < 2 || !list.some((m) => m.stats.totalDamage > 0)) return "";
  const h = 200;
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  const top = Math.max(...list.map((m) => m.stats.totalDamage), 100);
  const nice = Math.ceil(top / 250) * 250;
  const step = (CHART_W - pad.l - pad.r) / list.length;
  const barW = Math.max(2, Math.min(22, step * 0.7));
  const y = (v) => h - pad.b - (v / nice) * (h - pad.t - pad.b);
  const ticks = [0, nice / 2, nice];
  const points = list.map((m, i) => ({
    x: pad.l + step * i + step / 2,
    y: y(m.stats.totalDamage),
    match: m,
  }));

  return `<div class="chart" id="damage-chart">
    <svg viewBox="0 0 ${CHART_W} ${h}" role="img" aria-label="Damage dealt in each match">
      ${ticks
        .map(
          (t) => `<line class="grid-line" x1="${pad.l}" x2="${CHART_W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>
          <text class="axis-text" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmt.int(t)}</text>`
        )
        .join("")}
      <line class="hover-line" x1="0" x2="0" y1="${pad.t}" y2="${h - pad.b}"/>
      ${points
        .map((p, i) => {
          const barH = Math.max(1, h - pad.b - p.y);
          return `<path class="bar ${isWin(p.match) ? "win" : ""}" data-x="${p.x}" data-y="${p.y}" style="animation-delay:${Math.min(i * 8, 400)}ms"
            d="M${p.x - barW / 2},${h - pad.b} v${-barH} h${barW} v${barH} z"/>`;
        })
        .join("")}
    </svg>
    <div class="tooltip"></div>
  </div>`;
}

/* ------------------------------------------------------------ overview */

function overviewMatches() {
  const { range, mode } = state.overview;
  const cutoff = range === "7" ? Date.now() - 7 * 864e5 : range === "30" ? Date.now() - 30 * 864e5 : 0;
  return sortedMatches()
    .reverse()
    .filter((m) => (mode === "all" || m.mode === mode) && (!cutoff || new Date(m.recordedAt || 0) >= cutoff));
}

function renderOnboarding() {
  view.innerHTML = `
    <section class="onboard">
      <div class="onboard-copy">
        <span class="eyebrow">Free · private · no install</span>
        <h1>Your Fortnite stats, straight from your replays.</h1>
        <p>Drop in the <code>.replay</code> files Fortnite already saves on your PC and get damage,
          accuracy, placements, kill feeds and long-term trends. Files are read inside your browser.
          Nothing is uploaded, and there is no account.</p>
        <div class="onboard-actions">
          <button class="btn primary big" id="go-import">Add your replays</button>
          <a class="btn-link" href="${REPO_URL}" target="_blank" rel="noopener">View on GitHub</a>
        </div>
      </div>
      <ol class="steps">
        <li><strong>Find your replays</strong><span>They live in
          <code>%LOCALAPPDATA%\\FortniteGame\\Saved\\Demos</code>. Fortnite records them automatically
          when replays are on in its settings.</span></li>
        <li><strong>Drop the folder in</strong><span>Pick the whole Demos folder at once. A hundred
          replays take a few seconds.</span></li>
        <li><strong>See every match</strong><span>Your stats, your squad, the full kill feed and how
          you are trending over time.</span></li>
      </ol>
    </section>`;
  view.querySelector("#go-import").addEventListener("click", () => go("import"));
}

function renderOverview() {
  if (!db.matches().length) return renderOnboarding();

  const matches = overviewMatches();
  const account = currentAccount();
  const modes = [...new Set(db.matches().map((m) => m.mode || "Unknown"))].sort();
  const c = careerStats(matches, account);
  const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : "-");
  const recordLink = (m, label, value) =>
    m
      ? `<button class="record" data-match="${escapeHtml(m.replayId)}">
          <span>${label}</span><strong>${value}</strong>
          <em>${escapeHtml(fmt.dayLabel(m.recordedAt))} · ${escapeHtml(matchTitle(m))}</em></button>`
      : "";

  const byMode = modes
    .map((mode) => {
      const list = matches.filter((m) => (m.mode || "Unknown") === mode);
      const s = careerStats(list, account);
      return { mode, s };
    })
    .filter((r) => r.s.matches);

  const sessions = sessionsOf(matches).slice(0, 10);

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Overview</h1>
        <p>${plural(c.matches, "match", "matches")}${c.matches ? ` · ${hours(c.playedMs)} played` : ""}</p></div>
      <div class="head-controls">
        ${
          modes.length > 1
            ? `<select id="mode" aria-label="Mode"><option value="all">All modes</option>${modes
                .map((m) => `<option value="${escapeHtml(m)}" ${state.overview.mode === m ? "selected" : ""}>${escapeHtml(m)}</option>`)
                .join("")}</select>`
            : ""
        }
        <div class="segmented" role="group" aria-label="Time range">
          ${[
            ["7", "7 days"],
            ["30", "30 days"],
            ["all", "All time"],
          ]
            .map(
              ([v, label]) =>
                `<button data-range="${v}" aria-pressed="${state.overview.range === v}">${label}</button>`
            )
            .join("")}
        </div>
      </div>
    </div>

    ${
      !c.matches
        ? `<div class="empty"><h2>No matches in this range</h2><p>Try a longer time range.</p></div>`
        : `
    <div class="tiles">
      ${tile("Wins", fmt.int(c.wins), `${pct(c.wins, c.placed)} win rate`, c.wins ? "good" : "")}
      ${tile("Top 10", fmt.int(c.top10), `${pct(c.top10, c.placed)} of matches`)}
      ${tile("Avg placement", c.avgPlacement ? "#" + fmt.dec(c.avgPlacement, 1) : "-", `over ${plural(c.placed, "match", "matches")}`)}
      ${tile("Eliminations", fmt.int(c.kills), `${fmt.dec(c.kills / c.matches, 2)} per match`)}
      ${tile("Avg damage", c.avgDamage != null ? fmt.int(c.avgDamage) : "-", c.damagePerMinute != null ? `${fmt.int(c.damagePerMinute)} per minute` : "needs a stats block")}
      ${tile("Accuracy", c.avgAccuracy != null ? fmt.pct(c.avgAccuracy, 1) : "-", "average per match")}
      ${tile("Damage taken", fmt.int(c.damageTaken), c.damageTaken ? `ratio ${fmt.dec(c.totalDamage / c.damageTaken, 2)}` : "")}
      ${tile("Time played", hours(c.playedMs), `${fmt.duration(c.playedMs / c.matches)} per match`)}
    </div>

    <div class="card chart-card">
      <div class="card-head"><div><h2>Placement</h2><p>Each dot is a match, oldest on the left. Green is a win. Click one to open it.</p></div></div>
      ${placementChart(matches) || `<p class="note">Two or more matches with a placement are needed for a trend.</p>`}
    </div>

    <div class="card chart-card">
      <div class="card-head"><div><h2>Damage per match</h2><p>From the stats block Fortnite writes into your replay</p></div></div>
      ${
        damageChart(matches) ||
        (c.withStats >= 2
          ? `<p class="note">No damage was dealt in these ${plural(c.withStats, "match", "matches")}, so there is nothing to chart yet.</p>`
          : `<p class="note">Fewer than two of these matches have a stats block. Fortnite only writes one when you
          play the match through, so games you leave early show placements but no damage.</p>`)
      }
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div><h2>Personal bests</h2><p>Click one to open the match</p></div></div>
        <div class="records">
          ${recordLink(c.records.placement, "Best placement", c.records.placement ? "#" + c.records.placement.placement : "")}
          ${recordLink(c.records.damage, "Most damage", c.records.damage ? fmt.int(c.records.damage.stats.totalDamage) : "")}
          ${c.records.kills && c.records.kills.kills ? recordLink(c.records.kills.match, "Most eliminations", fmt.int(c.records.kills.kills)) : ""}
          ${c.records.longest ? recordLink(c.records.longest.match, "Longest elimination", `${c.records.longest.longest} m`) : ""}
          ${recordLink(c.records.survived, "Longest match", fmt.duration(c.records.survived && c.records.survived.lengthMs))}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>By mode</h2></div></div>
        <div class="table-wrap flat"><table>
          <thead><tr><th>Mode</th><th class="num">Matches</th><th class="num">Wins</th>
            <th class="num">Avg place</th><th class="num">Avg dmg</th></tr></thead>
          <tbody>${byMode
            .map(
              ({ mode, s }) => `<tr><td>${escapeHtml(mode)}</td><td class="num">${s.matches}</td>
              <td class="num">${s.wins}</td>
              <td class="num">${s.avgPlacement ? "#" + fmt.dec(s.avgPlacement, 1) : "-"}</td>
              <td class="num">${s.avgDamage != null ? fmt.int(s.avgDamage) : "-"}</td></tr>`
            )
            .join("")}</tbody></table></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h2>Sessions</h2><p>Your days of play, newest first</p></div></div>
      <div class="table-wrap flat"><table>
        <thead><tr><th>Day</th><th class="num">Matches</th><th class="num">Wins</th><th class="num">Top 10</th>
          <th class="num">Best</th><th class="num">Elims</th><th class="num">Avg dmg</th><th class="num">Played</th></tr></thead>
        <tbody>${sessions
          .map(({ day, matches: list }) => {
            const s = careerStats(list, account);
            return `<tr class="clickable" data-day="${escapeHtml(day)}">
              <td><strong>${escapeHtml(fmt.dayLabel(day))}</strong></td>
              <td class="num">${s.matches}</td><td class="num">${s.wins || "-"}</td>
              <td class="num">${s.top10 || "-"}</td>
              <td class="num">${s.records.placement ? "#" + s.records.placement.placement : "-"}</td>
              <td class="num">${fmt.int(s.kills)}</td>
              <td class="num">${s.avgDamage != null ? fmt.int(s.avgDamage) : "-"}</td>
              <td class="num">${hours(s.playedMs)}</td></tr>`;
          })
          .join("")}</tbody></table></div>
    </div>`
    }`;

  view.querySelectorAll("[data-range]").forEach((b) =>
    b.addEventListener("click", () => {
      state.overview.range = b.dataset.range;
      renderOverview();
    })
  );
  const modeSelect = view.querySelector("#mode");
  if (modeSelect)
    modeSelect.addEventListener("change", () => {
      state.overview.mode = modeSelect.value;
      renderOverview();
    });
  view.querySelectorAll(".record[data-match]").forEach((b) =>
    b.addEventListener("click", () => go("match", b.dataset.match))
  );
  view.querySelectorAll("[data-day]").forEach((row) =>
    row.addEventListener("click", () => {
      Object.assign(state.list, { q: localDay(row.dataset.day), mode: "all", result: "all", hideEmpty: false });
      go("matches");
    })
  );
  const placement = view.querySelector("#placement-chart");
  if (placement) bindChart(placement, chartPoints(placement, matches, "placement"), chartTooltip);
  const damage = view.querySelector("#damage-chart");
  if (damage) bindChart(damage, chartPoints(damage, matches, "damage"), chartTooltip);
}

/** Rebuild the point list a chart was drawn from, to hit-test against. */
function chartPoints(container, matches, kind) {
  const list =
    kind === "placement"
      ? matches.filter((m) => m.placement != null).slice(-80)
      : matches.filter((m) => m.hasStats).slice(-60);
  const marks = [...container.querySelectorAll(kind === "placement" ? "circle.dot" : "path.bar")];
  return marks.map((el, i) => ({ x: +el.dataset.x, y: +el.dataset.y, match: list[i] }));
}

/* ------------------------------------------------------------- matches */

const SORTS = {
  date: (m) => new Date(m.recordedAt || 0).getTime(),
  length: (m) => m.lengthMs,
  place: (m) => (m.placement == null ? null : -m.placement),
  damage: (m) => (m.hasStats ? m.stats.totalDamage : null),
  elims: (m) => (m.hasStats ? m.stats.eliminations : null),
  accuracy: (m) => (m.hasStats ? m.stats.accuracy : null),
  taken: (m) => (m.hasStats ? m.stats.damageTaken : null),
};

/** The Matches list after search, filters and sorting. */
function filteredMatches() {
  const f = state.list;
  const q = f.q.trim().toLowerCase();
  const list = db.matches().filter((m) => {
    if (f.mode !== "all" && (m.mode || "Unknown") !== f.mode) return false;
    if (f.result === "wins" && !isWin(m)) return false;
    if (f.result === "top10" && !isTop10(m)) return false;
    if (f.hideEmpty && !m.hasStats) return false;
    if (!q) return true;
    return [m.fileName, m.mode, m.mapName, m.fortniteVersion, localDay(m.recordedAt), fmt.dayLabel(m.recordedAt)]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
  const pick = SORTS[f.sort] || SORTS.date;
  return list.sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // blanks last either way
    if (vb == null) return -1;
    return (va - vb) * f.dir || SORTS.date(b) - SORTS.date(a);
  });
}

function renderMatches() {
  const all = db.matches();
  if (!all.length) return renderOnboarding();

  const f = state.list;
  const list = filteredMatches();
  const modes = [...new Set(all.map((m) => m.mode || "Unknown"))].sort();
  const th = (key, label, num = true) =>
    `<th class="sortable ${num ? "num" : ""}" data-sort="${key}" aria-sort="${
      f.sort === key ? (f.dir < 0 ? "descending" : "ascending") : "none"
    }">${label}${f.sort === key ? ` <span class="arrow">${f.dir < 0 ? "▼" : "▲"}</span>` : ""}</th>`;

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Matches</h1><p>${
        list.length === all.length ? plural(all.length, "replay") : `${fmt.int(list.length)} of ${plural(all.length, "replay")}`
      }</p></div>
      <button class="btn primary" id="add">Add replays</button>
    </div>
    <div class="filters">
      <input type="search" id="q" placeholder="Search by day, mode, map or file  ( / )" value="${escapeHtml(f.q)}" aria-label="Search">
      ${
        modes.length > 1
          ? `<select id="mode" aria-label="Mode"><option value="all">All modes</option>${modes
              .map((m) => `<option value="${escapeHtml(m)}" ${f.mode === m ? "selected" : ""}>${escapeHtml(m)}</option>`)
              .join("")}</select>`
          : ""
      }
      <div class="segmented" role="group" aria-label="Result">
        ${[
          ["all", "All"],
          ["wins", "Wins"],
          ["top10", "Top 10"],
        ]
          .map(([v, label]) => `<button data-result="${v}" aria-pressed="${f.result === v}">${label}</button>`)
          .join("")}
      </div>
      <label class="check"><input type="checkbox" id="hide-empty" ${f.hideEmpty ? "checked" : ""}> Only with stats</label>
      <span class="spacer"></span>
      ${
        list.length && list.length < all.length
          ? `<button class="btn quiet danger" id="remove-shown">Remove these ${fmt.int(list.length)}</button>`
          : ""
      }
    </div>
    ${
      !list.length
        ? `<div class="empty"><h2>Nothing matches those filters</h2><button class="btn" id="reset">Clear filters</button></div>`
        : `<div class="table-wrap">
      <table class="matches">
        <thead><tr>
          ${th("date", "Played", false)}<th>Mode</th>${th("length", "Length")}${th("place", "Place")}
          ${th("damage", "Damage")}${th("elims", "Elims")}${th("accuracy", "Accuracy")}${th("taken", "Taken")}<th></th>
        </tr></thead>
        <tbody>
          ${list
            .map(
              (m) => `<tr class="clickable ${m.hasStats ? "" : "dim"} ${isWin(m) ? "is-win" : ""}" data-match="${escapeHtml(m.replayId)}" tabindex="0">
            <td><span class="stack"><strong>${fmt.time(m.recordedAt)}</strong>
              <span>${escapeHtml(fmt.dayLabel(m.recordedAt))}</span></span></td>
            <td><span class="stack"><strong>${escapeHtml(m.mode || "Unknown")}</strong>
              ${m.mapName ? `<span>${escapeHtml(m.mapName)}</span>` : ""}</span></td>
            <td class="num">${fmt.duration(m.lengthMs)}</td>
            <td class="num">${placeBadge(m)}</td>
            <td class="num">${m.hasStats ? fmt.int(m.stats.totalDamage) : `<span class="tag">no stats</span>`}</td>
            <td class="num">${m.hasStats ? fmt.int(m.stats.eliminations) : "-"}</td>
            <td class="num">${m.hasStats ? fmt.pct(m.stats.accuracy, 0) : "-"}</td>
            <td class="num">${m.hasStats ? fmt.int(m.stats.damageTaken) : "-"}</td>
            <td class="num"><button class="icon-btn" data-delete="${escapeHtml(m.replayId)}" title="Remove this match" aria-label="Remove this match">×</button></td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`
    }`;

  view.querySelector("#add").addEventListener("click", () => go("import"));
  const q = view.querySelector("#q");
  let typing;
  q.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.list.q = q.value;
      renderMatches();
      const again = view.querySelector("#q");
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }, 160);
  });
  const mode = view.querySelector("#mode");
  if (mode) mode.addEventListener("change", () => ((state.list.mode = mode.value), renderMatches()));
  view.querySelectorAll("[data-result]").forEach((b) =>
    b.addEventListener("click", () => ((state.list.result = b.dataset.result), renderMatches()))
  );
  view.querySelector("#hide-empty").addEventListener("change", (e) => {
    state.list.hideEmpty = e.target.checked;
    renderMatches();
  });
  view.querySelectorAll("[data-sort]").forEach((cell) =>
    cell.addEventListener("click", () => {
      const key = cell.dataset.sort;
      if (state.list.sort === key) state.list.dir *= -1;
      else Object.assign(state.list, { sort: key, dir: -1 });
      renderMatches();
    })
  );
  const reset = view.querySelector("#reset");
  if (reset)
    reset.addEventListener("click", () => {
      Object.assign(state.list, { q: "", mode: "all", result: "all", hideEmpty: false });
      renderMatches();
    });
  const removeShown = view.querySelector("#remove-shown");
  if (removeShown)
    removeShown.addEventListener("click", async () => {
      if (!confirm(`Remove these ${list.length} matches? Your replay files are not touched.`)) return;
      await db.removeMatches(list.map((m) => m.replayId));
      toast(`Removed ${plural(list.length, "match", "matches")}`);
      render();
    });

  view.querySelectorAll("tr[data-match]").forEach((row) => {
    const open = () => go("match", row.dataset.match);
    row.addEventListener("click", (event) => !event.target.closest("[data-delete]") && open());
    row.addEventListener("keydown", (event) => event.key === "Enter" && open());
  });
  view.querySelectorAll("[data-delete]").forEach((button) =>
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm("Remove this match? Your replay file is not touched.")) return;
      await db.removeMatches([button.dataset.delete]);
      toast("Match removed");
      render();
    })
  );
}

/* --------------------------------------------------------- match detail */

function renderMatch(id) {
  const match = db.findMatch(id);
  if (!match) {
    view.innerHTML = `<div class="empty"><h2>Match not found</h2><p>It may have been removed.</p>
      <button class="btn" id="back">Back to matches</button></div>`;
    view.querySelector("#back").addEventListener("click", () => go("matches"));
    return;
  }

  const ordered = sortedMatches();
  const index = ordered.findIndex((m) => m.replayId === id);
  const newer = ordered[index - 1];
  const older = ordered[index + 1];

  const account = currentAccount();
  const squad = db.squad();
  const names = weaponNames();
  const stats = match.stats;
  const minutes = match.lengthMs / 60000;
  const ratio = stats && stats.damageTaken ? stats.totalDamage / stats.damageTaken : null;
  const me = match.players.find((p) => p.id === account);
  const squadRows = match.players.filter((p) => p.id !== account && squad.has(p.id));
  const others = match.players.filter((p) => p.id !== account && !squad.has(p.id));
  const candidates = squadCandidatesFor(match, account);
  const hasKey = !!db.read(KEYS.apiKey, "");

  view.innerHTML = `
    <div class="view-head">
      <div>
        <button class="btn quiet back" id="back">← Matches</button>
        <h1>${escapeHtml(matchTitle(match))}</h1>
        <p>${escapeHtml(fmt.dayLabel(match.recordedAt))} at ${fmt.time(match.recordedAt)} ·
           ${fmt.duration(match.lengthMs)}${match.fortniteVersion ? ` · v${escapeHtml(match.fortniteVersion)}` : ""}</p>
      </div>
      <div class="head-controls">
        ${hasKey ? `<button class="btn" id="lookup">Look up names</button>` : ""}
        <div class="pager">
          <button class="btn" id="newer" ${newer ? "" : "disabled"} title="Newer match (←)">← Newer</button>
          <button class="btn" id="older" ${older ? "" : "disabled"} title="Older match (→)">Older →</button>
        </div>
      </div>
    </div>
    <div id="lookup-result"></div>

    ${
      match.placement != null
        ? `<div class="result-banner ${match.placement === 1 ? "win" : match.placement <= 10 ? "top10" : ""}">
            <div class="result-place">#${match.placement}</div>
            <div><strong>${
              match.placement === 1 ? "Victory Royale" : match.placement <= 10 ? "Top 10 finish" : "Eliminated"
            }</strong>
            <span>${match.totalPlayers ? `out of ${match.totalPlayers} players` : ""}${
            me ? ` · ${plural(me.kills, "elimination")} and ${plural(me.knocks, "knock")} in the feed` : ""
          }</span></div>
          </div>`
        : ""
    }

    ${
      stats
        ? `<h2 class="section-title">Your stats</h2>
    <div class="tiles">
      ${tile("Damage dealt", fmt.int(stats.totalDamage), `${fmt.int(stats.weaponDamage)} weapon, ${fmt.int(stats.otherDamage)} other`)}
      ${tile("Damage taken", fmt.int(stats.damageTaken), ratio ? `ratio ${fmt.dec(ratio, 2)}` : "")}
      ${tile("Eliminations", fmt.int(stats.eliminations), `${fmt.int(stats.assists)} assists`)}
      ${tile("Accuracy", fmt.pct(stats.accuracy, 1), me ? plural(me.knocks, "knock") : "")}
      ${tile("Damage per minute", minutes > 0 ? fmt.int(stats.totalDamage / minutes) : "-", "")}
      ${tile("Structure damage", fmt.int(stats.damageToStructures), "")}
      ${tile("Materials used", fmt.int(stats.materialsUsed), `${fmt.int(stats.materialsGathered)} gathered`)}
      ${tile("Distance", `${fmt.dec(stats.totalTraveled / 100000, 2)} km`, "")}
      ${tile("Revives", fmt.int(stats.revives), "teammates picked up")}
    </div>`
        : `<p class="note spaced">This replay has no match stats block, so damage and accuracy are not
           available. Fortnite only writes one when you stay in the match until it ends for you.
           The kill feed and placement below still work.</p>`
    }

    <div class="card spaced">
      <div class="card-head">
        <div><h2>Your squad</h2>
          <p>${squadRows.length ? `${plural(squadRows.length, "teammate")} in this match` : "No teammates marked yet"}</p></div>
      </div>
      ${squadRows.length ? playerTable(squadRows, names, true) : ""}
      ${
        candidates.length
          ? `<div class="suggestions">
              <div class="suggestions-head">Likely teammates, guessed from the kill feed</div>
              ${candidates
                .map((c) => {
                  return `<div class="suggestion">
                    <span class="stack"><strong>${escapeHtml(playerLabel(c.id))}</strong>
                    <span>in ${plural(c.matchesTogether, "of your replays", "of your replays")}${
                    c.chains ? `, finished ${plural(c.chains, "knock")} with you` : ""
                  }</span></span>
                    <button class="btn" data-add="${escapeHtml(c.id)}">Add to squad</button>
                  </div>`;
                })
                .join("")}
            </div>`
          : squadRows.length
          ? ""
          : `<p class="note">Nothing to suggest yet. Open the full lobby below and press
             "Add to squad" on whoever you played with. Once marked, they are recognised in every match.</p>`
      }
    </div>

    ${killFeed(match, account, squad, names)}

    <div class="card">
      <div class="card-head">
        <div><h2>Everyone else</h2><p>${plural(others.length, "other player")} in the kill feed</p></div>
        <button class="btn quiet" id="toggle">${state.showEveryone ? "Hide" : "Show"}</button>
      </div>
      ${state.showEveryone ? playerTable(others, names, false) : ""}
    </div>`;

  view.querySelector("#back").addEventListener("click", () => go("matches"));
  if (newer) view.querySelector("#newer").addEventListener("click", () => go("match", newer.replayId));
  if (older) view.querySelector("#older").addEventListener("click", () => go("match", older.replayId));
  view.querySelector("#toggle").addEventListener("click", () => {
    state.showEveryone = !state.showEveryone;
    renderMatch(id);
  });
  view.querySelectorAll("[data-feed]").forEach((b) =>
    b.addEventListener("click", () => {
      state.feed = b.dataset.feed;
      renderMatch(id);
    })
  );

  view.querySelectorAll("[data-add], [data-remove]").forEach((button) =>
    button.addEventListener("click", () => {
      const set = db.squad();
      if (button.dataset.add) set.add(button.dataset.add);
      else set.delete(button.dataset.remove);
      db.saveSquad(set);
      toast(button.dataset.add ? "Added to your squad" : "Removed from your squad");
      renderMatch(id);
    })
  );

  view.querySelectorAll("[data-rename]").forEach((button) =>
    button.addEventListener("click", () => {
      const playerId = button.dataset.rename;
      const stored = db.names();
      const entered = prompt(`Name for this player\n\nAccount id: ${playerId}\n\nLeave blank to clear.`, stored[playerId] || "");
      if (entered === null) return;
      if (entered.trim()) stored[playerId] = entered.trim().slice(0, 40);
      else delete stored[playerId];
      db.saveNames(stored);
      toast(entered.trim() ? `Saved as ${entered.trim()}` : "Name cleared");
      renderMatch(id);
    })
  );

  const lookup = view.querySelector("#lookup");
  if (lookup)
    lookup.addEventListener("click", async () => {
      const result = view.querySelector("#lookup-result");
      lookup.disabled = true;
      result.innerHTML = `<p class="note spaced"><span class="spinner"></span>
        Looking up names. This sends account ids to the lookup service.</p>`;
      try {
        const ids = match.players.filter((p) => p.type === "player").map((p) => p.id);
        const outcome = await lookupNames(ids, (done, total, resolved) => {
          result.innerHTML = `<p class="note spaced"><span class="spinner"></span>
            Looking up names, ${done} of ${total} checked, ${resolved} found.</p>`;
        });
        toast(`Resolved ${plural(outcome.resolved, "name")}`);
        renderMatch(id);
        if (outcome.throttled) {
          view.querySelector("#lookup-result").innerHTML = `<p class="note spaced">
            Resolved ${outcome.resolved} before the service throttled. Press "Look up names" again in
            a minute to carry on where it stopped.</p>`;
        }
      } catch (error) {
        result.innerHTML = `<p class="note spaced">${escapeHtml(error.message)}</p>`;
        lookup.disabled = false;
      }
    });
}

/** The full elimination feed, with you and your squad highlighted. */
function killFeed(match, account, squad, names) {
  const elims = matchElims(match);
  if (!elims.length) return "";
  const types = new Map(match.players.map((p) => [p.id, p.type]));
  const mine = (id) => id && (id === account || squad.has(id));
  const mode = state.feed || (account ? "mine" : "all");
  const shown = mode === "mine" ? elims.filter((e) => mine(e.eliminatorId) || mine(e.eliminatedId)) : elims;

  const who = (id) => {
    const cls = id === account ? "me" : squad.has(id) ? "squad" : "";
    const label = id === account ? "You" : playerLabel(id, types.get(id));
    return `<span class="who ${cls}">${escapeHtml(label)}</span>`;
  };

  const rows = shown
    .map((e) => {
      const cause = causeLabel(e.gunType, names);
      const cls = e.eliminatedId === account ? "died" : e.eliminatorId === account ? "mine" : mine(e.eliminatorId) ? "squad" : "";
      const action = e.isSelfElim
        ? `${who(e.eliminatedId)} ${e.gunType === 50 ? "was caught by the storm" : "was eliminated by the zone or a fall"}`
        : `${who(e.eliminatorId)} ${e.knocked ? "knocked" : "eliminated"} ${who(e.eliminatedId)}`;
      return `<li class="${cls} ${e.knocked ? "knock" : ""}">
        <time>${fmt.clock(e.timeMs)}</time>
        <span class="feed-icon" aria-hidden="true">${e.knocked ? "◐" : "●"}</span>
        <span class="feed-text">${action}</span>
        <span class="feed-meta">${e.isSelfElim ? "" : escapeHtml(cause)}${
        e.distanceM != null && !e.isSelfElim ? ` · ${e.distanceM} m` : ""
      }</span>
      </li>`;
    })
    .join("");

  return `<div class="card spaced">
    <div class="card-head">
      <div><h2>Kill feed</h2><p>${plural(elims.filter((e) => !e.knocked).length, "elimination")} and
        ${plural(elims.filter((e) => e.knocked).length, "knock")} in this match</p></div>
      <div class="segmented" role="group" aria-label="Kill feed filter">
        <button data-feed="mine" aria-pressed="${mode === "mine"}" ${account ? "" : "disabled"}>You and squad</button>
        <button data-feed="all" aria-pressed="${mode === "all"}">Everyone</button>
      </div>
    </div>
    ${
      shown.length
        ? `<ol class="feed">${rows}</ol>`
        : `<p class="note">You and your marked squad do not appear in this match's kill feed. That is normal
           if nobody on your team knocked anyone or was knocked.</p>`
    }
  </div>`;
}

function playerTable(rows, names, isSquad) {
  if (!rows.length) return "";
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Player</th><th class="num">Elims</th><th class="num">Knocks</th><th class="num">Deaths</th>
      <th class="num">K/D</th><th class="num">Avg range</th><th class="num">Longest</th>
      <th class="num">First death</th><th>Most used</th><th></th>
    </tr></thead>
    <tbody>${rows
      .map((p) => {
        const shown = playerLabel(p.id, p.type);
        const named = displayNameFor(p.id, p.type);
        const sub = p.type === "bot" ? "bot" : named ? p.id.slice(0, 8) : "click to name";
        return `<tr class="${isSquad ? "is-squad" : p.type === "bot" ? "dim" : ""}">
        <td><button class="linklike" data-rename="${escapeHtml(p.id)}" title="Click to set a name">
          <span class="stack"><strong>${escapeHtml(shown)}</strong>
          <span>${escapeHtml(sub)}</span></span></button></td>
        <td class="num">${p.kills}</td>
        <td class="num">${p.knocks}</td>
        <td class="num">${p.deaths}</td>
        <td class="num">${fmt.dec(p.kd, 2)}</td>
        <td class="num">${p.avgDistance != null ? p.avgDistance + " m" : "-"}</td>
        <td class="num">${p.longest != null ? p.longest + " m" : "-"}</td>
        <td class="num">${p.survivedToEnd ? `<span class="tag win">survived</span>` : fmt.clock(p.diedAtMs)}</td>
        <td>${escapeHtml(p.topWeaponCode != null ? causeLabel(p.topWeaponCode, names) : "-")}</td>
        <td class="num">${
          p.type === "bot"
            ? ""
            : isSquad
            ? `<button class="btn quiet" data-remove="${escapeHtml(p.id)}">Remove</button>`
            : `<button class="btn quiet" data-add="${escapeHtml(p.id)}">Add to squad</button>`
        }</td>
      </tr>`;
      })
      .join("")}</tbody></table></div>`;
}

/* --------------------------------------------------------------- upload */

function renderImport() {
  view.innerHTML = `
    <div class="view-head"><div><h1>Add replays</h1>
      <p>Files are read inside your browser. Nothing is uploaded anywhere.</p></div></div>

    <div class="card spaced">
      <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Choose replay files">
        <div class="drop-icon" aria-hidden="true">⇪</div>
        <strong>Drop .replay files or your Demos folder here</strong>
        <span>or use a button below. Already-imported matches are skipped.</span>
        <div class="drop-actions">
          <button class="btn primary" id="pick-folder" type="button">Choose Demos folder</button>
          <button class="btn" id="pick-files" type="button">Choose files</button>
        </div>
        <input type="file" id="file-input" multiple accept=".replay" hidden>
        <input type="file" id="folder-input" webkitdirectory multiple hidden>
      </div>
      <div class="import-summary" id="summary" hidden></div>
      <div class="progress" id="progress" hidden><div></div></div>
      <div class="log" id="log"></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div><h2>Where your replays are</h2></div></div>
        <p class="muted-text">Paste this into the File Explorer address bar:</p>
        <div class="copy-row">
          <code id="path">%LOCALAPPDATA%\\FortniteGame\\Saved\\Demos</code>
          <button class="btn" id="copy">Copy</button>
        </div>
        <p class="note top-gap">Turn on <em>Record Replays</em> in Fortnite's settings if the folder is empty.
          Fortnite deletes old <code>UnsavedReplay</code> files as you play, so import the ones you care
          about. Once imported, the stats stay even after the file is gone.</p>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>What a replay can tell you</h2></div></div>
        <ul class="facts">
          <li><strong>Exact:</strong> your damage, damage taken, accuracy, eliminations, assists,
            materials, distance, placement and the whole lobby's kill feed.</li>
          <li><strong>Guessed:</strong> who your teammates are. A browser cannot read the part of the
            file that holds team numbers, so suggestions come from the kill feed and you confirm them.</li>
          <li><strong>Not in the file:</strong> your teammates' damage. Fortnite only writes your own.
            Import their replay of the same match to see theirs.</li>
        </ul>
      </div>
    </div>`;

  view.querySelector("#copy").addEventListener("click", async () => {
    const text = view.querySelector("#path").textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast("Folder path copied");
    } catch {
      const range = document.createRange();
      range.selectNodeContents(view.querySelector("#path"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast("Path selected. Press Ctrl+C to copy.");
    }
  });

  const dropzone = view.querySelector("#dropzone");
  const fileInput = view.querySelector("#file-input");
  const folderInput = view.querySelector("#folder-input");
  view.querySelector("#pick-files").addEventListener("click", (e) => (e.stopPropagation(), fileInput.click()));
  view.querySelector("#pick-folder").addEventListener("click", (e) => (e.stopPropagation(), folderInput.click()));
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.target === dropzone && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      fileInput.click();
    }
  });
  const pickReplays = (files) => [...files].filter((f) => f.name.toLowerCase().endsWith(".replay"));
  fileInput.addEventListener("change", () => importFiles(pickReplays(fileInput.files)));
  folderInput.addEventListener("change", () => {
    const files = pickReplays(folderInput.files);
    if (!files.length) return toast("No .replay files in that folder");
    importFiles(files);
  });

  // A counter, because dragleave fires every time the pointer crosses a child element.
  let depth = 0;
  dropzone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    dropzone.classList.add("over");
  });
  dropzone.addEventListener("dragover", (e) => e.preventDefault());
  dropzone.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dropzone.classList.remove("over");
  });
  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    dropzone.classList.remove("over");
    const files = await droppedReplays(e.dataTransfer);
    if (!files.length) return toast("No .replay files in that drop");
    importFiles(files);
  });
}

/** Files from a drop, walking into any dropped folders. */
async function droppedReplays(transfer) {
  const entries = [...(transfer.items || [])]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return [...transfer.files].filter((f) => f.name.toLowerCase().endsWith(".replay"));

  const out = [];
  const walk = async (entry, depth) => {
    if (entry.isFile) {
      if (entry.name.toLowerCase().endsWith(".replay")) out.push(await new Promise((r, j) => entry.file(r, j)));
    } else if (entry.isDirectory && depth < 3) {
      const reader = entry.createReader();
      // readEntries returns at most 100 at a time, so keep asking until it is empty.
      for (;;) {
        const batch = await new Promise((r, j) => reader.readEntries(r, j));
        if (!batch.length) break;
        for (const child of batch) await walk(child, depth + 1);
      }
    }
  };
  for (const entry of entries) await walk(entry, 0);
  return out;
}

let importing = false;

async function importFiles(files) {
  if (importing) return toast("Already importing, hang on");
  if (!files.length) return;
  importing = true;
  const log = view.querySelector("#log");
  const progress = view.querySelector("#progress");
  const summary = view.querySelector("#summary");
  const bar = progress.firstElementChild;
  progress.hidden = false;
  summary.hidden = false;
  log.innerHTML = "";
  const counts = { added: 0, skipped: 0, failed: 0 };
  let lastId = null;
  const known = new Set(db.matches().map((m) => m.replayId));
  const showSummary = (done) => {
    summary.innerHTML = `<span>${done ? "Done." : `Reading ${counts.added + counts.skipped + counts.failed + 1} of ${files.length}…`}</span>
      <span class="ok">${fmt.int(counts.added)} added</span>
      <span class="warn">${fmt.int(counts.skipped)} already here</span>
      ${counts.failed ? `<span class="err">${fmt.int(counts.failed)} failed</span>` : ""}
      ${done && counts.added ? `<button class="btn primary" id="see">See your stats</button>` : ""}`;
  };
  const line = (name, cls, text) => {
    const row = document.createElement("div");
    row.innerHTML = `<span>${escapeHtml(name)}</span><span class="${cls}">${escapeHtml(text)}</span>`;
    log.prepend(row);
  };

  // Newest first, so the ones Fortnite deletes soonest are not what is left if storage fills.
  files.sort((a, b) => b.lastModified - a.lastModified);
  let batch = [];
  const flush = async () => {
    if (!batch.length) return true;
    const ok = await db.addMatches(batch);
    if (!ok) counts.failed += batch.length;
    else counts.added += batch.length;
    batch = [];
    return ok;
  };

  for (const [index, file] of files.entries()) {
    bar.style.width = `${(index / files.length) * 100}%`;
    showSummary(false);
    if (index % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // let the page paint
    try {
      const parsed = parseReplay(await file.arrayBuffer(), file.name);
      if (known.has(parsed.replayId)) {
        counts.skipped++;
        line(file.name, "warn", "already imported");
        continue;
      }
      known.add(parsed.replayId);
      batch.push(buildStoredMatch(parsed));
      lastId = parsed.replayId;
      line(file.name, "ok", parsed.hasStats ? "imported" : "imported, no stats block");
      if (batch.length >= 10 && !(await flush())) {
        line(file.name, "err", "browser storage is full");
        break;
      }
    } catch (error) {
      counts.failed++;
      line(file.name, "err", error.message || "could not be read");
    }
  }
  await flush();

  importing = false;
  bar.style.width = "100%";
  setTimeout(() => (progress.hidden = true), 700);
  showSummary(true);
  updateNavCount();
  const see = summary.querySelector("#see");
  if (see) see.addEventListener("click", () => (counts.added === 1 ? go("match", lastId) : go("overview")));
  if (counts.added) toast(`Imported ${plural(counts.added, "replay")}`);
}

/* ------------------------------------------------------------- settings */

function renderSettings() {
  const detection = detectAccount();
  const stored = db.read(KEYS.account, null);
  const names = db.names();
  const namedCount = Object.values(names).filter(Boolean).length;
  const custom = db.weapons();
  const account = currentAccount();
  const hasKey = !!db.read(KEYS.apiKey, "");

  const byCode = lobbyKillsByCode();
  const mineByCode = myKillsByCode(account);
  const auto = guessedWeaponNames();
  const weaponRows = Object.keys(byCode)
    .sort((a, b) => byCode[b].length - byCode[a].length)
    .map((code) => ({
      code,
      kills: byCode[code].length,
      mine: (mineByCode[code] || []).length,
      median: percentile(byCode[code], 0.5),
      longest: Math.max(...byCode[code].filter((d) => d != null), 0) || null,
      label: custom[code] || auto[code] || `Weapon type ${code}`,
    }));

  view.innerHTML = `
    <div class="view-head"><div><h1>Settings</h1></div></div>

    <div class="card spaced">
      <div class="card-head"><div><h2>Your account</h2><p>Used to find you in each kill feed</p></div></div>
      <div class="field">
        <label for="account-id">Epic account id</label>
        <input type="text" id="account-id" value="${escapeHtml(stored || "")}" spellcheck="false"
               placeholder="${escapeHtml(detection.id || "add a replay first")}">
        <div class="hint">${
          stored
            ? "Set by you."
            : detection.id
            ? `Detected automatically${detection.confident ? "" : ", with low confidence"}: it appears in
               ${plural(detection.candidates[0].matches, "replay")}${
                detection.candidates[0].agreement
                  ? ` and matches the stats block in ${detection.candidates[0].agreement}`
                  : ""
              }. Paste yours here if that is wrong.`
            : "Not detected yet."
        }</div>
      </div>
      <button class="btn primary" id="save-account">Save</button>
    </div>

    <div class="card spaced">
      <div class="card-head"><div><h2>Backup</h2><p>Keep your history safe, or move it to another browser</p></div></div>
      <p class="muted-text">Your matches live in this browser only. Export a backup now and then: clearing
        site data, or switching browsers, starts you from empty. Importing merges and never overwrites.</p>
      <div class="button-row">
        <button class="btn primary" id="export" ${db.matches().length ? "" : "disabled"}>Export backup</button>
        <button class="btn" id="import-backup">Import backup</button>
        <input type="file" id="backup-input" accept=".json,application/json" hidden>
      </div>
    </div>

    <div class="card spaced">
      <div class="card-head">
        <div><h2>Player names</h2><p>Optional. Turns account ids into Epic display names</p></div>
        <button class="btn" id="test-key">Test key</button>
      </div>
      <p class="note spaced">The one feature that sends anything off your machine. It sends account ids
        to the lookup service, only when you press "Look up names" on a match. With no key, nothing is
        ever sent. You can also click any player and type a name yourself.</p>
      <div class="field">
        <label for="api-key">Lookup service API key</label>
        <input type="password" id="api-key" autocomplete="off" placeholder="${
          hasKey ? "saved, enter a new key to replace it" : "not set"
        }">
        <div class="hint">${plural(namedCount, "name")} saved in this browser.</div>
      </div>
      <div id="key-result"></div>
      <div class="button-row">
        <button class="btn primary" id="save-key">Save key</button>
        ${hasKey ? `<button class="btn" id="remove-key">Remove key</button>` : ""}
      </div>
    </div>

    <div class="card spaced">
      <div class="card-head"><div><h2>Weapon names</h2>
        <p>Replays store a number, not a weapon name. These are guessed from kill ranges across every lobby you imported</p></div>
        <button class="btn" id="save-weapons" ${weaponRows.length ? "" : "disabled"}>Save names</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th class="num">Kills seen</th><th class="num">Yours</th><th class="num">Typical range</th>
          <th class="num">Longest</th><th class="num">Code</th></tr></thead>
        <tbody>${
          weaponRows.length
            ? weaponRows
                .map(
                  (w) => `<tr>
            <td><input type="text" data-weapon="${w.code}" value="${escapeHtml(w.label)}" maxlength="40" style="width:180px"></td>
            <td class="num">${fmt.int(w.kills)}</td>
            <td class="num">${w.mine || "-"}</td>
            <td class="num">${w.median != null ? w.median + " m" : "-"}</td>
            <td class="num">${w.longest != null ? w.longest + " m" : "-"}</td>
            <td class="num muted">${w.code}</td></tr>`
                )
                .join("")
            : `<tr><td colspan="6" class="empty-cell">Weapons show up here once you add a replay.</td></tr>`
        }</tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><div><h2>Stored in this browser</h2></div></div>
      <dl class="kv">
        <dt>Replays</dt><dd>${fmt.int(db.matches().length)}</dd>
        <dt>Squad members</dt><dd>${db.squad().size}</dd>
        <dt>Names saved</dt><dd>${namedCount}</dd>
        <dt>Your account</dt><dd>${escapeHtml(account ? account.slice(0, 12) + "…" : "not detected")}</dd>
        <dt>Storage</dt><dd id="storage">${db.backend()}</dd>
      </dl>
      <div class="button-row top-gap"><button class="btn danger" id="clear">Clear everything</button></div>
    </div>`;

  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage
      .estimate()
      .then(({ usage, quota }) => {
        const el = view.querySelector("#storage");
        if (el && usage != null)
          el.textContent = `${db.backend()}, ${(usage / 1048576).toFixed(1)} MB used${
            quota ? ` of ${Math.round(quota / 1048576).toLocaleString()} MB` : ""
          }`;
      })
      .catch(() => {});
  }

  view.querySelector("#save-key").addEventListener("click", () => {
    const value = view.querySelector("#api-key").value.trim();
    if (!value) return toast("Enter a key first");
    db.write(KEYS.apiKey, value);
    toast("API key saved");
    renderSettings();
  });
  const removeKey = view.querySelector("#remove-key");
  if (removeKey)
    removeKey.addEventListener("click", () => {
      localStorage.removeItem(KEYS.apiKey);
      toast("API key removed");
      renderSettings();
    });

  view.querySelector("#test-key").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const result = view.querySelector("#key-result");
    const key = view.querySelector("#api-key").value.trim() || db.read(KEYS.apiKey, "");
    const sample = account || ((db.matches()[0] || { players: [] }).players.find((p) => p.type === "player") || {}).id;
    if (!key) return (result.innerHTML = `<p class="note spaced">Enter an API key first.</p>`);
    if (!sample) return (result.innerHTML = `<p class="note spaced">Add a replay first.</p>`);
    button.disabled = true;
    result.innerHTML = `<p class="note spaced"><span class="spinner"></span> Testing…</p>`;
    try {
      const name = await lookupOne(sample, key);
      result.innerHTML = `<p class="note spaced">${
        name ? `✓ Working. That account resolves to ${escapeHtml(name)}.` : "Key accepted, but that account returned no name."
      }</p>`;
    } catch (error) {
      result.innerHTML = `<p class="note spaced">${
        error.message === "bad-key"
          ? "The service rejected that key."
          : error.message === "throttled"
          ? "Rate limited right now. Try again in a minute."
          : "Could not reach the lookup service."
      }</p>`;
    }
    button.disabled = false;
  });

  view.querySelector("#save-account").addEventListener("click", () => {
    const value = view.querySelector("#account-id").value.trim().toLowerCase();
    if (value && !/^[0-9a-f]{32}$/.test(value)) return toast("An account id is 32 letters and numbers");
    if (value) db.write(KEYS.account, value);
    else localStorage.removeItem(KEYS.account);
    toast("Saved");
    renderSettings();
  });

  view.querySelector("#save-weapons").addEventListener("click", () => {
    const labels = {};
    view.querySelectorAll("[data-weapon]").forEach((input) => {
      const value = input.value.trim();
      if (value && value !== auto[input.dataset.weapon]) labels[input.dataset.weapon] = value;
    });
    db.saveWeapons(labels);
    toast("Weapon names saved");
  });

  view.querySelector("#export").addEventListener("click", () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`fortreplays-backup-${stamp}.json`, JSON.stringify(buildBackup()));
    toast("Backup downloaded");
  });
  const backupInput = view.querySelector("#backup-input");
  view.querySelector("#import-backup").addEventListener("click", () => backupInput.click());
  backupInput.addEventListener("change", async () => {
    const file = backupInput.files[0];
    if (!file) return;
    try {
      const outcome = await restoreBackup(JSON.parse(await file.text()));
      toast(`Restored ${plural(outcome.added, "match", "matches")}${outcome.skipped ? `, ${outcome.skipped} already here` : ""}`);
      updateNavCount();
      renderSettings();
    } catch (error) {
      toast(error instanceof SyntaxError ? "That file is not valid JSON" : error.message);
    }
  });

  view.querySelector("#clear").addEventListener("click", async () => {
    if (!confirm("Delete every stored match, squad member, name and setting?\n\nYour .replay files are not touched."))
      return;
    await db.clearMatches();
    Object.values(KEYS).forEach((key) => key !== KEYS.theme && localStorage.removeItem(key));
    toast("Cleared");
    updateNavCount();
    renderSettings();
  });
}

/* --------------------------------------------------------------- router */

const routes = {
  overview: renderOverview,
  matches: renderMatches,
  match: () => renderMatch(state.matchId),
  import: renderImport,
  settings: renderSettings,
};

function render() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.route === state.route || (state.route === "match" && item.dataset.route === "matches");
    item.setAttribute("aria-current", active ? "page" : "false");
  });
  try {
    (routes[state.route] || renderOverview)();
  } catch (error) {
    console.error(error);
    view.innerHTML = `<div class="empty"><h2>Something went wrong</h2>
      <p>${escapeHtml(error.message)}</p><button class="btn" id="home">Back to overview</button></div>`;
    view.querySelector("#home").addEventListener("click", () => go("overview"));
  }
  window.scrollTo(0, 0);
  updateNavCount();
}

function updateNavCount() {
  const el = document.getElementById("nav-match-count");
  if (el) el.textContent = db.matches().length ? fmt.int(db.matches().length) : "";
}

function readHash() {
  const [route, id] = location.hash.replace(/^#/, "").split("/");
  state.route = routes[route] ? route : "overview";
  state.matchId = id ? decodeURIComponent(id) : null;
  if (state.route === "match" && !state.matchId) state.route = "matches";
}

function savedTheme() {
  try {
    return localStorage.getItem(KEYS.theme);
  } catch {
    return null;
  }
}

function applyTheme(mode) {
  try {
    if (mode === "system") {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem(KEYS.theme);
    } else {
      document.documentElement.setAttribute("data-theme", mode);
      localStorage.setItem(KEYS.theme, mode);
    }
  } catch {
    /* storage blocked: the theme still applies for this visit */
  }
  const current = savedTheme() || "system";
  document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.themeSet === current));
}

document.querySelectorAll("[data-theme-set]").forEach((button) =>
  button.addEventListener("click", () => applyTheme(button.dataset.themeSet))
);
document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => go(item.dataset.route)));
window.addEventListener("hashchange", () => {
  readHash();
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping()) return;
  if (state.route === "match" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    const button = view.querySelector(event.key === "ArrowLeft" ? "#newer" : "#older");
    if (button && !button.disabled) button.click();
  } else if (event.key === "/" && state.route === "matches") {
    event.preventDefault();
    const q = view.querySelector("#q");
    if (q) q.focus();
  }
});

// Dropping a replay anywhere on the page opens the upload screen and imports it.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  if (e.target.closest && e.target.closest("#dropzone")) return;
  e.preventDefault();
  const files = await droppedReplays(e.dataTransfer);
  if (!files.length) return;
  if (state.route !== "import") {
    state.route = "import";
    history.replaceState(null, "", "#import");
    render();
  }
  importFiles(files);
});

(async function boot() {
  try {
    aesSelfTest();
  } catch (error) {
    view.innerHTML = `<div class="empty"><h2>This browser cannot read replays</h2><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }
  applyTheme(savedTheme() || "system");
  await initStorage();
  readHash();
  render();
})();
