/**
 * Назначение: прием UDP-пакетов F1 25, разбор необходимых структур, формирование агрегированного состояния и передача его по WebSocket клиентам; раздача статических файлов из каталога public.
 * Параметры среды: HTTP_PORT (число, обязательный), UDP_PORT (число, обязательный), DEMO (строка "1" включает демо-режим).
 * Возвращаемые значения: отсутствуют.
 * Побочные эффекты: открывает HTTP/WebSocket сервер, создает UDP-сокет при отключенном демо, периодически отправляет состояние всем подключенным WebSocket-клиентам.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');

// Простые константы конфигурации
const HTTP_PORT = 8080; // Порт для веб-интерфейса и WebSocket
const UDP_PORT = 20777; // Стандартный порт телеметрии F1

const publicDir = path.join(__dirname, '..', 'public');
const DEMO_MODE = process.env.DEMO === '1' || process.argv.includes('--demo');

// Создание HTTP-сервера, обслуживающего статические файлы из publicDir
const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(publicDir, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let contentType = 'text/plain; charset=utf-8';
    if (urlPath.endsWith('.html')) contentType = 'text/html; charset=utf-8';
    if (urlPath.endsWith('.css')) contentType = 'text/css; charset=utf-8';
    if (urlPath.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// Инициализация WebSocket-сервера, использующего общий HTTP-сервер
const wss = new WebSocketServer({ server });

// Состояние, которое отправляется во фронт (laps/race/car вкладки)
let lapsState = {
  liveLapTimeMs: 0,
  liveDeltaToBestMs: null,
  bestLapTimeMs: null,
  bestLapNumber: null,
  bestSector1TimeMs: null,
  bestSector2TimeMs: null,
  bestSector3TimeMs: null,
  isConnected: false,
  laps: [] // { lapNumber, lapTimeMs, deltaMs, valid, isBest, sector1TimeMs, sector2TimeMs, sector3TimeMs }
};

// Внутреннее состояние игрока, используемое для фиксации завершения круга и валидности данных
const playerState = {
  sessionUID: null,
  currentLapNum: null,
  currentLapInvalid: 0,
  currentSector1TimeMs: null,
  currentSector2TimeMs: null,

  // Tyres (из Packet Car Status)
  currentTyreActualCompound: null,
  currentTyreVisualCompound: null,
  currentTyresAgeLaps: null,

  // Pit lane stint tracking (может пересекать линию старта/финиша)
  pitLaneActive: false,
  pitLaneStartLapNum: null,
  pitLaneMaxTimeMs: 0,
  pitLanePitStatusMax: 0
};

// Константы протокола F1 25 UDP
const PACKET_ID_SESSION = 1;
const PACKET_ID_LAP_DATA = 2;
const PACKET_ID_PARTICIPANTS = 4;
const PACKET_ID_CAR_TELEMETRY = 6;
const PACKET_ID_SESSION_HISTORY = 11;
const PACKET_ID_CAR_STATUS = 7;
const PACKET_ID_CAR_DAMAGE = 10;
const HEADER_SIZE = 29; // Размер PacketHeader в байтах
const NUM_CARS = 22; // cs_maxNumCarsInUDPData
const LAP_DATA_SIZE = 57; // Размер структуры LapData (по спецификации)
const CAR_STATUS_DATA_SIZE = 55; // (1239 - 29) / 22 = 55
const CAR_TELEMETRY_DATA_SIZE = 60; // (1352 - 29 - 3) / 22 = 60
const PARTICIPANT_DATA_SIZE = 57; // (1284 - 29 - 1) / 22 = 57 (см. Participants - 1284 bytes)
const LAP_HISTORY_DATA_SIZE = 14; // Session History LapHistoryData size
const CAR_DAMAGE_DATA_SIZE = 46; // (1041 - 29) / 22 = 46

// Переменные из пакета Participants
let numActiveCars = null; // from PacketParticipantsData.m_numActiveCars

// Лучшие секторы и круг по всей сессии
let raceBestSector1TimeMs = null;
let raceBestSector2TimeMs = null;
let raceBestSector3TimeMs = null;
let raceBestSector1CarIndex = null;
let raceBestSector2CarIndex = null;
let raceBestSector3CarIndex = null;
let raceBestLapTimeMs = null;
let raceBestLapCarIndex = null;
let raceBestLapNum = null;

// Итоговые значения pit-lane по кругу (привязка к кругу въезда)
const pitLaneTimeByLap = new Map(); // lapNumber -> ms
const pitLaneStatusByLap = new Map(); // lapNumber -> pitStatus max (1/2)

// Круги по номеру; при откате круги вперед удаляются
const lapsByNumber = new Map(); // lapNumber -> lapEntry
// Шины фиксируются на начале круга
const tyreByLapStart = new Map(); // lapNumber -> { tyreActualCompound, tyreVisualCompound, tyresAgeLaps }

// Кэши по всем машинам для таблицы гонки и лучших значений
const participantsNameByIndex = new Map(); // carIndex -> name
const participantsTeamIdByIndex = new Map(); // carIndex -> teamId
const participantsColorByIndex = new Map(); // carIndex -> { r,g,b }
const carStatusByIndex = new Map(); // carIndex -> CarStatusData snapshot
const carTelemetryByIndex = new Map(); // carIndex -> telemetry snapshot
const carDamageByIndex = new Map(); // carIndex -> CarDamageData snapshot
const lapDataByIndex = new Map(); // carIndex -> parsed lap data
const sectorCacheByIndex = new Map(); // carIndex -> { sector1TimeMs, sector2TimeMs, sector3TimeMs }
const pitLaneStintByIndex = new Map(); // carIndex -> { active, startLapNum, maxTimeMs, statusMax, lastTimeMs, lastStatusMax, lastLapNum }
const sessionHistoryByCarIndex = new Map(); // carIndex -> Map(lapNum-> { lapTimeMs, s1, s2, s3, validFlags })

function syncLapsArrayFromMap() {
  lapsState.laps = Array.from(lapsByNumber.values()).sort((a, b) => a.lapNumber - b.lapNumber);
}

function recomputeFromLaps() {
  let bestLapTimeMs = null;
  let bestLapNumber = null;
  let bestS1 = null;
  let bestS2 = null;
  let bestS3 = null;

  for (const l of lapsByNumber.values()) {
    if (!l.valid || l.lapTimeMs == null || l.lapTimeMs <= 0) continue;

    if (bestLapTimeMs == null || l.lapTimeMs < bestLapTimeMs) {
      bestLapTimeMs = l.lapTimeMs;
      bestLapNumber = l.lapNumber;
    }

    if (l.sector1TimeMs != null && (bestS1 == null || l.sector1TimeMs < bestS1)) bestS1 = l.sector1TimeMs;
    if (l.sector2TimeMs != null && (bestS2 == null || l.sector2TimeMs < bestS2)) bestS2 = l.sector2TimeMs;
    if (l.sector3TimeMs != null && (bestS3 == null || l.sector3TimeMs < bestS3)) bestS3 = l.sector3TimeMs;
  }

  lapsState.bestLapTimeMs = bestLapTimeMs;
  lapsState.bestLapNumber = bestLapNumber;
  lapsState.bestSector1TimeMs = bestS1;
  lapsState.bestSector2TimeMs = bestS2;
  lapsState.bestSector3TimeMs = bestS3;

  for (const l of lapsByNumber.values()) {
    l.isBest = bestLapTimeMs != null && l.valid && l.lapTimeMs === bestLapTimeMs;
    l.deltaMs = bestLapTimeMs != null && l.valid && l.lapTimeMs > 0 ? l.lapTimeMs - bestLapTimeMs : null;
  }

  syncLapsArrayFromMap();
}

function broadcastState() {
  const message = JSON.stringify({
    type: 'laps_state',
    payload: lapsState
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function startDemoFeed() {
  // Фейковый поток телеметрии для разработки без игры.
  // Генерирует "машины", двигает их по треку, считает круги/сектора/питы и
  // публикует то же lapsState, что и реальные пакеты.
  const nowMs = () => Date.now();
  const trackLengthM = 5300;
  const totalLapsPlanned = 50;
  const trackId = 10;
  const sessionType = 10; // race
  const playerCarIndex = 0;
  const numCars = 20;

  const hslToRgb = (h, s, l) => {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) return { r: l, g: l, b: l };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const r = hue2rgb(p, q, h + 1 / 3);
    const g = hue2rgb(p, q, h);
    const b = hue2rgb(p, q, h - 1 / 3);
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  };

  const cars = Array.from({ length: numCars }, (_, i) => {
    const hue = (i / numCars) % 1;
    return {
      carIndex: i,
      name: i === 0 ? 'You' : `Driver ${i + 1}`,
      teamColour: hslToRgb(hue, 0.65, 0.55),
      lapNumber: 1,
      lapStartAt: nowMs(),
      lapDistance: (i / numCars) * trackLengthM,
      baseSpeed: 72 + (i % 7) * 1.2, // m/s
      lastLapTimeMs: null,
      lastS1: null,
      lastS2: null,
      lastS3: null,
      tyreVisualCompound: i % 5 === 0 ? 16 : i % 5 === 1 ? 17 : i % 5 === 2 ? 18 : i % 5 === 3 ? 7 : 8,
      tyreActualCompound: null,
      tyresAgeLaps: 0,
      stops: 0
    };
  });

  const personalLaps = [];

  const computePersonalBest = (laps) => {
    let bestLapTimeMs = null;
    let bestLapNumber = null;
    let bestS1 = null;
    let bestS2 = null;
    let bestS3 = null;
    for (const l of laps) {
      if (l.lapTimeMs != null && (bestLapTimeMs == null || l.lapTimeMs < bestLapTimeMs)) {
        bestLapTimeMs = l.lapTimeMs;
        bestLapNumber = l.lapNumber;
      }
      if (l.sector1TimeMs != null && (bestS1 == null || l.sector1TimeMs < bestS1)) bestS1 = l.sector1TimeMs;
      if (l.sector2TimeMs != null && (bestS2 == null || l.sector2TimeMs < bestS2)) bestS2 = l.sector2TimeMs;
      if (l.sector3TimeMs != null && (bestS3 == null || l.sector3TimeMs < bestS3)) bestS3 = l.sector3TimeMs;
    }
    return { bestLapTimeMs, bestLapNumber, bestS1, bestS2, bestS3 };
  };

  const tick = () => {
    const t = nowMs();

    // Обновляем ход машин
    for (const c of cars) {
      const speed = c.baseSpeed;
      c.lapDistance += speed * 0.2; // tick 200ms

      if (c.lapDistance >= trackLengthM) {
        c.lapDistance -= trackLengthM;
        const lapTimeMs = t - c.lapStartAt;
        c.lapStartAt = t;
        c.lastLapTimeMs = lapTimeMs;

        const s1 = Math.round(lapTimeMs * (0.31 + (c.carIndex % 5) * 0.002));
        const s2 = Math.round(lapTimeMs * (0.40 + (c.carIndex % 7) * 0.001));
        const s3 = Math.max(0, lapTimeMs - s1 - s2);
        c.lastS1 = s1;
        c.lastS2 = s2;
        c.lastS3 = s3;

        c.lapNumber += 1;
        c.tyresAgeLaps += 1;

        if (c.carIndex === playerCarIndex) {
          personalLaps.push({
            lapNumber: c.lapNumber - 1,
            lapTimeMs,
            deltaMs: null,
            valid: true,
            isBest: false,
            sector1TimeMs: s1,
            sector2TimeMs: s2,
            sector3TimeMs: s3,
            tyreVisualCompound: c.tyreVisualCompound,
            tyreActualCompound: c.tyreActualCompound,
            tyresAgeLaps: c.tyresAgeLaps,
            pitStatus: 0,
            pitLaneTimeMs: null,
            numPitStops: c.stops
          });
        }
      }
    }

    // Позиции по дистанции
    const withDistance = cars
      .slice()
      .map((c) => ({
        ...c,
        totalMeters: (c.lapNumber - 1) * trackLengthM + c.lapDistance
      }))
      .sort((a, b) => b.totalMeters - a.totalMeters);

    withDistance.forEach((c, idx) => {
      c.position = idx + 1;
    });

    // Гепы к лидеру/впереди по дистанции (переводим в мс через среднюю скорость)
    const leaderMeters = withDistance[0].totalMeters;
    const avgSpeedMs = 72;
    withDistance.forEach((c, idx) => {
      const gapMeters = leaderMeters - c.totalMeters;
      c.gapToLeaderMs = gapMeters > 0 ? (gapMeters / avgSpeedMs) * 1000 : null;
      if (idx === 0) {
        c.gapToCarAheadMs = null;
      } else {
        const ahead = withDistance[idx - 1];
        const gapToAhead = ahead.totalMeters - c.totalMeters;
        c.gapToCarAheadMs = gapToAhead > 0 ? (gapToAhead / avgSpeedMs) * 1000 : null;
      }
    });

    // Personal bests
    const pb = computePersonalBest(personalLaps);
    if (pb.bestLapTimeMs != null) {
      for (const l of personalLaps) {
        l.isBest = l.lapTimeMs === pb.bestLapTimeMs;
        l.deltaMs = l.isBest ? 0 : l.lapTimeMs - pb.bestLapTimeMs;
      }
    }

    const you = withDistance.find((c) => c.carIndex === playerCarIndex);
    const liveLapTimeMs = you ? t - you.lapStartAt : 0;

    // Лучшие по гонке
    let raceBestLapTimeMs = null;
    let raceBestLapCarIndex = null;
    let raceBestS1 = null;
    let raceBestS2 = null;
    let raceBestS3 = null;
    let raceBestS1CarIndex = null;
    let raceBestS2CarIndex = null;
    let raceBestS3CarIndex = null;
    let raceBestLapNumLocal = null;
    for (const c of withDistance) {
      if (c.lastLapTimeMs != null && (raceBestLapTimeMs == null || c.lastLapTimeMs < raceBestLapTimeMs)) {
        raceBestLapTimeMs = c.lastLapTimeMs;
        raceBestLapCarIndex = c.carIndex;
        raceBestLapNumLocal = c.lastLapTimeMs ? c.lapNumber - 1 : null;
      }
      if (c.lastS1 != null && (raceBestS1 == null || c.lastS1 < raceBestS1)) {
        raceBestS1 = c.lastS1;
        raceBestS1CarIndex = c.carIndex;
      }
      if (c.lastS2 != null && (raceBestS2 == null || c.lastS2 < raceBestS2)) {
        raceBestS2 = c.lastS2;
        raceBestS2CarIndex = c.carIndex;
      }
      if (c.lastS3 != null && (raceBestS3 == null || c.lastS3 < raceBestS3)) {
        raceBestS3 = c.lastS3;
        raceBestS3CarIndex = c.carIndex;
      }
    }

    const raceCars = withDistance.map((c) => ({
      carIndex: c.carIndex,
      name: c.name,
      teamColour: c.teamColour,
      position: c.position,
      lapNumber: c.lapNumber,
      lapTimeMs: c.lastLapTimeMs,
      bestLapTimeMs: c.lastLapTimeMs,
      bestLapNum: c.lastLapTimeMs ? c.lapNumber - 1 : null,
      gapToLeaderMs: c.gapToLeaderMs,
      gapToCarAheadMs: c.gapToCarAheadMs,
      sector1TimeMs: c.lastS1,
      sector2TimeMs: c.lastS2,
      sector3TimeMs: c.lastS3,
      tyreActualCompound: c.tyreActualCompound,
      tyreVisualCompound: c.tyreVisualCompound,
      tyresAgeLaps: c.tyresAgeLaps,
      pitStatus: 0,
      pitLaneTimeMs: null,
      stops: c.stops,
      lapDistance: c.lapDistance
    }));

    const lapsForUi = personalLaps.slice(-50);

    lapsState = {
      ...lapsState,
      isConnected: true,
      sessionKind: 'race',
      sessionType,
      totalLaps: totalLapsPlanned,
      trackId,
      trackLengthM,
      playerCarIndex,
      liveLapTimeMs,
      liveDeltaToBestMs: pb.bestLapTimeMs != null ? pb.bestLapTimeMs - liveLapTimeMs : null,
      bestLapTimeMs: pb.bestLapTimeMs,
      bestLapNumber: pb.bestLapNumber,
      bestSector1TimeMs: pb.bestS1,
      bestSector2TimeMs: pb.bestS2,
      bestSector3TimeMs: pb.bestS3,
      currentLap: {
        lapNumber: you?.lapNumber ?? 1,
        lapTimeMs: liveLapTimeMs,
        deltaMs: pb.bestLapTimeMs != null ? liveLapTimeMs - pb.bestLapTimeMs : null,
        valid: true,
        isBest: false,
        sector1TimeMs: you?.lastS1 ?? null,
        sector2TimeMs: you?.lastS2 ?? null,
        sector3TimeMs: null,
        tyreActualCompound: you?.tyreActualCompound ?? null,
        tyreVisualCompound: you?.tyreVisualCompound ?? null,
        tyresAgeLaps: you?.tyresAgeLaps ?? null,
        pitStatus: 0,
        pitLaneTimeMs: null,
        numPitStops: you?.stops ?? 0
      },
      currentCarStatus: {
        tractionControl: 2,
        antiLockBrakes: 1,
        fuelMix: 1,
        frontBrakeBias: 55,
        pitLimiterStatus: 0,
        fuelInTank: 35.0,
        fuelCapacity: 110.0,
        fuelRemainingLaps: 12.3,
        maxRPM: 12000,
        idleRPM: 4000,
        maxGears: 8,
        drsAllowed: 1,
        drsActivationDistance: 0,
        actualTyreCompound: you?.tyreActualCompound ?? you?.tyreVisualCompound ?? 16,
        visualTyreCompound: you?.tyreVisualCompound ?? 16,
        tyresAgeLaps: you?.tyresAgeLaps ?? 0,
        vehicleFIAFlags: 1,
        enginePowerICE: 560000,
        enginePowerMGUK: 120000,
        ersStoreEnergy: 4000000,
        ersDeployMode: 1,
        ersHarvestedThisLapMGUK: 800000,
        ersHarvestedThisLapMGUH: 600000,
        ersDeployedThisLap: 700000,
        networkPaused: 0
      },
      currentCarDamage: (() => {
        const age = you?.tyresAgeLaps ?? 0;
        const baseWear = Math.min(95, 5 + age * 3);
        const jitter = (delta) => Math.max(0, Math.min(100, baseWear + delta));
        return {
          tyresWear: [jitter(1.5), jitter(2.5), jitter(0.5), jitter(1.0)],
          tyresDamage: [0, 0, 0, 0],
          brakesDamage: [0, 0, 0, 0],
          tyreBlisters: [0, 0, 0, 0]
        };
      })(),
      currentCarTelemetry: {
        speedKph: you ? Math.max(0, Math.round((you.baseSpeed * 3.6) + (Math.sin(t / 500) * 5))) : 0,
        throttle: 0.85,
        steer: 0.0,
        brake: 0.0,
        clutch: 0,
        gear: 7,
        engineRPM: 10500,
        drs: 0,
        revLightsPercent: 82,
        revLightsBitValue: 0,
        brakesTemperature: [480, 475, 460, 465],
        tyresSurfaceTemperature: [92, 93, 90, 91],
        tyresInnerTemperature: [98, 99, 96, 97],
        engineTemperature: 104,
        tyresPressure: [22.2, 22.1, 21.9, 22.0],
        surfaceType: [0, 0, 0, 0]
      },
      currentPenalties: {
        penaltiesSec: 0,
        totalWarnings: 0,
        cornerCuttingWarnings: 0,
        numUnservedDriveThroughPens: 0,
        numUnservedStopGoPens: 0,
        pitStopShouldServePen: 0
      },
      laps: lapsForUi,
      raceCars,
      raceBestSector1TimeMs: raceBestS1,
      raceBestSector2TimeMs: raceBestS2,
      raceBestSector3TimeMs: raceBestS3,
      raceBestSector1CarIndex: raceBestS1CarIndex,
      raceBestSector2CarIndex: raceBestS2CarIndex,
      raceBestSector3CarIndex: raceBestS3CarIndex,
      raceBestLapTimeMs,
      raceBestLapCarIndex,
      raceBestLapNum: raceBestLapNumLocal
    };

    broadcastState();
  };

  // мгновенно отрисовать стартовое состояние
  tick();
  setInterval(tick, 200);
}

function resetSessionState(sessionUID) {
  // Полный сброс, когда видим новый sessionUID (новая гонка/TT) или переподключение.
  playerState.sessionUID = sessionUID;
  playerState.currentLapNum = null;
  playerState.currentLapInvalid = 0;
  playerState.currentSector1TimeMs = null;
  playerState.currentSector2TimeMs = null;
  playerState.currentTyreActualCompound = null;
  playerState.currentTyreVisualCompound = null;
  playerState.currentTyresAgeLaps = null;
  playerState.pitLaneActive = false;
  playerState.pitLaneStartLapNum = null;
  playerState.pitLaneMaxTimeMs = 0;
  playerState.pitLanePitStatusMax = 0;

  pitLaneTimeByLap.clear();
  pitLaneStatusByLap.clear();
  lapsByNumber.clear();
  tyreByLapStart.clear();
  participantsNameByIndex.clear();
  participantsTeamIdByIndex.clear();
  participantsColorByIndex.clear();
  carStatusByIndex.clear();
  carTelemetryByIndex.clear();
  carDamageByIndex.clear();
  lapDataByIndex.clear();
  sectorCacheByIndex.clear();
  pitLaneStintByIndex.clear();
  sessionHistoryByCarIndex.clear();
  numActiveCars = null;
  raceBestSector1TimeMs = null;
  raceBestSector2TimeMs = null;
  raceBestSector3TimeMs = null;
  raceBestSector1CarIndex = null;
  raceBestSector2CarIndex = null;
  raceBestSector3CarIndex = null;
  raceBestLapTimeMs = null;
  raceBestLapCarIndex = null;
  raceBestLapNum = null;

  lapsState = {
    liveLapTimeMs: 0,
    liveDeltaToBestMs: null,
    bestLapTimeMs: null,
    bestLapNumber: null,
    bestSector1TimeMs: null,
    bestSector2TimeMs: null,
    bestSector3TimeMs: null,
    isConnected: true,
    sessionKind: null,
    sessionType: null,
    totalLaps: null,
    trackId: null,
    trackLengthM: null,
    formula: null,
    weather: null,
    trackTemperatureC: null,
    airTemperatureC: null,
    sessionTimeLeftSec: null,
    sessionDurationSec: null,
    pitSpeedLimitKph: null,
    currentLap: null,
    laps: [],
    raceCars: [],
    playerCarIndex: null,
    raceBestSector1TimeMs: null,
    raceBestSector2TimeMs: null,
    raceBestSector3TimeMs: null,
    raceBestSector1CarIndex: null,
    raceBestSector2CarIndex: null,
    raceBestSector3CarIndex: null,
    raceBestLapTimeMs: null,
    raceBestLapCarIndex: null,
    raceBestLapNum: null,
    currentCarStatus: null,
    currentCarTelemetry: null,
    currentPenalties: null,
    currentCarDamage: null
  };
}

// Разбор заголовка пакета и извлечение packetId, sessionUID, playerCarIndex
function parseHeader(buf) {
  if (buf.length < HEADER_SIZE) return null;
  let offset = 0;

  const packetFormat = buf.readUInt16LE(offset); // 2025
  offset += 2;
  const gameYear = buf.readUInt8(offset);
  offset += 1;
  const gameMajorVersion = buf.readUInt8(offset);
  offset += 1;
  const gameMinorVersion = buf.readUInt8(offset);
  offset += 1;
  const packetVersion = buf.readUInt8(offset);
  offset += 1;
  const packetId = buf.readUInt8(offset);
  offset += 1;

  const sessionUID = buf.readBigUInt64LE(offset);
  offset += 8;

  const sessionTime = buf.readFloatLE(offset);
  offset += 4;

  const frameIdentifier = buf.readUInt32LE(offset);
  offset += 4;

  const overallFrameIdentifier = buf.readUInt32LE(offset);
  offset += 4;

  const playerCarIndex = buf.readUInt8(offset);
  offset += 1;

  const secondaryPlayerCarIndex = buf.readUInt8(offset);
  offset += 1;

  return {
    packetFormat,
    gameYear,
    gameMajorVersion,
    gameMinorVersion,
    packetVersion,
    packetId,
    sessionUID,
    sessionTime,
    frameIdentifier,
    overallFrameIdentifier,
    playerCarIndex,
    secondaryPlayerCarIndex
  };
}

// Разбор LapData для одного автомобиля (только нужные поля)
function parseLapDataForCar(buf, baseOffset) {
  if (buf.length < baseOffset + LAP_DATA_SIZE) return null;

  const decodeMinutesMs = (msPart, minutesPart) => {
    // In some sessions the game uses sentinels for "not available".
    // Common pattern: msPart=65535 and/or minutesPart=255.
    if (msPart === 65535 || minutesPart === 255) return null;
    if (msPart === 0 && minutesPart === 0) return null;
    return msPart + minutesPart * 60 * 1000;
  };

  const lastLapTimeInMS = buf.readUInt32LE(baseOffset + 0);
  const currentLapTimeInMS = buf.readUInt32LE(baseOffset + 4);

  // Сектора: минуты + миллисекунды
  const sector1TimeMSPart = buf.readUInt16LE(baseOffset + 8);
  const sector1TimeMinutesPart = buf.readUInt8(baseOffset + 10);
  const sector2TimeMSPart = buf.readUInt16LE(baseOffset + 11);
  const sector2TimeMinutesPart = buf.readUInt8(baseOffset + 13);

  let sector1TimeMs = null;
  let sector2TimeMs = null;
  let sector3TimeMs = null;

  sector1TimeMs = decodeMinutesMs(sector1TimeMSPart, sector1TimeMinutesPart);
  sector2TimeMs = decodeMinutesMs(sector2TimeMSPart, sector2TimeMinutesPart);

  if (lastLapTimeInMS > 0 && sector1TimeMs != null && sector2TimeMs != null) {
    const s3 = lastLapTimeInMS - sector1TimeMs - sector2TimeMs;
    if (s3 >= 0) {
      sector3TimeMs = s3;
    }
  }

  // delta to race leader: minutes + ms parts
  const deltaToRaceLeaderMSPart = buf.readUInt16LE(baseOffset + 17);
  const deltaToRaceLeaderMinutesPart = buf.readUInt8(baseOffset + 19);
  const deltaToRaceLeaderMs = decodeMinutesMs(deltaToRaceLeaderMSPart, deltaToRaceLeaderMinutesPart);

  // delta to car in front: minutes + ms parts
  const deltaToCarInFrontMSPart = buf.readUInt16LE(baseOffset + 14);
  const deltaToCarInFrontMinutesPart = buf.readUInt8(baseOffset + 16);
  const deltaToCarInFrontMs = decodeMinutesMs(deltaToCarInFrontMSPart, deltaToCarInFrontMinutesPart);

  const lapDistance = buf.readFloatLE(baseOffset + 20);
  const totalDistance = buf.readFloatLE(baseOffset + 24);
  const safetyCarDelta = buf.readFloatLE(baseOffset + 28);

  const carPosition = buf.readUInt8(baseOffset + 32);
  const currentLapNum = buf.readUInt8(baseOffset + 33);
  const pitStatus = buf.readUInt8(baseOffset + 34);
  const numPitStops = buf.readUInt8(baseOffset + 35);
  const sector = buf.readUInt8(baseOffset + 36); // 0 = sector1, 1 = sector2, 2 = sector3
  const currentLapInvalid = buf.readUInt8(baseOffset + 37);
  const penaltiesSec = buf.readUInt8(baseOffset + 38);
  const totalWarnings = buf.readUInt8(baseOffset + 39);
  const cornerCuttingWarnings = buf.readUInt8(baseOffset + 40);
  const numUnservedDriveThroughPens = buf.readUInt8(baseOffset + 41);
  const numUnservedStopGoPens = buf.readUInt8(baseOffset + 42);
  const gridPosition = buf.readUInt8(baseOffset + 43);
  const driverStatus = buf.readUInt8(baseOffset + 44);
  const resultStatus = buf.readUInt8(baseOffset + 45);
  const pitLaneTimerActive = buf.readUInt8(baseOffset + 46);
  const pitLaneTimeInLaneInMS = buf.readUInt16LE(baseOffset + 47);
  const pitStopTimerInMS = buf.readUInt16LE(baseOffset + 49);
  const pitStopShouldServePen = buf.readUInt8(baseOffset + 51);
  const speedTrapFastestSpeed = buf.readFloatLE(baseOffset + 52);
  const speedTrapFastestLap = buf.readUInt8(baseOffset + 56);

  return {
    lastLapTimeInMS,
    currentLapTimeInMS,
    sector1TimeMs,
    sector2TimeMs,
    sector3TimeMs,
    deltaToRaceLeaderMs,
    deltaToCarInFrontMs,
    lapDistance,
    totalDistance,
    safetyCarDelta,
    carPosition,
    currentLapNum,
    pitStatus,
    numPitStops,
    sector,
    currentLapInvalid,
    penaltiesSec,
    totalWarnings,
    cornerCuttingWarnings,
    numUnservedDriveThroughPens,
    numUnservedStopGoPens,
    gridPosition,
    driverStatus,
    resultStatus,
    pitLaneTimerActive,
    pitLaneTimeInLaneInMS,
    pitStopTimerInMS,
    pitStopShouldServePen,
    speedTrapFastestSpeed,
    speedTrapFastestLap
  };
}

function parseParticipantName(buf, baseOffset) {
  // ParticipantData: first 7 bytes then name[cs_maxParticipantNameLen=32] utf8 null-terminated
  const NAME_LEN = 32;
  const nameOffset = baseOffset + 7;
  const nameBuf = buf.subarray(nameOffset, nameOffset + NAME_LEN);
  const zeroIdx = nameBuf.indexOf(0);
  const sliced = zeroIdx >= 0 ? nameBuf.subarray(0, zeroIdx) : nameBuf;
  const name = sliced.toString('utf8').trim();
  return name;
}

function parseParticipantMeta(buf, baseOffset) {
  const teamId = buf.readUInt8(baseOffset + 3);
  const numColours = buf.readUInt8(baseOffset + 44);
  // liveryColours[0]
  const r = buf.readUInt8(baseOffset + 45);
  const g = buf.readUInt8(baseOffset + 46);
  const b = buf.readUInt8(baseOffset + 47);
  return { teamId, numColours, colour: { r, g, b } };
}

function handleParticipantsPacket(buf) {
  const header = parseHeader(buf);
  if (!header) return;

  // Если началась новая сессия — сбрасываем состояние
  if (playerState.sessionUID === null || playerState.sessionUID !== header.sessionUID) {
    resetSessionState(header.sessionUID);
  }

  // PacketParticipantsData: header + numActiveCars + participants[22]
  numActiveCars = buf.readUInt8(HEADER_SIZE);
  const base = HEADER_SIZE + 1;
  if (buf.length < base + NUM_CARS * PARTICIPANT_DATA_SIZE) return;

  for (let i = 0; i < NUM_CARS; i++) {
    const off = base + i * PARTICIPANT_DATA_SIZE;
    const name = parseParticipantName(buf, off);
    if (name) {
      participantsNameByIndex.set(i, name);
      const meta = parseParticipantMeta(buf, off);
      participantsTeamIdByIndex.set(i, meta.teamId);
      participantsColorByIndex.set(i, meta.colour);
    }
  }
}

function parseLapHistoryEntry(buf, baseOffset) {
  const lapTimeMs = buf.readUInt32LE(baseOffset + 0);
  const s1ms = buf.readUInt16LE(baseOffset + 4);
  const s1min = buf.readUInt8(baseOffset + 6);
  const s2ms = buf.readUInt16LE(baseOffset + 7);
  const s2min = buf.readUInt8(baseOffset + 9);
  const s3ms = buf.readUInt16LE(baseOffset + 10);
  const s3min = buf.readUInt8(baseOffset + 12);
  const validFlags = buf.readUInt8(baseOffset + 13);

  const sector1TimeMs = s1ms !== 0 || s1min !== 0 ? s1ms + s1min * 60 * 1000 : null;
  const sector2TimeMs = s2ms !== 0 || s2min !== 0 ? s2ms + s2min * 60 * 1000 : null;
  const sector3TimeMs = s3ms !== 0 || s3min !== 0 ? s3ms + s3min * 60 * 1000 : null;

  return {
    lapTimeMs: lapTimeMs > 0 ? lapTimeMs : null,
    sector1TimeMs,
    sector2TimeMs,
    sector3TimeMs,
    validFlags
  };
}

function handleSessionHistoryPacket(buf) {
  const header = parseHeader(buf);
  if (!header) return;

  // Если началась новая сессия — сбрасываем состояние
  if (playerState.sessionUID === null || playerState.sessionUID !== header.sessionUID) {
    resetSessionState(header.sessionUID);
  }

  if (buf.length < HEADER_SIZE + 7) return;
  const carIdx = buf.readUInt8(HEADER_SIZE + 0);
  const numLaps = buf.readUInt8(HEADER_SIZE + 1);
  // const numTyreStints = buf.readUInt8(HEADER_SIZE + 2);
  // best lap/sector lap nums at +3..+6

  const lapHistoryBase = HEADER_SIZE + 7;
  if (buf.length < lapHistoryBase + LAP_HISTORY_DATA_SIZE) return;

  const byLap = new Map();
  const lapsToRead = Math.min(numLaps, 100);
  for (let i = 0; i < lapsToRead; i++) {
    const off = lapHistoryBase + i * LAP_HISTORY_DATA_SIZE;
    if (off + LAP_HISTORY_DATA_SIZE > buf.length) break;
    const entry = parseLapHistoryEntry(buf, off);
    // lap numbers are 1-based
    byLap.set(i + 1, entry);
  }
  sessionHistoryByCarIndex.set(carIdx, byLap);

  // If player: update already recorded personal laps with authoritative sector breakdown
  if (carIdx === header.playerCarIndex) {
    for (const [lapNum, entry] of byLap.entries()) {
      if (lapsByNumber.has(lapNum)) {
        // Для Personal не "дозаполняем" сектора старым значением:
        // обновляем только когда в history есть полный круг.
        if (entry.lapTimeMs != null) {
          const l = lapsByNumber.get(lapNum);
          l.lapTimeMs = entry.lapTimeMs;
          l.sector1TimeMs = entry.sector1TimeMs;
          l.sector2TimeMs = entry.sector2TimeMs;
          l.sector3TimeMs = entry.sector3TimeMs;
          lapsByNumber.set(lapNum, l);
        }
      }
    }
    recomputeFromLaps();
  }
}

// Разбор CarStatusData для одного автомобиля (полностью)
function parseCarStatusForCar(buf, baseOffset) {
  if (buf.length < baseOffset + CAR_STATUS_DATA_SIZE) return null;

  // См. F1_25_Telemetry_Output_Structures.md CarStatusData
  let o = baseOffset;
  const tractionControl = buf.readUInt8(o); o += 1;
  const antiLockBrakes = buf.readUInt8(o); o += 1;
  const fuelMix = buf.readUInt8(o); o += 1;
  const frontBrakeBias = buf.readUInt8(o); o += 1;
  const pitLimiterStatus = buf.readUInt8(o); o += 1;
  const fuelInTank = buf.readFloatLE(o); o += 4;
  const fuelCapacity = buf.readFloatLE(o); o += 4;
  const fuelRemainingLaps = buf.readFloatLE(o); o += 4;
  const maxRPM = buf.readUInt16LE(o); o += 2;
  const idleRPM = buf.readUInt16LE(o); o += 2;
  const maxGears = buf.readUInt8(o); o += 1;
  const drsAllowed = buf.readUInt8(o); o += 1;
  const drsActivationDistance = buf.readUInt16LE(o); o += 2;
  const actualTyreCompound = buf.readUInt8(o); o += 1;
  const visualTyreCompound = buf.readUInt8(o); o += 1;
  const tyresAgeLaps = buf.readUInt8(o); o += 1;
  const vehicleFIAFlags = buf.readInt8(o); o += 1;
  const enginePowerICE = buf.readFloatLE(o); o += 4;
  const enginePowerMGUK = buf.readFloatLE(o); o += 4;
  const ersStoreEnergy = buf.readFloatLE(o); o += 4;
  const ersDeployMode = buf.readUInt8(o); o += 1;
  const ersHarvestedThisLapMGUK = buf.readFloatLE(o); o += 4;
  const ersHarvestedThisLapMGUH = buf.readFloatLE(o); o += 4;
  const ersDeployedThisLap = buf.readFloatLE(o); o += 4;
  const networkPaused = buf.readUInt8(o); o += 1;

  return {
    tractionControl,
    antiLockBrakes,
    fuelMix,
    frontBrakeBias,
    pitLimiterStatus,
    fuelInTank,
    fuelCapacity,
    fuelRemainingLaps,
    maxRPM,
    idleRPM,
    maxGears,
    drsAllowed,
    drsActivationDistance,
    actualTyreCompound,
    visualTyreCompound,
    tyresAgeLaps,
    vehicleFIAFlags,
    enginePowerICE,
    enginePowerMGUK,
    ersStoreEnergy,
    ersDeployMode,
    ersHarvestedThisLapMGUK,
    ersHarvestedThisLapMGUH,
    ersDeployedThisLap,
    networkPaused
  };
}

function handleCarStatusPacket(buf) {
  const header = parseHeader(buf);
  if (!header) return;

  // Если началась новая сессия — сбрасываем состояние
  if (playerState.sessionUID === null || playerState.sessionUID !== header.sessionUID) {
    resetSessionState(header.sessionUID);
  }

  const { playerCarIndex } = header;

  // Обновить кэш по всем машинам
  for (let i = 0; i < NUM_CARS; i++) {
    const baseOffset = HEADER_SIZE + i * CAR_STATUS_DATA_SIZE;
    const status = parseCarStatusForCar(buf, baseOffset);
    if (!status) continue;
    carStatusByIndex.set(i, status);
  }

  // И отдельно — в playerState (для персональной таблицы)
  if (playerCarIndex < NUM_CARS) {
    const ps = carStatusByIndex.get(playerCarIndex);
    if (ps) {
      playerState.currentTyreActualCompound = ps.actualTyreCompound;
      playerState.currentTyreVisualCompound = ps.visualTyreCompound;
      playerState.currentTyresAgeLaps = ps.tyresAgeLaps;
      lapsState.currentCarStatus = ps;
    }
  }

  // Если CarStatus пришёл позже LapData на первом круге — дозаполним снимок шин для текущего круга
  if (playerState.currentLapNum != null) {
    const lapNum = playerState.currentLapNum;
    const existing = tyreByLapStart.get(lapNum);
    if (
      existing == null ||
      (existing.tyreVisualCompound == null && playerState.currentTyreVisualCompound != null) ||
      (existing.tyreActualCompound == null && playerState.currentTyreActualCompound != null)
    ) {
      tyreByLapStart.set(lapNum, {
        tyreActualCompound: playerState.currentTyreActualCompound,
        tyreVisualCompound: playerState.currentTyreVisualCompound,
        tyresAgeLaps: playerState.currentTyresAgeLaps
      });
    }
  }
}

function parseCarTelemetryForCar(buf, baseOffset) {
  if (buf.length < baseOffset + CAR_TELEMETRY_DATA_SIZE) return null;
  let o = baseOffset;
  const speedKph = buf.readUInt16LE(o); o += 2;
  const throttle = buf.readFloatLE(o); o += 4;
  const steer = buf.readFloatLE(o); o += 4;
  const brake = buf.readFloatLE(o); o += 4;
  const clutch = buf.readUInt8(o); o += 1;
  const gear = buf.readInt8(o); o += 1;
  const engineRPM = buf.readUInt16LE(o); o += 2;
  const drs = buf.readUInt8(o); o += 1;
  const revLightsPercent = buf.readUInt8(o); o += 1;
  const revLightsBitValue = buf.readUInt16LE(o); o += 2;
  const brakesTemperature = [
    buf.readUInt16LE(o), buf.readUInt16LE(o + 2), buf.readUInt16LE(o + 4), buf.readUInt16LE(o + 6)
  ];
  o += 8;
  const tyresSurfaceTemperature = [buf.readUInt8(o), buf.readUInt8(o + 1), buf.readUInt8(o + 2), buf.readUInt8(o + 3)];
  o += 4;
  const tyresInnerTemperature = [buf.readUInt8(o), buf.readUInt8(o + 1), buf.readUInt8(o + 2), buf.readUInt8(o + 3)];
  o += 4;
  const engineTemperature = buf.readUInt16LE(o); o += 2;
  const tyresPressure = [
    buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8), buf.readFloatLE(o + 12)
  ];
  o += 16;
  const surfaceType = [buf.readUInt8(o), buf.readUInt8(o + 1), buf.readUInt8(o + 2), buf.readUInt8(o + 3)];

  return {
    speedKph,
    throttle,
    steer,
    brake,
    clutch,
    gear,
    engineRPM,
    drs,
    revLightsPercent,
    revLightsBitValue,
    brakesTemperature,
    tyresSurfaceTemperature,
    tyresInnerTemperature,
    engineTemperature,
    tyresPressure,
    surfaceType
  };
}

function parseCarDamageForCar(buf, baseOffset) {
  const perCarSize = Math.floor((buf.length - HEADER_SIZE) / NUM_CARS);
  const needed = Math.min(CAR_DAMAGE_DATA_SIZE, perCarSize || 0);
  if (needed <= 0) return null;
  if (buf.length < baseOffset + needed) return null;
  let o = baseOffset;

  const tyresWear = [
    buf.readFloatLE(o),
    buf.readFloatLE(o + 4),
    buf.readFloatLE(o + 8),
    buf.readFloatLE(o + 12)
  ];
  o += 16;

  const tyresDamage = [
    buf.readUInt8(o),
    buf.readUInt8(o + 1),
    buf.readUInt8(o + 2),
    buf.readUInt8(o + 3)
  ];
  o += 4;

  const brakesDamage = [
    buf.readUInt8(o),
    buf.readUInt8(o + 1),
    buf.readUInt8(o + 2),
    buf.readUInt8(o + 3)
  ];
  o += 4;

  const tyreBlisters = [
    buf.readUInt8(o),
    buf.readUInt8(o + 1),
    buf.readUInt8(o + 2),
    buf.readUInt8(o + 3)
  ];
  o += 4;

  const frontLeftWingDamage = buf.readUInt8(o); o += 1;
  const frontRightWingDamage = buf.readUInt8(o); o += 1;
  const rearWingDamage = buf.readUInt8(o); o += 1;
  const floorDamage = buf.readUInt8(o); o += 1;
  const diffuserDamage = buf.readUInt8(o); o += 1;
  const sidepodDamage = buf.readUInt8(o); o += 1;
  const drsFault = buf.readUInt8(o); o += 1;
  const ersFault = buf.readUInt8(o); o += 1;
  const gearBoxDamage = buf.readUInt8(o); o += 1;
  const engineDamage = buf.readUInt8(o); o += 1;
  const engineMGUHWear = buf.readUInt8(o); o += 1;
  const engineESWear = buf.readUInt8(o); o += 1;
  const engineCEWear = buf.readUInt8(o); o += 1;
  const engineICEWear = buf.readUInt8(o); o += 1;
  const engineMGUKWear = buf.readUInt8(o); o += 1;
  const engineTCWear = buf.readUInt8(o); o += 1;
  const engineBlown = buf.readUInt8(o); o += 1;
  const engineSeized = buf.readUInt8(o); o += 1;

  return {
    tyresWear,
    tyresDamage,
    brakesDamage,
    tyreBlisters,
    frontLeftWingDamage,
    frontRightWingDamage,
    rearWingDamage,
    floorDamage,
    diffuserDamage,
    sidepodDamage,
    drsFault,
    ersFault,
    gearBoxDamage,
    engineDamage,
    engineMGUHWear,
    engineESWear,
    engineCEWear,
    engineICEWear,
    engineMGUKWear,
    engineTCWear,
    engineBlown,
    engineSeized
  };
}

function handleCarTelemetryPacket(buf) {
  const header = parseHeader(buf);
  if (!header) return;

  if (playerState.sessionUID === null || playerState.sessionUID !== header.sessionUID) {
    resetSessionState(header.sessionUID);
  }

  const { playerCarIndex } = header;
  // PacketCarTelemetryData: header + carTelemetryData[22] + 3 bytes
  for (let i = 0; i < NUM_CARS; i++) {
    const baseOffset = HEADER_SIZE + i * CAR_TELEMETRY_DATA_SIZE;
    const tel = parseCarTelemetryForCar(buf, baseOffset);
    if (!tel) continue;
    carTelemetryByIndex.set(i, tel);
  }

  if (playerCarIndex < NUM_CARS) {
    const t = carTelemetryByIndex.get(playerCarIndex);
    if (t) {
      lapsState.currentCarTelemetry = t;
    }
  }
}

function handleCarDamagePacket(buf) {
  const header = parseHeader(buf);
  if (!header) return;

  if (playerState.sessionUID === null || playerState.sessionUID !== header.sessionUID) {
    resetSessionState(header.sessionUID);
  }

  const { playerCarIndex } = header;
  for (let i = 0; i < NUM_CARS; i++) {
    const baseOffset = HEADER_SIZE + i * CAR_DAMAGE_DATA_SIZE;
    const dmg = parseCarDamageForCar(buf, baseOffset);
    if (!dmg) continue;
    carDamageByIndex.set(i, dmg);
  }

  if (playerCarIndex < NUM_CARS) {
    const d = carDamageByIndex.get(playerCarIndex);
    if (d) {
      lapsState.currentCarDamage = d;
    }
  }

  broadcastState();
}

function handleSessionPacket(buf) {
  const header = parseHeader(buf);
  if (!header) return;

  // Если началась новая сессия — сбрасываем состояние
  if (playerState.sessionUID === null || playerState.sessionUID !== header.sessionUID) {
    resetSessionState(header.sessionUID);
  }

  // PacketSessionData layout (после header):
  // weather(0), trackTemp(int8)(1), airTemp(int8)(2), totalLaps(3),
  // trackLength(u16)(4..5), sessionType(6), trackId(int8)(7),
  // formula(8), sessionTimeLeft(u16)(9..10), sessionDuration(u16)(11..12), pitSpeedLimit(13)
  if (buf.length < HEADER_SIZE + 14) return;
  const totalLaps = buf.readUInt8(HEADER_SIZE + 3);
  const sessionType = buf.readUInt8(HEADER_SIZE + 6);
  const trackLengthM = buf.readUInt16LE(HEADER_SIZE + 4);
  const trackId = buf.readInt8(HEADER_SIZE + 7);
  const weather = buf.readUInt8(HEADER_SIZE + 0);
  const trackTemperatureC = buf.readInt8(HEADER_SIZE + 1);
  const airTemperatureC = buf.readInt8(HEADER_SIZE + 2);
  const formula = buf.readUInt8(HEADER_SIZE + 8);
  const sessionTimeLeftSec = buf.readUInt16LE(HEADER_SIZE + 9);
  const sessionDurationSec = buf.readUInt16LE(HEADER_SIZE + 11);
  const pitSpeedLimitKph = buf.readUInt8(HEADER_SIZE + 13);

  lapsState.totalLaps = totalLaps;
  lapsState.sessionType = sessionType;
  lapsState.trackLengthM = trackLengthM;
  lapsState.trackId = trackId;
  lapsState.weather = weather;
  lapsState.trackTemperatureC = trackTemperatureC;
  lapsState.airTemperatureC = airTemperatureC;
  lapsState.formula = formula;
  lapsState.sessionTimeLeftSec = sessionTimeLeftSec;
  lapsState.sessionDurationSec = sessionDurationSec;
  lapsState.pitSpeedLimitKph = pitSpeedLimitKph;

  // Determine session kind using m_sessionType (more reliable than totalLaps).
  // Values are consistent with recent F1 UDP specs:
  // 1..4 practice, 5..9 qualifying variants, 10/11 race variants, 12 time trial.
  const isPractice = sessionType >= 1 && sessionType <= 4;
  const isQuali = sessionType >= 5 && sessionType <= 9;
  const isTimeTrial = sessionType === 12;
  const isRaceLike = sessionType === 10 || sessionType === 11 || sessionType === 13 || sessionType === 14 || sessionType === 15;

  if (isTimeTrial) lapsState.sessionKind = 'time_trial';
  else if (isRaceLike) lapsState.sessionKind = 'race';
  else if (isPractice || isQuali) lapsState.sessionKind = 'time_attack';
  else lapsState.sessionKind = totalLaps > 0 ? 'race' : 'time_attack';
}

function handleLapDataPacket(buf) {
  const header = parseHeader(buf);
  if (!header) return;

  // Если началась новая сессия — сбрасываем состояние
  if (playerState.sessionUID === null || playerState.sessionUID !== header.sessionUID) {
    resetSessionState(header.sessionUID);
  }

  // Отметить, что подключение активно
  lapsState.isConnected = true;

  const { playerCarIndex } = header;
  lapsState.playerCarIndex = playerCarIndex;

  // 1) Считать LapData по всем машинам (для race таблицы и поиска лучших секторов)
  for (let i = 0; i < NUM_CARS; i++) {
    const baseOffset = HEADER_SIZE + i * LAP_DATA_SIZE;
    const lap = parseLapDataForCar(buf, baseOffset);
    if (!lap) continue;

    // Pit lane: стинт по каждой машине (как в Personal, но без "привязки к таблице кругов")
    const pitPrev = pitLaneStintByIndex.get(i) || {
      active: false,
      startLapNum: null,
      maxTimeMs: 0,
      statusMax: 0,
      lastTimeMs: null,
      lastStatusMax: 0,
      lastLapNum: null
    };
    if (lap.pitLaneTimerActive === 1) {
      if (!pitPrev.active) {
        pitPrev.active = true;
        pitPrev.startLapNum = lap.currentLapNum;
        pitPrev.maxTimeMs = 0;
        pitPrev.statusMax = 0;
      }
      if (lap.pitLaneTimeInLaneInMS > 0) {
        pitPrev.maxTimeMs = Math.max(pitPrev.maxTimeMs, lap.pitLaneTimeInLaneInMS);
      }
      if (lap.pitStatus > 0) {
        pitPrev.statusMax = Math.max(pitPrev.statusMax, lap.pitStatus);
      }
    } else if (pitPrev.active) {
      // стинт завершился
      pitPrev.active = false;
      pitPrev.lastTimeMs = pitPrev.maxTimeMs > 0 ? pitPrev.maxTimeMs : null;
      pitPrev.lastStatusMax = pitPrev.statusMax;
      pitPrev.lastLapNum = pitPrev.startLapNum;
      pitPrev.startLapNum = null;
      pitPrev.maxTimeMs = 0;
      pitPrev.statusMax = 0;
    }
    pitLaneStintByIndex.set(i, pitPrev);

    // Сектора: не сбрасываем. Если сектор не пришёл в пакете (0), оставляем последнее значение.
    const prev = sectorCacheByIndex.get(i) || {
      sector1TimeMs: null,
      sector2TimeMs: null,
      sector3TimeMs: null
    };
    const next = {
      sector1TimeMs: lap.sector1TimeMs != null ? lap.sector1TimeMs : prev.sector1TimeMs,
      sector2TimeMs: lap.sector2TimeMs != null ? lap.sector2TimeMs : prev.sector2TimeMs,
      sector3TimeMs: lap.sector3TimeMs != null ? lap.sector3TimeMs : prev.sector3TimeMs
    };
    sectorCacheByIndex.set(i, next);

    lapDataByIndex.set(i, {
      ...lap,
      sector1TimeMs: next.sector1TimeMs,
      sector2TimeMs: next.sector2TimeMs,
      sector3TimeMs: next.sector3TimeMs
    });
  }

  // Построить raceCars из последних данных (фильтруем неактивные / без имени)
  const raceCarsRaw = Array.from(lapDataByIndex.entries())
    .filter(([carIndex, lap]) => {
      const name = participantsNameByIndex.get(carIndex);
      if (!name) return false;

      // В красные флаги/паузы игра может временно менять numActiveCars, position и resultStatus.
      // Правило: игрок всегда отображается, даже если данные "в переходном" состоянии.
      if (carIndex === playerCarIndex) return true;

      if (numActiveCars != null && numActiveCars > 0 && carIndex >= numActiveCars) return false;

      // resultStatus: 0 invalid, 1 inactive, 2 active, 3 finished, 4..7 other end states
      // Не показываем только "invalid".
      if (lap.resultStatus === 0) return false;

      return true;
    })
    .map(([carIndex, lap]) => {
    const name = participantsNameByIndex.get(carIndex);
    const cs = carStatusByIndex.get(carIndex);
    const pcol = participantsColorByIndex.get(carIndex);
    const teamId = participantsTeamIdByIndex.get(carIndex);
    const pit = pitLaneStintByIndex.get(carIndex);
    const pitLaneTimeMs =
      pit?.active ? (pit.maxTimeMs > 0 ? pit.maxTimeMs : null) : (pit?.lastTimeMs ?? null);
    const pitStatusMax =
      pit?.active ? (pit.statusMax ?? lap.pitStatus) : (pit?.lastStatusMax ?? 0);
    const sh = sessionHistoryByCarIndex.get(carIndex);

    // last completed lap entry (for race-like sessions)
    const lastLapNum = lap.currentLapNum > 0 ? lap.currentLapNum - 1 : null;
    const shLast = lastLapNum != null ? sh?.get(lastLapNum) : null;

    // best lap entry (for quali/practice leaderboards)
    let bestLapTimeMs = null;
    let bestLapNum = null;
    let bestS1 = null;
    let bestS2 = null;
    let bestS3 = null;
    if (sh) {
      for (const [lapNum, entry] of sh.entries()) {
        if (!entry || entry.lapTimeMs == null || entry.lapTimeMs <= 0) continue;
        // Respect "lap valid" flag when present (bit 0x01).
        if (entry.validFlags != null && (entry.validFlags & 0x01) === 0) continue;
        if (bestLapTimeMs == null || entry.lapTimeMs < bestLapTimeMs) {
          bestLapTimeMs = entry.lapTimeMs;
          bestLapNum = lapNum;
          bestS1 = entry.sector1TimeMs ?? null;
          bestS2 = entry.sector2TimeMs ?? null;
          bestS3 = entry.sector3TimeMs ?? null;
        }
      }
    }

    const isTimeAttack = lapsState.sessionKind === 'time_attack';
    const displayLapTimeMs = isTimeAttack
      ? bestLapTimeMs
      : (shLast?.lapTimeMs ?? (lap.lastLapTimeInMS > 0 ? lap.lastLapTimeInMS : null));
    const displayS1 = isTimeAttack ? bestS1 : (shLast?.sector1TimeMs ?? lap.sector1TimeMs);
    const displayS2 = isTimeAttack ? bestS2 : (shLast?.sector2TimeMs ?? lap.sector2TimeMs);
    const displayS3 = isTimeAttack ? bestS3 : (shLast?.sector3TimeMs ?? lap.sector3TimeMs);
    return {
      carIndex,
      name,
      teamId: teamId ?? null,
      teamColour: pcol ? { r: pcol.r, g: pcol.g, b: pcol.b } : null,
      position: lap.carPosition,
      lapNumber: lap.currentLapNum,
      lapTimeMs: displayLapTimeMs,
      bestLapTimeMs: bestLapTimeMs,
      bestLapNum: bestLapNum,
      gapToLeaderMs: lap.deltaToRaceLeaderMs,
      gapToCarAheadMs: lap.deltaToCarInFrontMs,
      sector1TimeMs: displayS1,
      sector2TimeMs: displayS2,
      sector3TimeMs: displayS3,
      tyreActualCompound: cs?.actualTyreCompound ?? null,
      tyreVisualCompound: cs?.visualTyreCompound ?? null,
      tyresAgeLaps: cs?.tyresAgeLaps ?? null,
      pitStatus: pitStatusMax,
      pitLaneTimeMs,
      stops: lap.numPitStops,
      lapDistance: lap.lapDistance
    };
  });

  // Для practice/quali (time-attack) дельты часто пустые — считаем gap как разницу лучших кругов.
  let raceCars = raceCarsRaw;
  if (lapsState.sessionKind === 'time_attack') {
    const sorted = raceCarsRaw
      .slice()
      .sort((a, b) => {
        const at = a.lapTimeMs ?? Number.POSITIVE_INFINITY;
        const bt = b.lapTimeMs ?? Number.POSITIVE_INFINITY;
        if (at !== bt) return at - bt;
        return (a.position ?? 999) - (b.position ?? 999);
      });
    for (let i = 0; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (i === 0) {
        cur.gapToCarAheadMs = null;
      } else if (cur.lapTimeMs != null && prev?.lapTimeMs != null) {
        cur.gapToCarAheadMs = cur.lapTimeMs - prev.lapTimeMs;
      } else {
        cur.gapToCarAheadMs = null;
      }
    }
    // keep original order by position for UI stability, but with fixed computed gaps
    const byCarIndex = new Map(sorted.map((c) => [c.carIndex, c]));
    raceCars = raceCarsRaw.map((c) => byCarIndex.get(c.carIndex) || c);
  } else {
    // Для гонки: если нет gapToCarAhead, считаем его как разницу от лидера.
    const sorted = raceCarsRaw
      .slice()
      .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    for (let i = 0; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.position === 1) {
        cur.gapToCarAheadMs = null;
        continue;
      }
      if (cur.gapToCarAheadMs == null && cur.gapToLeaderMs != null && prev?.gapToLeaderMs != null) {
        const d = cur.gapToLeaderMs - prev.gapToLeaderMs;
        cur.gapToCarAheadMs = d >= 0 ? d : null;
      }
    }
    const byCarIndex = new Map(sorted.map((c) => [c.carIndex, c]));
    raceCars = raceCarsRaw.map((c) => byCarIndex.get(c.carIndex) || c);
  }

  // Теперь считаем best sectors по отображаемым гонщикам, чтобы подсветка всегда была у кого-то в списке.
  let raceBestLapNumLocal = raceBestLapNum;
  for (const c of raceCars) {
    if (c.lapTimeMs != null && c.lapTimeMs > 0 && (raceBestLapTimeMs == null || c.lapTimeMs < raceBestLapTimeMs)) {
      raceBestLapTimeMs = c.lapTimeMs;
      raceBestLapCarIndex = c.carIndex;
      raceBestLapNumLocal = c.bestLapNum ?? (c.lapNumber != null ? c.lapNumber - 1 : null);
    }
    if (
      c.sector1TimeMs != null &&
      (raceBestSector1TimeMs == null || c.sector1TimeMs < raceBestSector1TimeMs)
    ) {
      raceBestSector1TimeMs = c.sector1TimeMs;
      raceBestSector1CarIndex = c.carIndex;
    }
    if (
      c.sector2TimeMs != null &&
      (raceBestSector2TimeMs == null || c.sector2TimeMs < raceBestSector2TimeMs)
    ) {
      raceBestSector2TimeMs = c.sector2TimeMs;
      raceBestSector2CarIndex = c.carIndex;
    }
    if (
      c.sector3TimeMs != null &&
      (raceBestSector3TimeMs == null || c.sector3TimeMs < raceBestSector3TimeMs)
    ) {
      raceBestSector3TimeMs = c.sector3TimeMs;
      raceBestSector3CarIndex = c.carIndex;
    }
  }

  lapsState.raceCars = raceCars;
  lapsState.raceBestSector1TimeMs = raceBestSector1TimeMs;
  lapsState.raceBestSector2TimeMs = raceBestSector2TimeMs;
  lapsState.raceBestSector3TimeMs = raceBestSector3TimeMs;
  lapsState.raceBestSector1CarIndex = raceBestSector1CarIndex;
  lapsState.raceBestSector2CarIndex = raceBestSector2CarIndex;
  lapsState.raceBestSector3CarIndex = raceBestSector3CarIndex;
  lapsState.raceBestLapTimeMs = raceBestLapTimeMs;
  lapsState.raceBestLapCarIndex = raceBestLapCarIndex;
  lapsState.raceBestLapNum = raceBestLapNumLocal;
  raceBestLapNum = raceBestLapNumLocal;

  // 2) Персональная логика — только по игроку
  if (playerCarIndex >= NUM_CARS) return;
  const lap = lapDataByIndex.get(playerCarIndex);
  if (!lap) return;

  const {
    lastLapTimeInMS,
    currentLapTimeInMS,
    sector1TimeMs,
    sector2TimeMs,
    sector3TimeMs,
    currentLapNum,
    pitStatus,
    numPitStops,
    sector,
    currentLapInvalid,
    penaltiesSec,
    totalWarnings,
    cornerCuttingWarnings,
    numUnservedDriveThroughPens,
    numUnservedStopGoPens,
    resultStatus,
    pitLaneTimerActive,
    pitLaneTimeInLaneInMS,
    pitStopTimerInMS,
    pitStopShouldServePen
  } = lap;

  const isRaceSession = lapsState.sessionKind === 'race';

  lapsState.currentPenalties = {
    penaltiesSec,
    totalWarnings,
    cornerCuttingWarnings,
    numUnservedDriveThroughPens,
    numUnservedStopGoPens,
    pitStopShouldServePen
  };

  // Flashback: откатились назад по кругам — обрезаем историю "в будущее", чтобы не было дубликатов
  if (playerState.currentLapNum != null && currentLapNum < playerState.currentLapNum) {
    for (const lapNum of Array.from(lapsByNumber.keys())) {
      if (lapNum >= currentLapNum) lapsByNumber.delete(lapNum);
    }
    for (const lapNum of Array.from(tyreByLapStart.keys())) {
      if (lapNum >= currentLapNum) tyreByLapStart.delete(lapNum);
    }
    for (const lapNum of Array.from(pitLaneTimeByLap.keys())) {
      if (lapNum >= currentLapNum) pitLaneTimeByLap.delete(lapNum);
    }
    for (const lapNum of Array.from(pitLaneStatusByLap.keys())) {
      if (lapNum >= currentLapNum) pitLaneStatusByLap.delete(lapNum);
    }

    // Сбросить текущий pit-lane стинт, чтобы не смешивать таймлайны
    playerState.pitLaneActive = false;
    playerState.pitLaneStartLapNum = null;
    playerState.pitLaneMaxTimeMs = 0;
    playerState.pitLanePitStatusMax = 0;

    recomputeFromLaps();
  }

  // Зафиксировать шины на начале круга (только первый раз, когда увидели этот lapNum)
  if (!tyreByLapStart.has(currentLapNum)) {
    tyreByLapStart.set(currentLapNum, {
      tyreActualCompound: playerState.currentTyreActualCompound,
      tyreVisualCompound: playerState.currentTyreVisualCompound,
      tyresAgeLaps: playerState.currentTyresAgeLaps
    });
  }

  // Pit lane: трекаем как стинт, чтобы корректно посчитать, даже если он закончится после S/F
  if (pitLaneTimerActive === 1) {
    if (!playerState.pitLaneActive) {
      playerState.pitLaneActive = true;
      playerState.pitLaneStartLapNum = currentLapNum;
      playerState.pitLaneMaxTimeMs = 0;
      playerState.pitLanePitStatusMax = 0;
    }

    if (pitLaneTimeInLaneInMS > 0) {
      playerState.pitLaneMaxTimeMs = Math.max(playerState.pitLaneMaxTimeMs, pitLaneTimeInLaneInMS);
    }
    if (pitStatus > 0) {
      playerState.pitLanePitStatusMax = Math.max(playerState.pitLanePitStatusMax, pitStatus);
    }
  } else if (playerState.pitLaneActive) {
    // стинт завершился — сохраняем итог на круге, где pit-lane начался
    const lapNum = playerState.pitLaneStartLapNum;
    const timeMs = playerState.pitLaneMaxTimeMs;
    const statusMax = playerState.pitLanePitStatusMax;

    playerState.pitLaneActive = false;
    playerState.pitLaneStartLapNum = null;
    playerState.pitLaneMaxTimeMs = 0;
    playerState.pitLanePitStatusMax = 0;

    if (lapNum != null && timeMs > 0) {
      pitLaneTimeByLap.set(lapNum, timeMs);
      pitLaneStatusByLap.set(lapNum, statusMax);

      // если круг уже есть в истории — обновим задним числом
      if (lapsByNumber.has(lapNum)) {
        const entry = lapsByNumber.get(lapNum);
        entry.pitLaneTimeMs = timeMs;
        entry.pitStatus = statusMax;
        lapsByNumber.set(lapNum, entry);
        recomputeFromLaps();
      }
    }
  }

  // Обновляем кэш по секторам для текущего круга
  if (sector1TimeMs != null) {
    playerState.currentSector1TimeMs = sector1TimeMs;
  }
  if (sector2TimeMs != null) {
    playerState.currentSector2TimeMs = sector2TimeMs;
  }

  // Обновляем live time
  lapsState.liveLapTimeMs = currentLapTimeInMS;

  // Live-строка текущего круга (обновляется "в моменте")
  const liveTyre = tyreByLapStart.get(currentLapNum) ?? {
    tyreActualCompound: playerState.currentTyreActualCompound,
    tyreVisualCompound: playerState.currentTyreVisualCompound,
    tyresAgeLaps: playerState.currentTyresAgeLaps
  };

  // Для live-подсветки лучших секторов (как только сектор появился), учитываем текущий круг,
  // но только если круг валидный (в гонке всегда валидный).
  const currentLapIsValid = isRaceSession ? true : currentLapInvalid === 0;
  if (currentLapIsValid) {
    if (
      sector >= 1 &&
      sector1TimeMs != null &&
      (lapsState.bestSector1TimeMs == null || sector1TimeMs < lapsState.bestSector1TimeMs)
    ) {
      lapsState.bestSector1TimeMs = sector1TimeMs;
    }
    if (
      sector >= 2 &&
      sector2TimeMs != null &&
      (lapsState.bestSector2TimeMs == null || sector2TimeMs < lapsState.bestSector2TimeMs)
    ) {
      lapsState.bestSector2TimeMs = sector2TimeMs;
    }
  } else {
    // Если круг стал невалидным (TT), откатываем best sectors к состоянию по завершенным кругам
    recomputeFromLaps();
  }

  lapsState.currentLap = {
    lapNumber: currentLapNum,
    lapTimeMs: currentLapTimeInMS,
    deltaMs: lapsState.bestLapTimeMs != null ? currentLapTimeInMS - lapsState.bestLapTimeMs : null,
    valid: isRaceSession ? true : currentLapInvalid === 0,
    isBest: false,
    // Personal live: показываем сектор только когда он действительно завершён
    sector1TimeMs: sector >= 1 ? sector1TimeMs : null,
    sector2TimeMs: sector >= 2 ? sector2TimeMs : null,
    // Не предзаполняем S3 на live-строке:
    // sector3 мы рассчитываем только для завершенного круга (или он может относиться к lastLapTime).
    sector3TimeMs: null,
    tyreActualCompound: liveTyre.tyreActualCompound,
    tyreVisualCompound: liveTyre.tyreVisualCompound,
    tyresAgeLaps: liveTyre.tyresAgeLaps,
    pitStatus,
    pitLaneTimeMs: pitLaneTimerActive === 1 ? pitLaneTimeInLaneInMS : null,
    numPitStops
  };

  // Детект завершения круга: номер круга увеличился
  if (
    playerState.currentLapNum !== null &&
    currentLapNum > playerState.currentLapNum &&
    lastLapTimeInMS > 0
  ) {
    const finishedLapNum = playerState.currentLapNum;
    const valid = isRaceSession ? true : playerState.currentLapInvalid === 0;

    const finishedTyre = tyreByLapStart.get(finishedLapNum) ?? {
      tyreActualCompound: playerState.currentTyreActualCompound,
      tyreVisualCompound: playerState.currentTyreVisualCompound,
      tyresAgeLaps: playerState.currentTyresAgeLaps
    };

    // Personal: сектора привязываем к конкретному кругу (из SessionHistory, если есть),
    // чтобы не было "переноса" значений между кругами.
    const playerHistory = sessionHistoryByCarIndex.get(playerCarIndex);
    const historyEntry = playerHistory?.get(finishedLapNum);

    const lapTimeMs = historyEntry?.lapTimeMs ?? lastLapTimeInMS;
    const s1 = historyEntry?.sector1TimeMs ?? playerState.currentSector1TimeMs;
    const s2 = historyEntry?.sector2TimeMs ?? playerState.currentSector2TimeMs;
    let s3 = null;
    if (historyEntry?.sector3TimeMs != null) {
      s3 = historyEntry.sector3TimeMs;
    } else if (s1 != null && s2 != null && lapTimeMs > 0) {
      const candidate = lapTimeMs - s1 - s2;
      if (candidate >= 0) {
        s3 = candidate;
      }
    }

    // Дельта к best lap (а не к предыдущему кругу)
    const lapEntry = {
      lapNumber: finishedLapNum,
      lapTimeMs,
      deltaMs: null,
      valid,
      isBest: false,
      sector1TimeMs: s1,
      sector2TimeMs: s2,
      sector3TimeMs: s3,
      tyreActualCompound: finishedTyre.tyreActualCompound,
      tyreVisualCompound: finishedTyre.tyreVisualCompound,
      tyresAgeLaps: finishedTyre.tyresAgeLaps,
      pitStatus: pitLaneStatusByLap.get(finishedLapNum) ?? 0,
      pitLaneTimeMs: pitLaneTimeByLap.get(finishedLapNum) ?? null,
      numPitStops
    };

    lapsByNumber.set(finishedLapNum, lapEntry);
    recomputeFromLaps();

    // После фиксации круга очищаем кэш секторов для нового круга
    playerState.currentSector1TimeMs = null;
    playerState.currentSector2TimeMs = null;
    // pit lane не сбрасываем по S/F — это делается по pitLaneTimerActive переходу
  }

  // Обновляем текущее состояние игрока
  playerState.currentLapNum = currentLapNum;
  playerState.currentLapInvalid = currentLapInvalid;

  // Обновить дельту live к лучшему кругу (обратный отсчет от best lap)
  if (lapsState.bestLapTimeMs != null && lapsState.liveLapTimeMs > 0) {
    // Положительное значение означает, сколько миллисекунд осталось до best lap
    lapsState.liveDeltaToBestMs = lapsState.bestLapTimeMs - lapsState.liveLapTimeMs;
  } else {
    lapsState.liveDeltaToBestMs = null;
  }

  broadcastState();
}

// Запустить HTTP/WebSocket-сервер
server.listen(HTTP_PORT, () => {
  console.log(`HTTP/WebSocket server running at http://localhost:${HTTP_PORT}`);

  if (DEMO_MODE) {
    console.log('Demo mode: generating fake telemetry (no UDP required).');
    startDemoFeed();
    return;
  }

  // UDP-сервер для приема пакетов от игры
  const udpServer = dgram.createSocket('udp4');

  udpServer.on('listening', () => {
    const address = udpServer.address();
    console.log(`UDP server listening on ${address.address}:${address.port}`);
  });

  // Таймер для отслеживания отсутствия пакетов (таймаут подключения)
  let lastPacketTime = Date.now();
  setInterval(() => {
    const now = Date.now();
    // Если пакетов не было 5 секунд - считаем, что подключение потеряно
    if (now - lastPacketTime > 5000 && lapsState.isConnected) {
      lapsState.isConnected = false;
      broadcastState();
    }
  }, 1000);

  udpServer.on('message', (msg) => {
    lastPacketTime = Date.now();
    const header = parseHeader(msg);
    if (!header) return;

    if (header.packetId === PACKET_ID_SESSION) {
      handleSessionPacket(msg);
    }
    if (header.packetId === PACKET_ID_PARTICIPANTS) {
      handleParticipantsPacket(msg);
    }
    if (header.packetId === PACKET_ID_SESSION_HISTORY) {
      handleSessionHistoryPacket(msg);
    }
    if (header.packetId === PACKET_ID_LAP_DATA) {
      handleLapDataPacket(msg);
    }
    if (header.packetId === PACKET_ID_CAR_TELEMETRY) {
      handleCarTelemetryPacket(msg);
    }
    if (header.packetId === PACKET_ID_CAR_STATUS) {
      handleCarStatusPacket(msg);
    }
    if (header.packetId === PACKET_ID_CAR_DAMAGE) {
      handleCarDamagePacket(msg);
    }
  });

  udpServer.bind(UDP_PORT);
});


