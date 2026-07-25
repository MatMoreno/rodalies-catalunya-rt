// Vista de línea EN VIVO: dada una línea (R1…RG1), devuelve sus paradas en
// orden y la posición de cada tren que circula ahora — entre qué dos paradas
// está y a qué hora llega a la siguiente.
//
// Cómo se obtienen los trenes de una línea:
//   /departures es por ESTACIÓN, pero cada tren trae su recorrido completo
//   (stations[]) + nextStation + delay. Sondeamos un puñado de estaciones
//   repartidas por la línea, juntamos los trenes de esa línea y deduplicamos.

import { getLine, getDepartures } from "./api.mjs";

// Ejecuta tareas con concurrencia limitada.
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Elige estaciones-sonda repartidas por la línea (siempre las dos cabeceras).
function estacionesSonda(stations, max = 12) {
  if (stations.length <= max) return stations;
  const paso = (stations.length - 1) / (max - 1);
  const idx = new Set();
  for (let k = 0; k < max; k++) idx.add(Math.round(k * paso));
  idx.add(0);
  idx.add(stations.length - 1);
  return [...idx].sort((a, b) => a - b).map((i) => stations[i]);
}

const parseHora = (s) => (s ? new Date(s).getTime() : NaN);
const hhmm = (s) => (s ? String(s).slice(11, 16) : null);
// Suma (o resta) minutos a un "HH:MM" con vuelta de día, sin depender de la zona horaria.
function addMinToHHMM(hhmmStr, min) {
  if (!hhmmStr) return null;
  const [h, m] = hhmmStr.split(":").map(Number);
  const total = (((h * 60 + m + min) % 1440) + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}
const claveTren = (t) =>
  `${t.commercialNumber ?? t.technicalNumber}|${t.launchingDate ?? ""}`;

const SEG_MS = 180_000; // duración típica entre paradas (~3 min) para interpolar

// Sitúa un tren entre dos paradas usando la hora de la API (no la de la máquina)
// y el tiempo que falta para su próxima parada.
function situarTren(train, lineStations, lineIndex) {
  const stops = (train.stations || [])
    .map((s) => ({ id: String(s.id), name: s.name, li: lineIndex.get(String(s.id)), arr: s.arrivalDateHour, dep: s.departureDateHour }))
    .filter((s) => s.li != null);
  if (!stops.length) return null;
  const n = lineStations.length;

  // "Ahora" según la API (misma zona que las llegadas) → cuentas correctas.
  const nowRef = parseHora(train.__apiNow) || Date.now();

  // Sentido: la API solo da paradas futuras, en orden de viaje.
  let dir;
  if (stops.length >= 2) dir = stops[stops.length - 1].li >= stops[0].li ? 1 : -1;
  else {
    const destLi = train.destinationStation?.id != null ? lineIndex.get(String(train.destinationStation.id)) : null;
    dir = destLi != null && destLi < stops[0].li ? -1 : 1;
  }

  const next = stops[0]; // la primera pendiente = próxima parada
  const nextLi = next.li;
  const prevLi = Math.min(n - 1, Math.max(0, nextLi - dir)); // parada anterior (por geografía de la línea)

  // La API da la hora PROGRAMADA en stations[]; el retraso (min) se aplica por
  // igual a todas las paradas pendientes → hora REAL = programada + delay.
  const delayMin = Number.isFinite(train.delay) ? train.delay : (Number(train.delay) || 0);

  // Interpolación/cuenta atrás con la hora REAL (programada + retraso), no la de horario:
  // si no, un tren con +N min se pintaría "llegando" cuando aún le faltan minutos.
  const t1 = parseHora(next.arr || next.dep);
  const t1real = Number.isFinite(t1) ? t1 + delayMin * 60_000 : t1;
  let frac = 0.5;
  let enMin = null;
  if (Number.isFinite(t1real)) {
    enMin = Math.round((t1real - nowRef) / 60_000);
    frac = Math.min(1, Math.max(0, 1 - (t1real - nowRef) / SEG_MS));
  }

  // Horario parada a parada: programada (de la API) y real (+retraso).
  const conRetraso = (prog) => (delayMin && prog ? addMinToHHMM(prog, delayMin) : prog);
  const horario = stops.map((s) => {
    const prog = hhmm(s.arr || s.dep);
    return { li: s.li, prog, real: conRetraso(prog) };
  });
  const progNext = hhmm(next.arr || next.dep);
  const realNext = conRetraso(progNext);

  return {
    tren: train.commercialNumber ?? train.technicalNumber,
    linea: train.line?.id || train.line,
    destino: train.destinationStation?.name,
    delay: Number.isFinite(train.delay) ? train.delay : (train.delay ?? null),
    cancelado: !!train.trainCancelled,
    direccion: dir,
    anterior: { name: lineStations[prevLi]?.name, li: prevLi },
    proxima: { id: next.id, name: next.name, li: nextLi, programada: progNext, real: realNext, llegada: realNext, enMin },
    horario,
    fraccion: frac,
  };
}

// Genera trenes sintéticos para validar la interfaz fuera de horario (?demo=1).
function trenesDemo(line, ahora) {
  const n = line.stations.length;
  const mk = (dir, ni, fr, delay) => {
    const prev = line.stations[ni - dir];
    const next = line.stations[ni];
    // Paradas pendientes desde la próxima (ni) hasta la terminal, según el sentido.
    const remaining = [];
    for (let k = ni; k >= 0 && k < n; k += dir) remaining.push(k);
    const horario = remaining.map((li, idx) => {
      const real = hhmmFrom(ahora + (2 + idx * 3) * 60_000); // ETA real (~3 min/parada)
      const prog = addMinToHHMM(real, -delay);               // programada = real − retraso
      return { li, prog, real };
    });
    const h0 = horario[0] || { prog: null, real: null };
    return {
      tren: dir > 0 ? 24700 + ni : 24800 + ni,
      linea: line.id,
      destino: dir > 0 ? line.destination : line.origin,
      delay,
      cancelado: false,
      direccion: dir,
      anterior: { name: prev.name, li: line.stations.indexOf(prev) },
      proxima: { id: next.id, name: next.name, li: ni, programada: h0.prog, real: h0.real, llegada: h0.real, enMin: 2 },
      horario,
      fraccion: fr,
    };
  };
  return [mk(1, Math.min(3, n - 1), 0.5, 4), mk(-1, Math.max(1, n - 4), 0.3, 0)];
}
const hhmmFrom = (ms) => new Date(ms).toTimeString().slice(0, 5);

export async function getLineaEnVivo(lineId, { demo = false } = {}) {
  const line = await getLine(lineId);
  if (!line?.stations?.length) {
    const e = new Error(`Línea ${lineId} sin paradas`);
    e.status = 404;
    throw e;
  }
  const lineIndex = new Map(line.stations.map((s, i) => [String(s.id), i]));
  const ahora = Date.now();

  // Sondeo de salidas en las estaciones repartidas por la línea.
  const sondas = estacionesSonda(line.stations, 12);
  const listas = await mapLimit(sondas, 6, (st) => getDepartures(st.id).catch(() => []));

  // Junta trenes de ESTA línea y deduplica.
  const porClave = new Map();
  for (const trenes of listas) {
    for (const t of trenes) {
      if ((t.line?.id || t.line) !== lineId) continue;
      porClave.set(claveTren(t), t);
    }
  }

  const trenes = [];
  for (const t of porClave.values()) {
    const sit = situarTren(t, line.stations, lineIndex);
    if (sit) trenes.push(sit);
  }
  // Ordena por posición sobre la línea.
  trenes.sort((a, b) => a.proxima.li - b.proxima.li);

  if (demo && !trenes.length) trenes.push(...trenesDemo(line, ahora));

  return {
    generado: Math.floor(ahora / 1000),
    linea: { id: line.id, name: line.name, origin: line.origin, destination: line.destination },
    paradas: line.stations.map((s, i) => ({ i, id: s.id, name: s.name, accessible: s.accessible })),
    trenes,
    en_servicio: trenes.length > 0,
    sondas: sondas.length,
  };
}
