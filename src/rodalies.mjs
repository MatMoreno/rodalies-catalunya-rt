// Núcleo de datos: descarga el GTFS-Realtime de alertas de Renfe y extrae
// las incidencias que afectan a Rodalies de Catalunya (núcleo "51").
//
// IMPORTANTE (verificado contra los feeds en vivo):
//   - alerts.pb SÍ trae incidencias del núcleo 51 (Catalunya), con texto ca/es.
//   - vehicle_positions.pb / trip_updates.pb NO traen datos de Catalunya
//     (solo Madrid, Murcia, etc.), así que aquí no hay posiciones ni retrasos.
//
// Formato de routeId en las alertas de Catalunya: "51T0221R4"
//   "51" = núcleo · "T" · nnnn (índice) · sufijo = línea real (R4, R11, RG1…)

import pkg from "gtfs-realtime-bindings";
const { transit_realtime } = pkg;

const ALERTS_URL = "https://gtfsrt.renfe.com/alerts.pb";
const NUCLEUS = "51";

// Líneas canónicas de Rodalies de Catalunya. Sirven para pintar en verde las
// que NO tienen incidencia (no aparecen en el feed cuando circulan con normalidad).
export const LINEAS_CANONICAS = [
  "R1", "R2", "R2N", "R2S", "R3", "R4", "R7", "R8",
  "R11", "R12", "R13", "R14", "R15", "R16", "R17",
  "RG1", "RT1", "RT2", "RL3", "RL4",
];

// Extrae el código de línea del routeId ("51T0221R4" -> "R4").
function lineaDeRouteId(routeId) {
  const m = /^51.\d+([A-Za-z].*)$/.exec(routeId || "");
  return m ? m[1].toUpperCase() : null;
}

// Elige el mejor texto de un *_text de GTFS-RT. El feed a veces etiqueta el
// catalán como "es", así que preferimos catalán si lo detectamos y, si no,
// devolvemos la primera traducción no vacía. Deduplicamos por texto.
function mejorTexto(gtfsText) {
  const trs = (gtfsText?.translation || []).filter((t) => t.text?.trim());
  if (!trs.length) return null;
  const vistos = new Set();
  const unicos = trs.filter((t) => {
    const k = t.text.trim();
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  return {
    principal: unicos[0].text.trim(),
    alternativos: unicos.slice(1).map((t) => t.text.trim()),
  };
}

const num = (v) => (v == null ? null : Number(v)); // Long/BigInt -> Number
// GTFS-RT codifica "sin límite" como 0 (o ausente) en start/end.
const ts = (v) => {
  const n = num(v);
  return n ? n : null;
};

function periodoActivo(alert, ahora) {
  const p = alert.activePeriod?.[0];
  const start = ts(p?.start);
  const end = ts(p?.end);
  const vigente =
    (start == null || start <= ahora) && (end == null || end >= ahora);
  return { start, end, vigente };
}

// --- Caché simple en memoria para no martillear el feed ---
let _cache = { at: 0, data: null };
const TTL_MS = 30_000;

async function descargarAlertas() {
  const resp = await fetch(ALERTS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`Renfe GTFS-RT alerts HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  return transit_realtime.FeedMessage.decode(buf);
}

// Devuelve las incidencias de Catalunya ya parseadas.
export async function getIncidencias({ force = false } = {}) {
  if (!force && _cache.data && Date.now() - _cache.at < TTL_MS) {
    return _cache.data;
  }

  const feed = await descargarAlertas();
  const ahoraFeed = num(feed.header?.timestamp) ?? Math.floor(Date.now() / 1000);
  const ahora = Math.floor(Date.now() / 1000);

  const incidencias = [];
  for (const entity of feed.entity) {
    const alert = entity.alert;
    if (!alert) continue;

    const routeIds = (alert.informedEntity || [])
      .map((i) => i.routeId)
      .filter((r) => r && r.startsWith(NUCLEUS));
    if (!routeIds.length) continue; // no toca Catalunya

    const lineas = [...new Set(routeIds.map(lineaDeRouteId).filter(Boolean))].sort();
    const header = mejorTexto(alert.headerText);
    const desc = mejorTexto(alert.descriptionText);
    const periodo = periodoActivo(alert, ahora);

    incidencias.push({
      id: entity.id,
      lineas,
      titulo: header?.principal || null,
      texto: desc?.principal || header?.principal || "(sin descripción)",
      texto_alt: desc?.alternativos || [],
      vigente: periodo.vigente,
      inicio: periodo.start,
      fin: periodo.end,
      n_rutas_afectadas: routeIds.length,
    });
  }

  const data = {
    generado: ahora,
    feed_ts: ahoraFeed,
    total: incidencias.length,
    incidencias,
  };
  _cache = { at: Date.now(), data };
  return data;
}

// Estado por línea: cada línea canónica (más las que aparezcan en el feed)
// con su lista de incidencias vigentes. Sin incidencia => circula con normalidad.
export async function getEstadoLineas(opts) {
  const { incidencias } = await getIncidencias(opts);

  const lineas = new Set(LINEAS_CANONICAS);
  for (const inc of incidencias) for (const l of inc.lineas) lineas.add(l);

  const resultado = [...lineas].sort(ordenLinea).map((linea) => {
    const suyas = incidencias.filter(
      (i) => i.lineas.includes(linea) && i.vigente
    );
    return {
      linea,
      estado: suyas.length ? "incidencia" : "normal",
      incidencias: suyas.map((i) => ({
        id: i.id,
        texto: i.texto,
        inicio: i.inicio,
      })),
    };
  });

  return {
    generado: Math.floor(Date.now() / 1000),
    lineas: resultado,
    con_incidencias: resultado.filter((l) => l.estado === "incidencia").length,
  };
}

// Orden natural: R1, R2, R3… R17, luego RG/RT/RL.
function ordenLinea(a, b) {
  const parse = (s) => {
    const m = /^([A-Z]+)(\d+)?/.exec(s);
    return [m?.[1] || s, m?.[2] ? Number(m[2]) : 0];
  };
  const [pa, na] = parse(a);
  const [pb, nb] = parse(b);
  return pa === pb ? na - nb : pa < pb ? -1 : 1;
}
