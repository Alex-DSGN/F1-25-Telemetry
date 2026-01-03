// Назначение: отрисовывает вкладки Race, Personal и Car по состоянию laps_state, полученному по WebSocket.
const liveLapTimeEl = document.getElementById('live-lap-time');
const bestLapTimeEl = document.getElementById('best-lap-time');
const bestLapNumberEl = document.getElementById('best-lap-number');
const overallBestLapTimeEl = document.getElementById('overall-best-lap-time');
const overallBestLapNumberEl = document.getElementById('overall-best-lap-number');
const overallBestLapDriverEl = document.getElementById('overall-best-lap-driver');
const liveLapNumberEl = document.getElementById('live-lap-number');
const liveDeltaBestEl = document.getElementById('live-delta-best');
const raceFuelDeltaEl = document.getElementById('race-fuel-delta');
const raceErsEl = document.getElementById('race-ers');
const racePenaltiesEl = document.getElementById('race-penalties');
const tyresUsedEl = document.getElementById('tyres-used');
const tyresCurrentEl = document.getElementById('tyres-current');
const tyresWearEl = document.getElementById('tyres-wear');
const lapsTbodyEl = document.getElementById('laps-tbody');
const raceTbodyEl = document.getElementById('race-tbody');
const carKvEl = document.getElementById('car-kv');
const connectionStatusEl = document.getElementById('connection-status');
const sessionModeEl = document.getElementById('session-mode');
const pageEl = document.querySelector('.page');
const tabPersonalEl = document.getElementById('tab-personal');
const tabRaceEl = document.getElementById('tab-race');
const tabCarEl = document.getElementById('tab-car');

// Кэши для фронтовой логики
const racePosHistory = new Map(); // carIndex -> baseline position (первое увиденное)
const racePitSeenAt = new Map(); // carIndex -> { seenAt, lapRef }
const raceTyreHistory = new Map(); // carIndex -> [{ label, cssClass, token }]

let tyreMap = null;

async function loadTyreMap() {
  try {
    const res = await fetch('/tyres.json', { cache: 'no-cache' });
    if (!res.ok) return;
    tyreMap = await res.json();
  } catch (_) {
    // ignore
  }
}

function setActiveView(view) {
  if (!pageEl) return;
  const isRace = view === 'race';
  const isCar = view === 'car';
  pageEl.classList.toggle('view-race', isRace);
  pageEl.classList.toggle('view-car', isCar);
  if (tabPersonalEl) tabPersonalEl.classList.toggle('is-active', view === 'personal');
  if (tabRaceEl) tabRaceEl.classList.toggle('is-active', view === 'race');
  if (tabCarEl) tabCarEl.classList.toggle('is-active', view === 'car');

  try {
    localStorage.setItem('laps_view', view);
  } catch (_) {
    // ignore
  }
}

function getInitialView() {
  try {
    const v = localStorage.getItem('laps_view') || 'race';
    // backward compatibility
    return v === 'track' ? 'personal' : v;
  } catch (_) {
    return 'race';
  }
}

function fiaFlagToLabel(code) {
  if (code == null) return '—';
  if (code === -1) return '—';
  if (code === 0) return 'NONE';
  if (code === 1) return 'GREEN';
  if (code === 2) return 'BLUE';
  if (code === 3) return 'YELLOW';
  return String(code);
}

function fuelMixToLabel(code) {
  if (code == null) return '—';
  if (code === 0) return 'LEAN';
  if (code === 1) return 'STD';
  if (code === 2) return 'RICH';
  if (code === 3) return 'MAX';
  return String(code);
}

function ersDeployModeToLabel(code) {
  if (code == null) return '—';
  if (code === 0) return 'NONE';
  if (code === 1) return 'MED';
  if (code === 2) return 'HOT';
  if (code === 3) return 'OVTK';
  return String(code);
}

