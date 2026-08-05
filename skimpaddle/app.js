// Skim & Paddle — White Rock, BC conditions
// Data sources: DFO/CHS IWLS (tide predictions), Open-Meteo (wind + temperature)

const STATION_ID = "5cebf1de3d0f4a073c4bb933"; // CHS "White Rock" station (07577)
const LAT = 49.0158, LON = -122.8034;
const IWLS_BASE = "https://api-iwls.dfo-mpo.gc.ca/api/v1";
const HOURS_AHEAD = 48;

// ---------- Icons ----------
// Custom PNG silhouettes (skim-icon.png / paddle-icon.png), applied as CSS masks
// so they render in currentColor and inherit whatever color context they're placed in.

const ICON_SKIM = `<span class="icon icon-skim" aria-hidden="true"></span>`;
const ICON_PADDLE = `<span class="icon icon-paddle" aria-hidden="true"></span>`;

// ---------- Time helpers ----------

function isoZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fmtTime(date) {
  return date.toLocaleTimeString("en-US", {
    timeZone: "America/Vancouver",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDayLabel(date) {
  const now = new Date();
  const dayFmt = { timeZone: "America/Vancouver", weekday: "short", month: "short", day: "numeric" };
  const todayStr = now.toLocaleDateString("en-US", { timeZone: "America/Vancouver" });
  const dateStr = date.toLocaleDateString("en-US", { timeZone: "America/Vancouver" });
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const tomorrowStr = tomorrow.toLocaleDateString("en-US", { timeZone: "America/Vancouver" });
  if (dateStr === todayStr) return "Today";
  if (dateStr === tomorrowStr) return "Tomorrow";
  return date.toLocaleDateString("en-US", dayFmt);
}

function dayKey(date) {
  return date.toLocaleDateString("en-US", { timeZone: "America/Vancouver" });
}

// ---------- Fetching ----------

async function fetchTideSeries(fromDate, toDate) {
  const url = `${IWLS_BASE}/stations/${STATION_ID}/data?time-series-code=wlp&from=${encodeURIComponent(isoZ(fromDate))}&to=${encodeURIComponent(isoZ(toDate))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tide data request failed (${res.status})`);
  const data = await res.json();
  return data.map(d => ({ t: new Date(d.eventDate), v: d.value }));
}

async function fetchHiLo(fromDate, toDate) {
  const url = `${IWLS_BASE}/stations/${STATION_ID}/data?time-series-code=wlp-hilo&from=${encodeURIComponent(isoZ(fromDate))}&to=${encodeURIComponent(isoZ(toDate))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tide high/low request failed (${res.status})`);
  const data = await res.json();
  return data.map(d => ({ t: new Date(d.eventDate), v: d.value })).sort((a, b) => a.t - b.t);
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,weather_code` +
    `&daily=sunrise,sunset` +
    `&wind_speed_unit=kmh&temperature_unit=celsius&timezone=UTC&forecast_days=3`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
  return res.json();
}

// ---------- Daylight ----------

function daylightFactor(t, sunrises, sunsets) {
  // Find the sunrise/sunset pair for the day this hour falls on (in UTC terms, using the
  // sunrise that precedes t most closely).
  let sunrise = null, sunset = null;
  for (let i = 0; i < sunrises.length; i++) {
    if (sunrises[i] <= t) { sunrise = sunrises[i]; sunset = sunsets[i]; }
  }
  if (!sunrise || !sunset) return 1; // no data — don't penalize
  const bufferMs = 30 * 60000;
  const tt = t.getTime();
  if (tt >= sunrise.getTime() && tt <= sunset.getTime()) return 1;
  if (tt >= sunrise.getTime() - bufferMs && tt < sunrise.getTime()) return 0.6;
  if (tt > sunset.getTime() && tt <= sunset.getTime() + bufferMs) return 0.6;
  return 0.15;
}

// ---------- Interpolation ----------

function interpAt(series, targetDate) {
  const t = targetDate.getTime();
  if (t <= series[0].t.getTime()) return series[0].v;
  if (t >= series[series.length - 1].t.getTime()) return series[series.length - 1].v;
  let lo = 0, hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t.getTime() <= t) lo = mid; else hi = mid;
  }
  const a = series[lo], b = series[hi];
  const span = b.t.getTime() - a.t.getTime();
  const frac = span === 0 ? 0 : (t - a.t.getTime()) / span;
  return a.v + (b.v - a.v) * frac;
}

function tideRateAt(series, targetDate) {
  const before = new Date(targetDate.getTime() - 20 * 60000);
  const after = new Date(targetDate.getTime() + 20 * 60000);
  const h1 = interpAt(series, before);
  const h2 = interpAt(series, after);
  return (h2 - h1) / (40 / 60); // metres per hour
}

function cycleInfo(hilo, targetDate) {
  // Find the bracketing high/low events around targetDate
  let prev = null, next = null;
  for (let i = 0; i < hilo.length; i++) {
    if (hilo[i].t <= targetDate) prev = hilo[i];
    if (hilo[i].t > targetDate && !next) { next = hilo[i]; break; }
  }
  if (!prev || !next) return { pct: 50, trend: "unknown" };
  const lowEvt = prev.v < next.v ? prev : next;
  const highEvt = prev.v < next.v ? next : prev;
  const range = highEvt.v - lowEvt.v;
  const cur = interpAt([{ t: prev.t, v: prev.v }, { t: next.t, v: next.v }], targetDate);
  const pct = range === 0 ? 50 : ((cur - lowEvt.v) / range) * 100;
  const trend = next.v > prev.v ? "rising" : "falling";
  return { pct: Math.max(0, Math.min(100, pct)), trend };
}

// ---------- Scoring ----------
// All scores 0-100. Tuned for beginner/intermediate riders.

function triangleScore(value, peak, halfWidth) {
  const d = Math.abs(value - peak);
  return Math.max(0, 1 - d / halfWidth);
}

function windCompassLabel(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

function scoreSkim(hour) {
  const reasons = [];
  const tideCurve = triangleScore(hour.tidePct, 32, 26); // sweet spot low-mid tide
  const movement = Math.min(1, Math.abs(hour.tideRate) / 0.35);
  const slack = Math.abs(hour.tideRate) < 0.05;
  const windFactor = Math.max(0, 1 - hour.windSpeed / 28);
  const tempFactor = Math.max(0, Math.min(1, (hour.temp - 8) / 12));

  let score = (tideCurve * 0.5 + windFactor * 0.35 + movement * 0.15) * 100;
  score += (tempFactor - 0.5) * 8;
  if (slack) score -= 12;
  score = Math.max(0, Math.min(100, Math.round(score)));

  if (tideCurve > 0.6) reasons.push("Thin sheet flow on the flats");
  if (hour.windSpeed < 12) reasons.push("Light wind");
  else if (hour.windSpeed > 22) reasons.push("Windy — choppy film");
  if (!slack) reasons.push(hour.tideTrend === "rising" ? "Tide rising" : "Tide falling");
  if (slack) reasons.push("Near slack tide");

  return { score, reasons };
}

function scorePaddle(hour) {
  const reasons = [];
  const tideCurve = triangleScore(hour.tidePct, 78, 34); // sweet spot mid-high tide, enough depth
  const windFactor = Math.max(0, 1 - hour.windSpeed / 22);
  const tempFactor = Math.max(0, Math.min(1, (hour.temp - 10) / 12));

  const fromN = hour.windDir >= 315 || hour.windDir < 45; // wind coming from the north = blows offshore here
  const fromS = hour.windDir >= 135 && hour.windDir < 225;
  let directionPenalty = 0;
  if (fromN) directionPenalty = Math.min(25, hour.windSpeed * 1.1);
  else if (!fromS) directionPenalty = Math.min(10, hour.windSpeed * 0.4);

  let score = (tideCurve * 0.4 + windFactor * 0.5) * 100 + tempFactor * 10;
  score -= directionPenalty;
  score = Math.max(0, Math.min(100, Math.round(score)));

  if (hour.windSpeed < 10) reasons.push("Calm water");
  else if (hour.windSpeed > 20) reasons.push("Too windy for comfort");
  if (tideCurve > 0.6) reasons.push("Plenty of water to paddle");
  else if (hour.tidePct < 40) reasons.push("Shallow — long walk to water");
  if (fromN && hour.windSpeed > 10) reasons.push("Offshore wind — stay close to shore");
  else if (fromS) reasons.push("Onshore breeze");

  return { score, reasons };
}

function scoreLabel(score) {
  if (score >= 80) return "great";
  if (score >= 60) return "good";
  return "fair";
}

// ---------- Build hourly dataset ----------

function buildHourly(tideSeries, hilo, weather) {
  const now = new Date();
  const startHour = new Date(now);
  startHour.setUTCMinutes(0, 0, 0);

  const wTimes = weather.hourly.time.map(t => new Date(t + ":00Z"));
  const sunrises = weather.daily.sunrise.map(t => new Date(t + ":00Z"));
  const sunsets = weather.daily.sunset.map(t => new Date(t + ":00Z"));

  const hours = [];
  for (let i = 0; i <= HOURS_AHEAD; i++) {
    const t = new Date(startHour.getTime() + i * 3600000);
    let wIdx = wTimes.findIndex(wt => wt.getTime() === t.getTime());
    if (wIdx === -1) {
      // fallback: nearest
      let best = 0, bestDiff = Infinity;
      wTimes.forEach((wt, idx) => {
        const diff = Math.abs(wt.getTime() - t.getTime());
        if (diff < bestDiff) { bestDiff = diff; best = idx; }
      });
      wIdx = best;
    }
    const tideHeight = interpAt(tideSeries, t);
    const tideRate = tideRateAt(tideSeries, t);
    const { pct, trend } = cycleInfo(hilo, t);

    const hour = {
      time: t,
      tideHeight,
      tideRate,
      tidePct: pct,
      tideTrend: trend,
      windSpeed: weather.hourly.wind_speed_10m[wIdx],
      windDir: weather.hourly.wind_direction_10m[wIdx],
      windGust: weather.hourly.wind_gusts_10m[wIdx],
      temp: weather.hourly.temperature_2m[wIdx],
      precipProb: weather.hourly.precipitation_probability[wIdx],
    };
    const daylight = daylightFactor(t, sunrises, sunsets);
    hour.skim = scoreSkim(hour);
    hour.paddle = scorePaddle(hour);
    if (daylight < 1) {
      hour.skim.score = Math.round(hour.skim.score * daylight);
      hour.paddle.score = Math.round(hour.paddle.score * daylight);
      const label = daylight >= 0.6 ? "Dawn/dusk light" : "Dark out";
      hour.skim.reasons = [label, ...hour.skim.reasons];
      hour.paddle.reasons = [label, ...hour.paddle.reasons];
    }
    hours.push(hour);
  }
  return hours;
}

// ---------- Windows ----------

function findBestWindows(hours, key, threshold = 65) {
  const windows = [];
  let cur = null;
  hours.forEach(h => {
    const s = h[key].score;
    if (s >= threshold) {
      if (!cur) cur = { start: h.time, end: h.time, hours: [h] };
      else { cur.end = h.time; cur.hours.push(h); }
    } else if (cur) {
      windows.push(cur);
      cur = null;
    }
  });
  if (cur) windows.push(cur);

  windows.forEach(w => {
    w.avgScore = Math.round(w.hours.reduce((a, h) => a + h[key].score, 0) / w.hours.length);
    w.maxScore = Math.max(...w.hours.map(h => h[key].score));
    const reasonCounts = {};
    w.hours.forEach(h => h[key].reasons.forEach(r => { reasonCounts[r] = (reasonCounts[r] || 0) + 1; }));
    w.reasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    w.endExclusive = new Date(w.end.getTime() + 3600000);
  });

  windows.sort((a, b) => b.avgScore - a.avgScore);
  return windows;
}

// ---------- Rendering ----------

function renderStatus(hours) {
  const now = hours[0];
  document.getElementById("status-updated").textContent = fmtTime(new Date());
  document.getElementById("status-tide").textContent =
    `${now.tideHeight.toFixed(1)}m ${now.tideTrend === "rising" ? "↑" : "↓"}`;
  document.getElementById("status-wind").textContent =
    `${Math.round(now.windSpeed)} km/h ${windCompassLabel(now.windDir)}`;
  document.getElementById("status-temp").textContent = `${Math.round(now.temp)}°C`;
}

function renderWindowCard(activityKey, activityLabel, windows) {
  const icon = activityKey === "skim" ? ICON_SKIM : ICON_PADDLE;
  const div = document.createElement("div");
  if (windows.length === 0) {
    div.className = "window-card none";
    div.innerHTML = `
      <p class="card-activity">${icon}${activityLabel}</p>
      <p class="card-window">No standout window</p>
      <p class="card-note">Conditions stay mediocre across the next 48h — check the hour-by-hour list below for the least-bad option.</p>`;
    return div;
  }
  const best = windows[0];
  div.className = `window-card ${activityKey}`;
  const sameDay = fmtDayLabel(best.start) === fmtDayLabel(best.end);
  const windowLabel = sameDay
    ? `${fmtDayLabel(best.start)}, ${fmtTime(best.start)}–${fmtTime(best.endExclusive)}`
    : `${fmtDayLabel(best.start)} ${fmtTime(best.start)} – ${fmtDayLabel(best.end)} ${fmtTime(best.endExclusive)}`;

  div.innerHTML = `
    <div class="card-top">
      <div>
        <p class="card-activity">${icon}${activityLabel}</p>
        <p class="card-window">${windowLabel}</p>
      </div>
      <span class="card-score ${scoreLabel(best.avgScore)}">${best.avgScore}/100</span>
    </div>
    <div class="card-reasons">
      ${best.reasons.map(r => `<span class="reason-chip">${r}</span>`).join("")}
    </div>
    ${windows.length > 1 ? `<p class="card-note">Also decent: ${windows.slice(1, 3).map(w => `${fmtDayLabel(w.start)} ${fmtTime(w.start)}–${fmtTime(w.endExclusive)} (${w.avgScore})`).join(", ")}</p>` : ""}
  `;
  return div;
}

function localHour(date) {
  return parseInt(date.toLocaleString("en-US", { timeZone: "America/Vancouver", hour: "numeric", hourCycle: "h23" }), 10);
}

function fmtHourTick(date) {
  return date.toLocaleTimeString("en-US", { timeZone: "America/Vancouver", hour: "numeric" }).replace(" ", "");
}

function renderTideChart(hours) {
  const w = 680, h = 280, padX = 10, padTop = 30, padBottom = 50;
  const plotH = h - padTop - padBottom;
  const vals = hours.map(x => x.tideHeight);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const x = i => padX + (i / (hours.length - 1)) * (w - padX * 2);
  const y = v => (h - padBottom) - ((v - min) / range) * plotH;

  const linePts = hours.map((hr, i) => `${x(i).toFixed(1)},${y(hr.tideHeight).toFixed(1)}`).join(" ");
  const areaPts = `${padX},${h - padBottom} ${linePts} ${w - padX},${h - padBottom}`;

  // background bands for good-skim / good-paddle hours
  let bands = "";
  hours.forEach((hr, i) => {
    if (i === hours.length - 1) return;
    const x1 = x(i), x2 = x(i + 1);
    if (hr.skim.score >= 65) {
      bands += `<rect x="${x1.toFixed(1)}" y="${padTop}" width="${(x2 - x1 + 0.6).toFixed(1)}" height="${plotH / 2}" fill="var(--amber-dim)" />`;
    }
    if (hr.paddle.score >= 65) {
      bands += `<rect x="${x1.toFixed(1)}" y="${padTop + plotH / 2}" width="${(x2 - x1 + 0.6).toFixed(1)}" height="${plotH / 2}" fill="var(--seafoam-dim)" />`;
    }
  });

  // day-boundary ticks (full-height dashed lines + day label at top)
  let dayTicks = "";
  let lastDay = null;
  hours.forEach((hr, i) => {
    const dk = dayKey(hr.time);
    if (dk !== lastDay) {
      lastDay = dk;
      const tx = x(i);
      const anchor = tx > w - 130 ? "end" : "start";
      const lx = anchor === "end" ? tx - 6 : tx + 6;
      dayTicks += `<line x1="${tx}" y1="${padTop}" x2="${tx}" y2="${h - padBottom}" stroke="var(--line)" stroke-dasharray="3,3" />`;
      dayTicks += `<text x="${lx}" y="22" text-anchor="${anchor}" font-family="JetBrains Mono, monospace" font-size="20" fill="var(--sand-dim)">${fmtDayLabel(hr.time)}</text>`;
    }
  });

  // time-of-day ticks every 6 hours along the bottom axis
  let hourTicks = "";
  hours.forEach((hr, i) => {
    if (localHour(hr.time) % 6 !== 0) return;
    const tx = x(i);
    const anchor = tx < 40 ? "start" : tx > w - 40 ? "end" : "middle";
    hourTicks += `<line x1="${tx.toFixed(1)}" y1="${h - padBottom}" x2="${tx.toFixed(1)}" y2="${h - padBottom + 6}" stroke="var(--sand-faint)" stroke-width="1" />`;
    hourTicks += `<text x="${tx.toFixed(1)}" y="${h - 16}" text-anchor="${anchor}" font-family="JetBrains Mono, monospace" font-size="20" fill="var(--sand-faint)">${fmtHourTick(hr.time)}</text>`;
  });

  // "now" marker
  const nowX = x(0);

  const svg = `
    <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      ${bands}
      ${dayTicks}
      ${hourTicks}
      <polygon points="${areaPts}" fill="rgba(244,233,216,0.06)" />
      <polyline points="${linePts}" fill="none" stroke="var(--sand)" stroke-width="2" />
      <line x1="${nowX}" y1="${padTop}" x2="${nowX}" y2="${h - padBottom}" stroke="var(--coral)" stroke-width="1.5" />
      <circle cx="${nowX}" cy="${y(hours[0].tideHeight)}" r="4" fill="var(--coral)" />
    </svg>`;
  document.getElementById("tide-chart").innerHTML = svg;
}

const CHEVRON_ICON = `<svg class="outlook-chevron" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 1l4 4-4 4"/></svg>`;

function scoreColor(activityKey, score) {
  // Same hue as the activity's toggle button/card, just a lighter or darker
  // shade of it depending on how good the hour is — not a separate heat scale.
  const base = activityKey === "skim" ? [255, 181, 71] : [111, 217, 196]; // amber / seafoam
  const alpha = Math.max(0.28, Math.min(1, 0.28 + (score / 100) * 0.72));
  return `rgba(${base[0]}, ${base[1]}, ${base[2]}, ${alpha.toFixed(2)})`;
}

function tideTrendLabel(hr) {
  if (hr.tideTrend === "rising") return "↑ Rising";
  if (hr.tideTrend === "falling") return "↓ Falling";
  if (Math.abs(hr.tideRate) < 0.05) return "→ Slack";
  return hr.tideRate > 0 ? "↑ Rising" : "↓ Falling";
}

function renderOutlook(hours, activityKey) {
  const list = document.getElementById("outlook-list");
  list.innerHTML = "";
  let lastDay = null;
  hours.forEach(hr => {
    const dk = dayKey(hr.time);
    const isDayStart = dk !== lastDay;
    lastDay = dk;
    const s = hr[activityKey].score;
    const color = scoreColor(activityKey, s);

    const row = document.createElement("div");
    row.className = "outlook-row" + (isDayStart ? " day-start" : "");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.innerHTML = `
      <div class="outlook-time">${isDayStart ? `<span class="day-tag">${fmtDayLabel(hr.time)}</span>` : ""}${fmtTime(hr.time)}</div>
      <div class="outlook-bar-track"><div class="outlook-bar-fill" style="width:${s}%;background:${color}"></div></div>
      <div class="outlook-detail">${s}</div>
      ${CHEVRON_ICON}
    `;

    const gustNote = hr.windGust - hr.windSpeed > 4 ? ` (gusts ${Math.round(hr.windGust)})` : "";
    const panel = document.createElement("div");
    panel.className = "outlook-detail-panel";
    panel.innerHTML = `
      <div class="detail-stat"><span class="detail-stat-label">Tide</span><span class="detail-stat-value">${hr.tideHeight.toFixed(1)}m ${tideTrendLabel(hr)}</span></div>
      <div class="detail-stat"><span class="detail-stat-label">Wind</span><span class="detail-stat-value">${Math.round(hr.windSpeed)} km/h ${windCompassLabel(hr.windDir)}${gustNote}</span></div>
      <div class="detail-stat"><span class="detail-stat-label">Temp</span><span class="detail-stat-value">${Math.round(hr.temp)}°C</span></div>
    `;

    const toggle = () => {
      const isOpen = panel.classList.contains("open");
      list.querySelectorAll(".outlook-detail-panel.open").forEach(p => p.classList.remove("open"));
      list.querySelectorAll(".outlook-row.expanded").forEach(r => r.classList.remove("expanded"));
      if (!isOpen) {
        panel.classList.add("open");
        row.classList.add("expanded");
      }
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });

    list.appendChild(row);
    list.appendChild(panel);
  });
}

function renderMethod() {
  document.getElementById("method-body").innerHTML = `
    <h3>Skimboarding</h3>
    <p>Best when the tide sits low-to-mid in its cycle (roughly the bottom third), leaving a thin moving sheet of water over the sand flats, and wind is light enough not to chop it up. Near-slack tide (barely moving) loses points even at the right height.</p>
    <h3>Paddleboarding</h3>
    <p>Best when the tide is mid-to-high (enough depth to launch and paddle without dragging), wind is calm, and it isn't blowing offshore (from the north here) which pushes beginners away from the beach.</p>
    <h3>Data</h3>
    <p>Tide predictions come from the CHS "White Rock" harmonic station via Fisheries &amp; Oceans Canada. Wind and temperature come from Open-Meteo's forecast model for this location. Scores are a best-effort estimate for beginner/intermediate riders — always look at the actual water before heading out.</p>
  `;
}

// ---------- Main ----------

async function main() {
  const now = new Date();
  const from = new Date(now.getTime() - 3 * 3600000);
  const to = new Date(now.getTime() + (HOURS_AHEAD + 3) * 3600000);

  try {
    const [tideSeries, hilo, weather] = await Promise.all([
      fetchTideSeries(from, to),
      fetchHiLo(from, to),
      fetchWeather(),
    ]);

    const hours = buildHourly(tideSeries, hilo, weather);

    renderStatus(hours);
    renderTideChart(hours);
    renderMethod();

    const skimWindows = findBestWindows(hours, "skim");
    const paddleWindows = findBestWindows(hours, "paddle");
    const cardWrap = document.getElementById("window-cards");
    cardWrap.appendChild(renderWindowCard("skim", "Skimboarding", skimWindows));
    cardWrap.appendChild(renderWindowCard("paddle", "Paddleboarding", paddleWindows));

    renderOutlook(hours, "skim");

    document.querySelectorAll(".toggle-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".toggle-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        renderOutlook(hours, btn.dataset.activity);
      });
    });

    document.getElementById("loading").classList.add("hidden");
    document.getElementById("content").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("error-panel").classList.remove("hidden");
    document.getElementById("error-text").textContent =
      "Couldn't load live conditions right now (" + err.message + "). Try refreshing in a minute.";
  }
}

main();
