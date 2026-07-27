// Cómo se lee un tren de la API de Rodalies (`/departures?fullResponse=true`).
//
// El campo delicado es `stations[]`: es el RECORRIDO COMPLETO del tren, con las
// paradas que ya sirvió incluidas. Por tanto `stations[0]` es la estación de
// ORIGEN, no la próxima parada. Leerlo como "próxima parada" tenía un efecto
// que no se ve mirando el código, solo el tablero: como la hora del origen ya
// pasó, TODO tren con más de tres minutos de marcha se daba por caducado y
// desaparecía. En Arenys de Mar solo sobrevivían los que aún no habían salido
// de su estación de origen y los recién arrancados; el tren que estaba entrando
// en la parada no salía por ningún lado.
//
// La próxima parada la declara la API en `nextStation`, y aquí se busca dentro
// del recorrido. Estas dos preguntas —cuál es la próxima parada y si el
// registro sigue vivo— viven en este módulo para que las dos vistas (panel de
// parada y línea en vivo) no vuelvan a contestarlas de forma distinta.

export const parseHora = (s) => (s ? new Date(s).getTime() : NaN);

// Hora de paso por una parada del recorrido. Es un ETA EN VIVO: ya lleva el
// retraso incorporado (la programada se obtiene restando `delay`, nunca al revés).
export const horaParada = (s) => parseHora(s?.arrivalDateHour || s?.departureDateHour);

const MIN_PASADA = -3;     // margen para dar por pasada la hora de una parada
const MIN_FANTASMA = -15;  // la próxima parada tan atrás que el registro está congelado

// Posición de la próxima parada dentro de `stations[]`, o -1 si no queda ninguna.
export function indiceProxima(train, nowRef) {
  const stops = train?.stations || [];
  if (!stops.length) return -1;

  // Lo que dice la API. Para un tren que todavía no ha salido, `nextStation` es
  // su propio origen, así que esto también acierta con las salidas futuras.
  const id = train.nextStation?.id;
  if (id != null) {
    const i = stops.findIndex((s) => String(s.id) === String(id));
    if (i >= 0) return i;
  }

  // Respaldo si la API no declara próxima parada, o declara una que no está en
  // el recorrido: la primera cuya hora no ha pasado todavía.
  return stops.findIndex((s) => {
    const t = horaParada(s);
    return Number.isFinite(t) && (t - nowRef) / 60_000 >= MIN_PASADA;
  });
}

export function proximaParada(train, nowRef) {
  const i = indiceProxima(train, nowRef);
  return i >= 0 ? train.stations[i] : null;
}

// Registro caducado ("fantasma"): el feed arrastra trenes que ya no circulan,
// con las horas congeladas donde quedaron y un `delay` imposible (−50 min).
//
// Se juzga por dos señales, no por la primera parada del recorrido:
//   1. la próxima parada QUE DECLARA LA API quedó muy atrás → congelado;
//   2. la llegada al final del trayecto ya pasó → no queda nada que anunciar.
// El margen de la primera es holgado a propósito: un ETA que tarda en
// refrescarse es normal, y equivocarse aquí borra trenes que sí existen.
export function registroCaducado(train, nowRef) {
  const stops = train?.stations || [];
  if (!stops.length) return false;

  const tProxima = horaParada(proximaParada(train, nowRef));
  if (Number.isFinite(tProxima) && (tProxima - nowRef) / 60_000 < MIN_FANTASMA) return true;

  const tFinal = horaParada(stops[stops.length - 1]);
  if (Number.isFinite(tFinal) && (tFinal - nowRef) / 60_000 < MIN_PASADA) return true;

  return false;
}

// Compara dos referencias de estación de la API (por id, con el nombre de red).
export function mismaEstacion(a, b) {
  if (!a || !b) return false;
  if (a.id != null && b.id != null) return String(a.id) === String(b.id);
  return !!a.name && a.name === b.name;
}