function renderRaceHudRow(state) {
  if (!raceFuelDeltaEl || !raceErsEl || !racePenaltiesEl) return;

  const cs = state.currentCarStatus || null;
  const pen = state.currentPenalties || null;

  // Вычисляет запас/недостачу топлива относительно оставшихся кругов гонки при наличии totalLaps, currentLap и fuelRemainingLaps.
  const totalLaps = state.totalLaps;
  const currentLap = state.currentLap?.lapNumber;
  const remaining = cs?.fuelRemainingLaps;
  if (typeof totalLaps === 'number' && typeof currentLap === 'number' && typeof remaining === 'number') {
    const lapsLeft = Math.max(0, totalLaps - (currentLap - 1));
    const delta = remaining - lapsLeft;
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
    raceFuelDeltaEl.textContent = `${sign}${Math.abs(delta).toFixed(1)}L · ${fuelMixToLabel(cs?.fuelMix)}`;
  } else {
    raceFuelDeltaEl.textContent = '—';
  }

  // Вычисляет процент заряда ERS относительно константы ERS_MAX_J при наличии ersStoreEnergy.
  const ERS_MAX_J = 4000000;
  if (typeof cs?.ersStoreEnergy === 'number' && Number.isFinite(cs.ersStoreEnergy)) {
    const pct = Math.max(0, Math.min(100, (cs.ersStoreEnergy / ERS_MAX_J) * 100));
    raceErsEl.textContent = `${pct.toFixed(0)}% · ${ersDeployModeToLabel(cs?.ersDeployMode)}`;
  } else {
    raceErsEl.textContent = '—';
  }

  // Формирует строку штрафов и предупреждений при наличии данных в текущем состоянии.
  if (pen) {
    const parts = [];
    if (pen.penaltiesSec != null && pen.penaltiesSec > 0) parts.push(`+${pen.penaltiesSec}s`);
    if (pen.totalWarnings != null && pen.totalWarnings > 0) parts.push(`Warnings: ${pen.totalWarnings}`);
    if (pen.cornerCuttingWarnings != null && pen.cornerCuttingWarnings > 0) parts.push(`Corner cuts: ${pen.cornerCuttingWarnings}`);
    if (pen.numUnservedDriveThroughPens != null && pen.numUnservedDriveThroughPens > 0) parts.push(`Drive-through: ${pen.numUnservedDriveThroughPens}`);
    if (pen.numUnservedStopGoPens != null && pen.numUnservedStopGoPens > 0) parts.push(`Stop-go: ${pen.numUnservedStopGoPens}`);
    if (pen.pitStopShouldServePen === 1) parts.push('Serve at pit');
    racePenaltiesEl.textContent = parts.length ? parts.join(' · ') : 'None';
  } else {
    racePenaltiesEl.textContent = '—';
  }
}

