// Panel de salidas de UNA parada: "¿a qué hora pasa mi tren por mi estación?".
//
// Es la pregunta que trae al usuario, y la API la responde casi directa:
// /departures?stationId= ya devuelve los trenes ordenados por su paso por esa
// estación, con `departureDateHourSelectedStation` y `platformSelectedStation`.
//
// Dos cautelas aprendidas mirando datos reales (ver liveLine.mjs):
//   1. Las horas de la API son ETA EN VIVO: ya llevan el retraso incorporado.
//      La programada se obtiene restando `delay`, nunca al revés.
//   2. El feed arrastra registros caducados, con la próxima parada del tren muy
//      en el pasado y un `delay` imposible. Sus horas no valen: se descartan.
//      Cómo se distingue un caducado de un tren en marcha está en `tren.mjs`:
//      `stations[]` es el recorrido completo, así que su primer elemento es el
//      origen y darlo por "próxima parada" borraba del tablero todo tren que
//      llevara rodando más de tres minutos.

import { getDepartures, getStations, getLine } from "./api.mjs";
import { parseHora, registroCaducado } from "./tren.mjs";
const hhmm = (s) => (s ? String(s).slice(11, 16) : null);

function addMinToHHMM(hhmmStr, min) {
  if (!hhmmStr) return null;
  const [h, m] = hhmmStr.split(":").map(Number);
  const total = (((h * 60 + m + min) % 1440) + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}

const MIN_PASADO = -1;   // ya salió de esta parada → fuera del panel

// Sentido de circulación visto desde ESTA parada.
//
// Hace falta porque una línea presta servicios parciales: en R1, hacia el norte
// unos trenes acaban en Calella, otros en Blanes y otros en Maçanet. Sin el
// sentido, el viajero tiene que saberse el orden de las 31 paradas para deducir
// si un tren a Calella le sirve para ir a Barcelona (no le sirve).
//
// Se resuelve por el orden de paradas de la línea: si el destino va después de
// mi parada, el tren tira hacia el final de la línea; si va antes, hacia el
// principio. La etiqueta usa el extremo de la línea, como la señalética.
function calcularSentido(lineaOrden, paradaId, destinoId) {
  if (!lineaOrden) return null;
  const { indices, primera, ultima } = lineaOrden;
  const mio = indices.get(String(paradaId));
  const suyo = indices.get(String(destinoId));
  if (mio == null || suyo == null || suyo === mio) return null;
  const dir = suyo > mio ? 1 : -1;
  return { dir, hacia: dir > 0 ? ultima : primera };
}

export async function getSalidasParada(stationId, { linea = null, sentido = null, limite = 30 } = {}) {
  const estaciones = await getStations();
  const parada = estaciones.find((s) => s.id === String(stationId));
  if (!parada) {
    const e = new Error(`Parada ${stationId} no encontrada`);
    e.status = 404;
    throw e;
  }

  const trenes = await getDepartures(parada.id);
  const apiNow = trenes[0]?.__apiNow || null;
  const nowRef = parseHora(apiNow) || Date.now();

  // Orden de paradas de cada línea presente, para deducir el sentido. Va cacheado
  // 1 h, así que aunque la estación tenga 13 líneas esto no pesa.
  const codigos = [...new Set(trenes.map((t) => t.line?.id || t.line).filter(Boolean))];
  const ordenes = new Map();
  await Promise.all(codigos.map(async (id) => {
    try {
      const l = await getLine(id);
      if (!l?.stations?.length) return;
      ordenes.set(id, {
        indices: new Map(l.stations.map((s, i) => [String(s.id), i])),
        primera: l.stations[0].name,
        ultima: l.stations[l.stations.length - 1].name,
      });
    } catch { /* una línea sin paradas no impide mostrar el resto */ }
  }));

  const salidas = [];
  let caducados = 0;

  for (const t of trenes) {
    const codigo = t.line?.id || t.line;
    if (linea && codigo !== linea) continue;

    // Salud del registro: la próxima parada que declara la API y el final del viaje.
    if (registroCaducado(t, nowRef)) {
      caducados++;
      continue;
    }

    const salidaISO = t.departureDateHourSelectedStation;
    const ms = parseHora(salidaISO);
    const enMin = Number.isFinite(ms) ? Math.round((ms - nowRef) / 60_000) : null;
    if (enMin != null && enMin < MIN_PASADO) continue;

    // Un retraso negativo grande no es "va adelantado", es dato roto: no se muestra.
    const bruto = Number(t.delay);
    const delay = Number.isFinite(bruto) && bruto > -5 ? bruto : null;

    const real = hhmm(salidaISO);
    salidas.push({
      tren: t.commercialNumber ?? t.technicalNumber,
      linea: codigo,
      tipo: t.trainType || null,
      destino: t.destinationStation?.name ?? null,
      origen: t.originStation?.name ?? null,
      hora: real,
      programada: delay ? addMinToHHMM(real, -delay) : real,
      enMin,
      delay,
      anden: t.platformSelectedStation ?? null,
      cancelado: !!t.trainCancelled,
      accesible: !!t.trainAccessible,
      // Si su próxima parada sigue siendo la de origen, el tren aún no ha salido.
      estado:
        t.nextStation?.id != null && String(t.nextStation.id) === String(t.originStation?.id)
          ? "programado"
          : "circulando",
      proxima: t.nextStation?.name ?? null,
      sentido: calcularSentido(ordenes.get(codigo), parada.id, t.destinationStation?.id),
      observaciones: (t.trainObservations || "").trim() || null,
    });
  }

  salidas.sort((a, b) => (a.enMin ?? 1e9) - (b.enMin ?? 1e9));

  // Sentidos presentes, para que la interfaz pueda ofrecerlos como filtro sin
  // tener que conocer la geografía de la red.
  const cuenta = new Map();
  for (const s of salidas) {
    if (!s.sentido) continue;
    cuenta.set(s.sentido.hacia, (cuenta.get(s.sentido.hacia) || 0) + 1);
  }
  const sentidos = [...cuenta.entries()]
    .map(([hacia, n]) => ({ hacia, n }))
    .sort((a, b) => b.n - a.n);

  const filtradas = sentido ? salidas.filter((s) => s.sentido?.hacia === sentido) : salidas;

  return {
    generado: Math.floor(Date.now() / 1000),
    ahora: apiNow ? String(apiNow).slice(11, 16) : null,
    parada: {
      id: parada.id,
      name: parada.name,
      accessible: parada.accessible,
      lineas: parada.lineas,
    },
    sentidos,
    salidas: filtradas.slice(0, limite),
    total: filtradas.length,
    caducados,
    en_servicio: salidas.length > 0,
  };
}
