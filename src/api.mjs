// Cliente del backend OFICIAL de Rodalies de Catalunya (el que usa su web).
//   Base: https://serveisgrs.rodalies.gencat.cat/api   (sin autenticación)
//   Descubierto vía OpenAPI en /api/v3/api-docs ("Nou GRS API v1").
//
// Endpoints usados:
//   GET /lines            -> catálogo de líneas
//   GET /lines/{id}       -> línea con sus paradas EN ORDEN
//   GET /departures?stationId=&fullResponse=true
//         -> trenes que pasan por la estación EN VIVO, cada uno con:
//            line, delay (min), nextStation (próxima parada) y
//            stations[] (todo el recorrido con hora estimada de paso).
//   GET /trains/{id}      -> un tren concreto en vivo (mismo detalle).
//
// OJO: /departures y /trains son EN VIVO: solo devuelven datos en horario
// de servicio (~05:00–00:30). Fuera de horario: trains:[] o 500 "Dades no disponibles".

const BASE = "https://serveisgrs.rodalies.gencat.cat/api";
const UA = "rodalies-rt (uso personal)";

async function getJson(path, { timeout = 12_000 } = {}) {
  const res = await fetch(BASE + path, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GRS ${res.status} ${path} ${body.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// --- Caché en memoria con TTL ---
function cached(ttlMs) {
  const store = new Map(); // key -> { at, val }
  return async (key, producer) => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.val;
    const val = await producer();
    store.set(key, { at: Date.now(), val });
    return val;
  };
}

const cacheStatic = cached(60 * 60_000); // líneas/estaciones: 1 h
const cacheLive = cached(20_000); // salidas: 20 s

export async function getLines() {
  return cacheStatic("lines", async () => {
    const j = await getJson("/lines?limit=100&lang=ca");
    const arr = j.included || j.data || j.content || j;
    return (Array.isArray(arr) ? arr : []).map((l) => ({
      id: l.id,
      name: l.name,
      orderNumber: l.orderNumber ?? 999,
    }));
  });
}

export async function getLine(id) {
  return cacheStatic("line:" + id, async () => {
    const j = await getJson(`/lines/${encodeURIComponent(id)}?lang=ca`);
    const l = j.included || j;
    const stations = (l.stations || []).map((s) => ({
      id: String(s.id),
      name: s.name,
      accessible: !!s.accessible,
    }));
    return {
      id: l.id,
      name: l.name,
      origin: l.originStation?.name,
      destination: l.destinationStation?.name,
      stations,
    };
  });
}

// Catálogo completo de estaciones (202), con las líneas que paran en cada una.
// Se cachea 1 h.
//
// OJO con la paginación: el parámetro es `page`, NO `offset` — mandar `offset`
// se ignora en silencio y devuelve la primera página una y otra vez. Con un
// `limit` holgado entra todo en una sola llamada; el bucle queda por seguridad.
export async function getStations() {
  return cacheStatic("stations", async () => {
    // Las `connections` mezclan líneas de Rodalies con metro/tranvía ("L9 Sud"),
    // así que se filtran contra el catálogo real de líneas.
    const validas = new Set((await getLines()).map((l) => l.id));
    const porId = new Map();
    const LIMIT = 250;
    for (let page = 0; page < 10; page++) {
      const j = await getJson(`/stations?limit=${LIMIT}&page=${page}&lang=ca`);
      const arr = j.included || j.data || [];
      for (const s of arr) {
        porId.set(String(s.id), {
          id: String(s.id),
          name: s.name,
          accessible: !!s.accessible,
          lat: s.latitude ?? null,
          lon: s.longitude ?? null,
          lineas: [...new Set((s.connections || []).map((c) => c.id).filter((id) => validas.has(id)))],
        });
      }
      if (j.last || arr.length < LIMIT) break;
    }
    return [...porId.values()].sort((a, b) => a.name.localeCompare(b.name, "ca"));
  });
}

// Salidas EN VIVO de una estación (cada tren con su recorrido completo).
export async function getDepartures(stationId) {
  return cacheLive("dep:" + stationId, async () => {
    try {
      const j = await getJson(
        `/departures?stationId=${encodeURIComponent(stationId)}&fullResponse=true&lang=ca`
      );
      const trains = j.trains || [];
      // Guardamos la hora "ahora" de la API (misma zona que las llegadas) para
      // calcular cuentas atrás correctas sin depender del reloj de la máquina.
      for (const t of trains) t.__apiNow = j.requestedAt;
      return trains;
    } catch (e) {
      // Fuera de horario o dato puntual no disponible: tratamos como "sin trenes".
      if (e.status >= 500) return [];
      throw e;
    }
  });
}

export async function getTrain(id) {
  const j = await getJson(`/trains/${encodeURIComponent(id)}?fullResponse=true&lang=ca`);
  return j.train || j;
}