function renderCarTab(state) {
  if (!carKvEl) return;
  carKvEl.innerHTML = '';

  const status = state.currentCarStatus || null;
  const tel = state.currentCarTelemetry || null;
  if (!status && !tel) {
    const row = document.createElement('div');
    row.className = 'kv';
    row.innerHTML = `<span class="k">Car data</span><span class="v">—</span>`;
    carKvEl.appendChild(row);
    return;
  }

  // Создает секцию ключ-значение с заголовком по переданным парам
  const addSection = (title, entries) => {
    if (!entries.length) return;
    const sec = document.createElement('section');
    sec.className = 'car-section';
    const h = document.createElement('h3');
    h.className = 'car-section-title';
    h.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'car-section-grid';
    entries.forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'kv';
      row.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`;
      grid.appendChild(row);
    });
    sec.appendChild(h);
    sec.appendChild(grid);
    carKvEl.appendChild(sec);
  };

  const tyres = [];
  const fuel = [];
  const controls = [];
  const ersEngine = [];
  const telemetry = [];
  const temps = [];
  const misc = [];

  if (status) {
    tyres.push(['Tyre Visual', status.visualTyreCompound != null ? String(status.visualTyreCompound) : '—']);
    tyres.push(['Tyre Actual', status.actualTyreCompound != null ? String(status.actualTyreCompound) : '—']);
    tyres.push(['Tyres Age', status.tyresAgeLaps != null ? `${status.tyresAgeLaps} laps` : '—']);

    fuel.push(['Fuel In Tank', status.fuelInTank != null ? `${status.fuelInTank.toFixed(2)} kg` : '—']);
    fuel.push(['Fuel Capacity', status.fuelCapacity != null ? `${status.fuelCapacity.toFixed(2)} kg` : '—']);
    fuel.push(['Fuel Remaining', status.fuelRemainingLaps != null ? `${status.fuelRemainingLaps.toFixed(2)} laps` : '—']);
    fuel.push(['Fuel Mix', String(status.fuelMix ?? '—')]);

    controls.push(['Traction Control', String(status.tractionControl ?? '—')]);
    controls.push(['ABS', status.antiLockBrakes === 1 ? 'ON' : 'OFF']);
    controls.push(['Front Brake Bias', status.frontBrakeBias != null ? `${status.frontBrakeBias}%` : '—']);
    controls.push(['Pit Limiter', status.pitLimiterStatus === 1 ? 'ON' : 'OFF']);

    ersEngine.push(['Max RPM', status.maxRPM != null ? `${status.maxRPM}` : '—']);
    ersEngine.push(['Idle RPM', status.idleRPM != null ? `${status.idleRPM}` : '—']);
    ersEngine.push(['Max Gears', status.maxGears != null ? `${status.maxGears}` : '—']);
    ersEngine.push(['ICE Power', status.enginePowerICE != null ? `${status.enginePowerICE.toFixed(0)} W` : '—']);
    ersEngine.push(['MGU-K Power', status.enginePowerMGUK != null ? `${status.enginePowerMGUK.toFixed(0)} W` : '—']);
    ersEngine.push(['ERS Store', status.ersStoreEnergy != null ? `${status.ersStoreEnergy.toFixed(0)} J` : '—']);
    ersEngine.push(['ERS Deploy Mode', String(status.ersDeployMode ?? '—')]);
    ersEngine.push(['ERS Harvest (K)', status.ersHarvestedThisLapMGUK != null ? `${status.ersHarvestedThisLapMGUK.toFixed(0)} J` : '—']);
    ersEngine.push(['ERS Harvest (H)', status.ersHarvestedThisLapMGUH != null ? `${status.ersHarvestedThisLapMGUH.toFixed(0)} J` : '—']);
    ersEngine.push(['ERS Deployed', status.ersDeployedThisLap != null ? `${status.ersDeployedThisLap.toFixed(0)} J` : '—']);

    misc.push(['FIA Flags', fiaFlagToLabel(status.vehicleFIAFlags)]);
    misc.push(['DRS Allowed', status.drsAllowed === 1 ? 'YES' : 'NO']);
    misc.push(['DRS Activation Dist', status.drsActivationDistance != null ? `${status.drsActivationDistance} m` : '—']);
    misc.push(['Network Paused', status.networkPaused === 1 ? 'YES' : 'NO']);
  }

  if (tel) {
    telemetry.push(['Speed', tel.speedKph != null ? `${tel.speedKph} kph` : '—']);
    telemetry.push(['Throttle', tel.throttle != null ? tel.throttle.toFixed(2) : '—']);
    telemetry.push(['Brake', tel.brake != null ? tel.brake.toFixed(2) : '—']);
    telemetry.push(['Steer', tel.steer != null ? tel.steer.toFixed(2) : '—']);
    telemetry.push(['Clutch', tel.clutch != null ? `${tel.clutch}%` : '—']);
    telemetry.push(['Gear', tel.gear != null ? String(tel.gear) : '—']);
    telemetry.push(['Engine RPM', tel.engineRPM != null ? String(tel.engineRPM) : '—']);
    telemetry.push(['DRS', tel.drs === 1 ? 'ON' : 'OFF']);
    telemetry.push(['Rev Lights %', tel.revLightsPercent != null ? `${tel.revLightsPercent}%` : '—']);

    temps.push(['Engine Temp', tel.engineTemperature != null ? `${tel.engineTemperature}°C` : '—']);
    if (Array.isArray(tel.brakesTemperature)) temps.push(['Brakes Temp', tel.brakesTemperature.join(', ') + '°C']);
    if (Array.isArray(tel.tyresSurfaceTemperature)) temps.push(['Tyres Surface Temp', tel.tyresSurfaceTemperature.join(', ') + '°C']);
    if (Array.isArray(tel.tyresInnerTemperature)) temps.push(['Tyres Inner Temp', tel.tyresInnerTemperature.join(', ') + '°C']);

    if (Array.isArray(tel.tyresPressure)) tyres.push(['Tyres Pressure', tel.tyresPressure.map((p) => (p != null ? p.toFixed(1) : '—')).join(', ') + ' psi']);
    if (Array.isArray(tel.surfaceType)) misc.push(['Surface Type', tel.surfaceType.join(', ')]);
  }

  addSection('Tyres', tyres);
  addSection('Fuel', fuel);
  addSection('Controls', controls);
  addSection('ERS / Engine', ersEngine);
  addSection('Telemetry', telemetry);
  addSection('Temperatures', temps);
  addSection('Misc', misc);
}

function formatTime(ms) {
  if (ms == null) return '--:--.---';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  const pad = (n, len) => String(n).padStart(len, '0');
  const centis = Math.floor(millis / 10);
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(centis, 2)}`;
}

function formatDelta(ms) {
  if (ms == null) return '';
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±';
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const seconds = totalSeconds;
  const millis = abs % 1000;
  const pad = (n, len) => String(n).padStart(len, '0');
  const centis = Math.floor(millis / 10);
  return `${sign}${pad(seconds, 2)}.${pad(centis, 2)}`;
}

function formatGapAhead(ms) {
  if (ms == null) return '';
  const sign = ms < 0 ? '−' : ''; // ahead should normally be positive, keep minus just in case
  const absSeconds = Math.abs(ms) / 1000;
  // 3 digits after dot, no leading zero padding for seconds
  return `${sign}${absSeconds.toFixed(3)}`;
}

function formatShortSeconds(ms, digits = 2) {
  if (ms == null || ms <= 0) return '';
  return `${(ms / 1000).toFixed(digits)}s`;
}

function tyreCodeToMeta(visualCompound, actualCompound) {
  const vKey = visualCompound != null ? String(visualCompound) : null;
  const aKey = actualCompound != null ? String(actualCompound) : null;

  if (tyreMap) {
    const fromVisual = vKey && tyreMap.visual ? tyreMap.visual[vKey] : null;
    if (fromVisual) return fromVisual;
    const fromActual = aKey && tyreMap.actual ? tyreMap.actual[aKey] : null;
    if (fromActual) return fromActual;
  }

  // fallback: show code if mapping isn't loaded / unknown
  if (vKey) return { label: vKey, cssClass: '' };
  if (aKey) return { label: aKey, cssClass: '' };
  return { label: '', cssClass: '' };
}

function ensureTyreHistory(historyMap, key, meta, changeToken, maxLen = 6) {
  if (!meta.label) return historyMap.get(key) || [];
  const hist = historyMap.get(key) || [];
  const token = changeToken ?? meta.label;
  if (!hist.length || hist[hist.length - 1].token !== token) {
    hist.push({ label: meta.label, cssClass: meta.cssClass, token });
    if (hist.length > maxLen) hist.shift();
    historyMap.set(key, hist);
  }
  return hist;
}

function renderTyreStack(parentEl, history) {
  parentEl.textContent = '';
  if (!history || !history.length) return;
  const wrap = document.createElement('span');
  wrap.className = 'tyre-stack';
  history.forEach((m, idx) => {
    const span = document.createElement('span');
    span.className = `badge badge-tyre layered ${m.cssClass}`.trim();
    span.textContent = m.label;
    if (idx === history.length - 1) {
      span.title = 'Current tyre';
    }
    wrap.appendChild(span);
  });
  parentEl.appendChild(wrap);
}

function buildPersonalTyreStacks(lapsAsc, liveLap) {
  const stacksByLap = new Map();
  const rolling = [];
  for (const lap of lapsAsc) {
    const meta = tyreCodeToMeta(lap.tyreVisualCompound, lap.tyreActualCompound);
    const token = meta.label || null;
    if (meta.label && (!rolling.length || rolling[rolling.length - 1].token !== token)) {
      rolling.push({ label: meta.label, cssClass: meta.cssClass, token });
    }
    stacksByLap.set(lap.lapNumber, [...rolling]);
  }
  if (liveLap && liveLap.lapNumber != null) {
    const meta = tyreCodeToMeta(liveLap.tyreVisualCompound, liveLap.tyreActualCompound);
    const token = meta.label || null;
    const liveStack = rolling.slice();
    if (meta.label && (!liveStack.length || liveStack[liveStack.length - 1].token !== token)) {
      liveStack.push({ label: meta.label, cssClass: meta.cssClass, token });
    }
    stacksByLap.set(liveLap.lapNumber, liveStack);
  }
  return stacksByLap;
}

function renderTyresSummary(state, personalTyreStacks, lapsAsc) {
  if (!tyresUsedEl || !tyresCurrentEl) return;

  const liveLapNum = state.currentLap?.lapNumber;
  const lastCompletedLapNum = lapsAsc.length ? lapsAsc[lapsAsc.length - 1].lapNumber : null;
  const stackBase =
    (liveLapNum != null ? personalTyreStacks.get(liveLapNum) : null) ||
    (lastCompletedLapNum != null ? personalTyreStacks.get(lastCompletedLapNum) : null) ||
    [];

  // Дополнительно учитываем актуальные шины из CarStatus, если они изменились внутри текущего круга
  const currentMeta = tyreCodeToMeta(
    state.currentCarStatus?.visualTyreCompound ?? state.currentLap?.tyreVisualCompound,
    state.currentCarStatus?.actualTyreCompound ?? state.currentLap?.tyreActualCompound
  );
  const stack =
    currentMeta.label && (!stackBase.length || stackBase[stackBase.length - 1].label !== currentMeta.label)
      ? [...stackBase, { label: currentMeta.label, cssClass: currentMeta.cssClass, token: currentMeta.label }]
      : stackBase;

  if (stack.length) {
    renderTyreStack(tyresUsedEl, stack);
  } else {
    tyresUsedEl.textContent = '—';
  }

  const visualTyre = state.currentCarStatus?.visualTyreCompound ?? state.currentLap?.tyreVisualCompound;
  const actualTyre = state.currentCarStatus?.actualTyreCompound ?? state.currentLap?.tyreActualCompound;
  const tyreAge = state.currentCarStatus?.tyresAgeLaps ?? state.currentLap?.tyresAgeLaps;
  const meta = tyreCodeToMeta(visualTyre, actualTyre);

  tyresCurrentEl.textContent = '';
  if (meta.label) {
    const badge = document.createElement('span');
    badge.className = `badge badge-tyre ${meta.cssClass}`.trim();
    badge.textContent = meta.label;

    const ageSpan = document.createElement('span');
    ageSpan.className = 'tyres-current-age';
    ageSpan.textContent = tyreAge != null ? `${tyreAge} lap${tyreAge === 1 ? '' : 's'}` : '—';

    tyresCurrentEl.appendChild(badge);
    tyresCurrentEl.appendChild(ageSpan);
  } else {
    tyresCurrentEl.textContent = '—';
  }

  if (tyresWearEl) {
    const wear = state.currentCarDamage?.tyresWear;
    if (Array.isArray(wear) && wear.length === 4) {
      // Order: front left/right, then rear left/right
      const order = [
        { label: 'FL', idx: 2 },
        { label: 'FR', idx: 3 },
        { label: 'RL', idx: 0 },
        { label: 'RR', idx: 1 }
      ];
      const parts = order.map(({ label, idx }) => {
        const val = wear[idx];
        const pct =
          typeof val === 'number' && Number.isFinite(val)
            ? Math.trunc(Math.max(0, Math.min(100, val)))
            : null;
        return pct != null ? `${label} ${pct}%` : `${label} —`;
      });
      tyresWearEl.textContent = parts.join(' · ');
    } else {
      tyresWearEl.textContent = '—';
    }
  }
}

function pitToLabel(pitStatus, pitLaneTimeMs) {
  // pitStatus: 0=none, 1=pitting, 2=in pit area
  const time = pitLaneTimeMs;
  if ((pitStatus == null || pitStatus === 0) && (time == null || time <= 0)) return '';
  const timeText = formatShortSeconds(time, 1);
  const statusText = pitStatus === 2 ? 'BOX' : pitStatus === 1 ? 'IN' : 'P';
  return timeText ? `${statusText} ${timeText}` : statusText;
}

function renderRaceTable(state) {
  if (!raceTbodyEl) return;
  raceTbodyEl.innerHTML = '';

  const cars = Array.isArray(state.raceCars) ? state.raceCars : [];
  cars
    .slice()
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
    .forEach((c) => {
      const tr = document.createElement('tr');
      if (state.playerCarIndex != null && c.carIndex === state.playerCarIndex) {
        tr.classList.add('race-player');
      }

      // Δ Position vs предыдущей отрисовки
      const baselinePos = racePosHistory.get(c.carIndex);
      const curPos = c.position;
      if (baselinePos == null && Number.isFinite(curPos)) {
        racePosHistory.set(c.carIndex, curPos);
      }
      const hasDelta = Number.isFinite(baselinePos) && Number.isFinite(curPos);
      const delta = hasDelta ? baselinePos - curPos : 0;
      const tdDeltaPos = document.createElement('td');
      tdDeltaPos.className = 'col-posdiff';
      if (!hasDelta || delta === 0) {
        tdDeltaPos.textContent = '−';
      } else if (delta > 0) {
        tdDeltaPos.textContent = `↑${delta}`;
        tdDeltaPos.classList.add('delta-negative');
      } else if (delta < 0) {
        tdDeltaPos.textContent = `↓${Math.abs(delta)}`;
        tdDeltaPos.classList.add('delta-positive');
      } else {
        tdDeltaPos.textContent = '·';
      }

      const tdPos = document.createElement('td');
      tdPos.className = 'col-lapno';
      tdPos.textContent = c.position ?? '';

      const tdName = document.createElement('td');
      tdName.className = 'col-driver';
      if (c.teamColour && c.teamColour.r != null) {
        const dot = document.createElement('span');
        dot.className = 'team-dot';
        dot.style.backgroundColor = `rgb(${c.teamColour.r}, ${c.teamColour.g}, ${c.teamColour.b})`;
        tdName.appendChild(dot);
      }
      tdName.appendChild(document.createTextNode(c.name ?? ''));

      const tdLap = document.createElement('td');
      tdLap.className = 'col-laptime';
      tdLap.textContent = formatTime(c.lapTimeMs);
      if (state.raceBestLapCarIndex != null && c.carIndex === state.raceBestLapCarIndex) {
        tdLap.classList.add('best-sector');
      }

      const tdGap = document.createElement('td');
      tdGap.className = 'col-ahead';
      // gap to car ahead
      tdGap.textContent = c.position === 1 ? '' : formatGapAhead(c.gapToCarAheadMs);

      const tdTyre = document.createElement('td');
      tdTyre.className = 'col-tyre';
      const tyreMeta = tyreCodeToMeta(c.tyreVisualCompound, c.tyreActualCompound);
      const tyreToken = tyreMeta.label || null;
      const tyreHistory = ensureTyreHistory(raceTyreHistory, c.carIndex, tyreMeta, tyreToken);
      renderTyreStack(tdTyre, tyreHistory);

      const tdStops = document.createElement('td');
      tdStops.className = 'col-stops';
      tdStops.textContent = c.stops != null ? String(c.stops) : '';

      const tdPit = document.createElement('td');
      tdPit.className = 'col-pit';
      const pitLabel = pitToLabel(c.pitStatus, c.pitLaneTimeMs);
      const existingPit = racePitSeenAt.get(c.carIndex);
      const seenAt = existingPit?.seenAt ?? (pitLabel ? Date.now() : null);
      const lapRef = existingPit?.lapRef ?? c.lapNumber;
      if (pitLabel && seenAt != null) {
        racePitSeenAt.set(c.carIndex, { seenAt, lapRef });
      }
      const ageOk = seenAt != null ? Date.now() - seenAt < 10000 : false;
      const lapOk = lapRef != null ? c.lapNumber === lapRef : true;
      const showPit = pitLabel && ageOk && lapOk;
      if (c.lapNumber != null && lapRef != null && c.lapNumber > lapRef) {
        racePitSeenAt.delete(c.carIndex);
      } else if (!pitLabel && existingPit) {
        racePitSeenAt.delete(c.carIndex);
      }
      if (showPit) {
        const span = document.createElement('span');
        span.className = 'badge badge-pit';
        span.textContent = pitLabel;
        tdPit.appendChild(span);
      }

      const tdS1 = document.createElement('td');
      tdS1.textContent = formatTime(c.sector1TimeMs);
      if (state.raceBestSector1CarIndex != null && c.carIndex === state.raceBestSector1CarIndex) {
        tdS1.classList.add('best-sector');
      }

      const tdS2 = document.createElement('td');
      tdS2.textContent = formatTime(c.sector2TimeMs);
      if (state.raceBestSector2CarIndex != null && c.carIndex === state.raceBestSector2CarIndex) {
        tdS2.classList.add('best-sector');
      }

      const tdS3 = document.createElement('td');
      tdS3.textContent = formatTime(c.sector3TimeMs);
      if (state.raceBestSector3CarIndex != null && c.carIndex === state.raceBestSector3CarIndex) {
        tdS3.classList.add('best-sector');
      }

      tr.appendChild(tdPos);
      tr.appendChild(tdDeltaPos);
      tr.appendChild(tdName);
      tr.appendChild(tdLap);
      tr.appendChild(tdGap);
      tr.appendChild(tdTyre);
      tr.appendChild(tdStops);
      tr.appendChild(tdPit);
      tr.appendChild(tdS1);
      tr.appendChild(tdS2);
      tr.appendChild(tdS3);
      raceTbodyEl.appendChild(tr);

      // baseline не обновляем, чтобы дельта была постоянной
    });
}

function renderState(state) {
  // Режим таблицы: race vs time trial (управляет видимостью колонок)
  if (pageEl) {
    pageEl.classList.toggle('mode-race', state.sessionKind === 'race');
    pageEl.classList.toggle('mode-time-trial', state.sessionKind === 'time_trial');
  }
  if (sessionModeEl) {
    sessionModeEl.textContent =
      state.sessionKind === 'race'
        ? 'Race'
        : state.sessionKind === 'time_trial'
          ? 'Time Trial'
          : state.sessionKind === 'time_attack'
            ? 'Quali / Practice'
            : '—';
    sessionModeEl.title = state.sessionType != null ? `sessionType=${state.sessionType}` : '';
  }

  liveLapTimeEl.textContent = formatTime(state.liveLapTimeMs);
  bestLapTimeEl.textContent = formatTime(state.bestLapTimeMs);
  bestLapNumberEl.textContent =
    state.bestLapNumber != null ? `L${state.bestLapNumber}` : '';
  if (overallBestLapTimeEl) overallBestLapTimeEl.textContent = formatTime(state.raceBestLapTimeMs);
  if (overallBestLapNumberEl) {
    overallBestLapNumberEl.textContent =
      state.raceBestLapNum != null ? `L${state.raceBestLapNum}` : '';
  }
  if (overallBestLapDriverEl) {
    const bestIdx = state.raceBestLapCarIndex;
    const driver =
      bestIdx != null && Array.isArray(state.raceCars)
        ? state.raceCars.find((c) => c.carIndex === bestIdx)?.name
        : null;
    overallBestLapDriverEl.textContent = driver ? driver : '';
  }
  liveDeltaBestEl.textContent = formatDelta(state.liveDeltaToBestMs);
  if (liveLapNumberEl) {
    const lapNum = state.currentLap?.lapNumber;
    const total = state.totalLaps;
    if (lapNum != null && typeof total === 'number') {
      liveLapNumberEl.textContent = `${lapNum} / ${total}`;
    } else if (lapNum != null) {
      liveLapNumberEl.textContent = `${lapNum}`;
    } else {
      liveLapNumberEl.textContent = '—';
    }
  }

  renderRaceHudRow(state);

  // Обновить статус подключения
  if (connectionStatusEl) {
    if (state.isConnected) {
      connectionStatusEl.textContent = 'Connected';
      connectionStatusEl.classList.remove('status-disconnected');
      connectionStatusEl.classList.add('status-connected');
    } else {
      connectionStatusEl.textContent = 'Disconnected';
      connectionStatusEl.classList.remove('status-connected');
      connectionStatusEl.classList.add('status-disconnected');
    }
  }

  // Tabs: race view доступен только в race
  if (tabRaceEl) {
    // Race table is useful for any multi-car session (race/sprint/quali/practice).
    // Only disable it for time trial.
    const enabled = state.sessionKind !== 'time_trial';
    tabRaceEl.disabled = !enabled;
    if (!enabled && pageEl?.classList.contains('view-race')) {
      setActiveView('personal');
    }
  }

  lapsTbodyEl.innerHTML = '';

  const lapsAsc = state.laps.slice().sort((a, b) => (a.lapNumber ?? 0) - (b.lapNumber ?? 0));
  const personalTyreStacks = buildPersonalTyreStacks(lapsAsc, state.currentLap);
  renderTyresSummary(state, personalTyreStacks, lapsAsc);

  // Текущий круг (live) + завершенные круги (сверху самые новые)
  const lapsForRender = state.laps.slice().reverse();
  if (state.currentLap) {
    lapsForRender.unshift({ ...state.currentLap, isLive: true });
  }

  lapsForRender.forEach((lap) => {
    const tr = document.createElement('tr');
    if (lap.isLive) tr.classList.add('live-lap');
    if (!lap.valid) {
      tr.classList.add('invalid');
    }
    if (lap.isBest) {
      tr.classList.add('best');
    }

    const tdNumber = document.createElement('td');
    tdNumber.className = 'col-lapno';
    tdNumber.textContent = lap.lapNumber;

    const tdTime = document.createElement('td');
    tdTime.className = 'col-laptime';
    tdTime.textContent = formatTime(lap.lapTimeMs);

    const tdDelta = document.createElement('td');
    if (lap.isBest) {
      tdDelta.textContent = 'Best lap';
    } else {
      tdDelta.textContent = formatDelta(lap.deltaMs);
    }
    if (lap.deltaMs != null) {
      if (lap.deltaMs > 0) tdDelta.classList.add('delta-positive');
      if (lap.deltaMs < 0) tdDelta.classList.add('delta-negative');
    }

    const tdTyre = document.createElement('td');
    tdTyre.className = 'col-tyre';
    const stack = lap.lapNumber != null ? personalTyreStacks.get(lap.lapNumber) || [] : [];
    renderTyreStack(tdTyre, stack);

    const tdPit = document.createElement('td');
    tdPit.className = 'col-pit';
    const pitLabel = pitToLabel(lap.pitStatus, lap.pitLaneTimeMs);
    if (pitLabel) {
      const span = document.createElement('span');
      span.className = 'badge badge-pit';
      span.textContent = pitLabel;
      tdPit.appendChild(span);
    } else {
      tdPit.textContent = '';
    }

    const tdS1 = document.createElement('td');
    tdS1.textContent = formatTime(lap.sector1TimeMs);
    // Подсветить лучший сектор фиолетовым
    if (
      state.bestSector1TimeMs != null &&
      lap.sector1TimeMs != null &&
      lap.sector1TimeMs === state.bestSector1TimeMs &&
      lap.valid
    ) {
      tdS1.classList.add('best-sector');
    }

    const tdS2 = document.createElement('td');
    tdS2.textContent = formatTime(lap.sector2TimeMs);
    // Подсветить лучший сектор фиолетовым
    if (
      state.bestSector2TimeMs != null &&
      lap.sector2TimeMs != null &&
      lap.sector2TimeMs === state.bestSector2TimeMs &&
      lap.valid
    ) {
      tdS2.classList.add('best-sector');
    }

    const tdS3 = document.createElement('td');
    tdS3.textContent = formatTime(lap.sector3TimeMs);
    // Подсветить лучший сектор фиолетовым
    if (
      state.bestSector3TimeMs != null &&
      lap.sector3TimeMs != null &&
      lap.sector3TimeMs === state.bestSector3TimeMs &&
      lap.valid
    ) {
      tdS3.classList.add('best-sector');
    }

    const tdValid = document.createElement('td');
    tdValid.className = 'col-valid';
    tdValid.textContent = lap.valid ? 'OK' : 'NO';

    tr.appendChild(tdNumber);
    tr.appendChild(tdTime);
    tr.appendChild(tdDelta);
    tr.appendChild(tdTyre);
    tr.appendChild(tdPit);
    tr.appendChild(tdS1);
    tr.appendChild(tdS2);
    tr.appendChild(tdS3);
    tr.appendChild(tdValid);
    lapsTbodyEl.appendChild(tr);
  });

  renderRaceTable(state);
  renderCarTab(state);
}

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${window.location.host}`;
  const ws = new WebSocket(wsUrl);

  // Обновляет интерфейс при получении сообщения laps_state по WebSocket
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'laps_state') {
        renderState(msg.payload);
      }
    } catch (e) {
      // Игнорировать ошибки парсинга
    }
  };

  ws.onclose = () => {
    // Простое переподключение без таймеров и эффектов
    setTimeout(connect, 1000);
  };
}

if (tabPersonalEl) tabPersonalEl.onclick = () => setActiveView('personal');
if (tabRaceEl) tabRaceEl.onclick = () => setActiveView('race');
if (tabCarEl) tabCarEl.onclick = () => setActiveView('car');

setActiveView(getInitialView());

loadTyreMap();
connect();




