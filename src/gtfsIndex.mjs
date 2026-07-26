// Índice en memoria del GTFS de autobuses interurbanos.
//
// El reto no es el algoritmo, es la memoria: son 469.853 pasos por parada y la
// versión ingenua (un objeto por fila) se come 260 MB. Aquí:
//   · stop_times.txt NUNCA se convierte en string: se escanea el Buffer con un
//     puntero y las horas se sacan de los dígitos, así que no se crea ni un
//     string para las 939.706 horas del fichero.
//   · el fichero viene agrupado por viaje, así que el trip_id de una fila suele
//     ser byte a byte el de la anterior: se compara y se ahorra el string.
//   · el índice final son typed arrays ordenados por parada (counting sort) y
//     dentro de cada parada por hora, así una consulta es una búsqueda binaria.
//
// Lo que hace falta saber de cada fila cabe en 9 bytes: hora (Int32), viaje
// (Int32) y un byte de banderas.

import { readFileSync } from "node:fs";
import { rutaFichero, asegurarFeed } from "./gtfsFeed.mjs";
import { norm, haversine, caja } from "./geo.mjs";
import { diaSemana, hhmmDeSeg, ymdSuma } from "./tiempo.mjs";

// Banderas por fila
const ES_ULTIMA = 1;    // última parada del viaje: es llegada, no salida
const SIN_RECOGIDA = 2; // pickup_type = 1: no se puede subir aquí
const SIN_HORA = 4;     // sin hora de paso publicada

/* --------------------------------------------------------------- CSV normal */

// Para los ficheros pequeños (el mayor es 1 MB) un lector con comillas y a
// correr. El escáner por bytes se reserva para stop_times.txt.
function leerCSV(ruta) {
  const txt = readFileSync(ruta, "utf8");
  const filas = [];
  let campo = "", fila = [], enComillas = false, cab = null;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (enComillas) {
      if (c === '"') {
        if (txt[i + 1] === '"') { campo += '"'; i++; } else enComillas = false;
      } else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") {
      fila.push(campo); campo = "";
      // Las cabeceras de este feed traen espacios delante (" location_id"),
      // así que se recortan o no cuadra ninguna columna.
      if (!cab) cab = fila.map((h) => h.trim());
      else if (fila.length > 1) {
        const o = {};
        for (let k = 0; k < cab.length; k++) o[cab[k]] = fila[k];
        filas.push(o);
      }
      fila = [];
    } else if (c !== "\r") campo += c;
  }
  return filas;
}

/* ------------------------------------------------ escáner de stop_times.txt */

const COMA = 44, NL = 10, CR = 13, COMILLA = 34, DOSP = 58;

// Lee un entero decimal de un rango de bytes. Vacío -> -1.
function entero(b, ini, fin) {
  let n = -1;
  for (let i = ini; i < fin; i++) {
    const d = b[i] - 48;
    if (d < 0 || d > 9) continue;
    n = (n < 0 ? 0 : n * 10) + d;
  }
  return n;
}

// "24:30:00" -> 88200. Acepta una o dos cifras en la hora. Vacío -> -1.
// El GTFS admite horas >= 24:00 para la madrugada del día de servicio anterior,
// así que aquí NO se hace ningún módulo: 88200 tiene que sobrevivir tal cual.
function horaSeg(b, ini, fin) {
  if (fin <= ini) return -1;
  let h = 0, m = 0, s = 0, parte = 0, visto = false;
  for (let i = ini; i < fin; i++) {
    const c = b[i];
    if (c === DOSP) { parte++; continue; }
    const d = c - 48;
    if (d < 0 || d > 9) continue;
    visto = true;
    if (parte === 0) h = h * 10 + d;
    else if (parte === 1) m = m * 10 + d;
    else s = s * 10 + d;
  }
  return visto ? h * 3600 + m * 60 + s : -1;
}

/* ------------------------------------------------------ construcción del índice */

function construir(dir) {
  const t0 = Date.now();

  // --- agencias (para el operador de cada línea) ---
  const agencia = new Map();
  for (const a of leerCSV(rutaFichero("agency.txt"))) {
    agencia.set(a.agency_id, a.agency_name || null);
  }

  // --- paradas ---
  const filasParadas = leerCSV(rutaFichero("stops.txt"));
  const nParadas = filasParadas.length;
  const pId = new Array(nParadas), pNombre = new Array(nParadas), pNorm = new Array(nParadas);
  const pLat = new Float64Array(nParadas), pLon = new Float64Array(nParadas);
  const mapaParada = new Map();
  for (let i = 0; i < nParadas; i++) {
    const s = filasParadas[i];
    pId[i] = s.stop_id;
    pNombre[i] = s.stop_name;
    pNorm[i] = norm(s.stop_name);
    pLat[i] = Number(s.stop_lat);
    pLon[i] = Number(s.stop_lon);
    mapaParada.set(s.stop_id, i);
  }

  // --- rutas ---
  // El código público NO es route_short_name (ahí pone "L1081", que es interno):
  // va entre paréntesis al principio de route_long_name, "(L63) Barcelona…".
  const filasRutas = leerCSV(rutaFichero("routes.txt"));
  const nRutas = filasRutas.length;
  const rCodigo = new Array(nRutas), rNombre = new Array(nRutas), rOperador = new Array(nRutas);
  const mapaRuta = new Map();
  for (let i = 0; i < nRutas; i++) {
    const r = filasRutas[i];
    const largo = r.route_long_name || "";
    const m = /^\(([^)]+)\)\s*/.exec(largo);
    rCodigo[i] = (m ? m[1] : r.route_short_name || "").trim() || r.route_short_name || "?";
    rNombre[i] = (m ? largo.slice(m[0].length) : largo).trim() || null;
    rOperador[i] = agencia.get(r.agency_id) || null;
    mapaRuta.set(r.route_id, i);
  }

  // --- servicios (calendar + calendar_dates) ---
  //
  // Hoy calendar.txt viene con TODOS los días a cero y todo el servicio sale de
  // las 46.917 altas de calendar_dates. Aun así se implementa la especificación
  // entera: si algún día la Generalitat publica el calendario como es debido y
  // deja de emitir una excepción por día, el atajo dejaría el tablero vacío sin
  // decir nada.
  const mapaServicio = new Map();
  const idxServicio = (id) => {
    let i = mapaServicio.get(id);
    if (i === undefined) { i = mapaServicio.size; mapaServicio.set(id, i); }
    return i;
  };
  const filasCal = leerCSV(rutaFichero("calendar.txt"));
  const filasExc = leerCSV(rutaFichero("calendar_dates.txt"));
  for (const c of filasCal) idxServicio(c.service_id);
  for (const c of filasExc) idxServicio(c.service_id);
  const nServicios = mapaServicio.size;

  const svcDias = new Uint8Array(nServicios);
  const svcDesde = new Int32Array(nServicios);
  const svcHasta = new Int32Array(nServicios);
  const DIAS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  for (const c of filasCal) {
    const i = mapaServicio.get(c.service_id);
    let bits = 0;
    for (let d = 0; d < 7; d++) if (c[DIAS[d]] === "1") bits |= 1 << d;
    svcDias[i] = bits;
    svcDesde[i] = Number(c.start_date) || 0;
    svcHasta[i] = Number(c.end_date) || 0;
  }

  const excepciones = new Map(); // ymd -> { altas:[], bajas:[] }
  let vigDesde = Infinity, vigHasta = -Infinity;
  for (const c of filasExc) {
    const ymd = Number(c.date);
    if (!ymd) continue;
    if (ymd < vigDesde) vigDesde = ymd;
    if (ymd > vigHasta) vigHasta = ymd;
    let e = excepciones.get(ymd);
    if (!e) excepciones.set(ymd, (e = { altas: [], bajas: [] }));
    (c.exception_type === "2" ? e.bajas : e.altas).push(mapaServicio.get(c.service_id));
  }
  for (let i = 0; i < nServicios; i++) {
    if (!svcDias[i]) continue; // sin días base no aporta vigencia
    if (svcDesde[i] && svcDesde[i] < vigDesde) vigDesde = svcDesde[i];
    if (svcHasta[i] > vigHasta) vigHasta = svcHasta[i];
  }
  const conDiasBase = [...svcDias].filter(Boolean).length;

  // --- viajes ---
  const filasViajes = leerCSV(rutaFichero("trips.txt"));
  const nViajes = filasViajes.length;
  const vRuta = new Int32Array(nViajes), vServicio = new Int32Array(nViajes);
  // `direction_id` no sirve para NADA comparando líneas distintas (el 0 de una
  // no tiene que ver con el 0 de otra), y por eso el tablero de una parada no lo
  // usa. Dentro de UNA línea sí es exactamente lo que dice la especificación que
  // es, y es lo que separa la ida de la vuelta en la vista de recorrido. Son
  // 30 KB para 29.721 viajes.
  const vDireccion = new Uint8Array(nViajes);
  // El `trip_id` del feed, para poder pedir un bus concreto desde fuera. Los
  // 29.721 son numéricos y el mayor es 1.926.297, así que caben en un Int32Array
  // (119 KB) y no hace falta conservar ni una cadena. El índice interno del
  // viaje no serviría: cambia en cada reconstrucción, y un enlace viejo acabaría
  // enseñando OTRO autobús, que es peor que no enseñar ninguno.
  const vId = new Int32Array(nViajes);
  const mapaViaje = new Map();
  for (let i = 0; i < nViajes; i++) {
    const t = filasViajes[i];
    vRuta[i] = mapaRuta.get(t.route_id) ?? -1;
    vServicio[i] = mapaServicio.get(t.service_id) ?? -1;
    vDireccion[i] = t.direction_id === "1" ? 1 : 0;
    vId[i] = /^\d+$/.test(t.trip_id) ? Number(t.trip_id) : 0;
    mapaViaje.set(t.trip_id, i);
  }

  const tEstaticos = Date.now() - t0;

  /* ---------------- stop_times.txt: una sola pasada sobre los bytes ---------------- */

  const t1 = Date.now();
  const buf = readFileSync(rutaFichero("stop_times.txt"));
  const n = buf.length;

  // Cabecera: se localizan las columnas por nombre (recortado) para que un
  // cambio de orden no rompa nada.
  let p = 0;
  while (p < n && buf[p] !== NL) p++;
  const cab = buf.toString("utf8", 0, p).split(",").map((h) => h.trim());
  p++;
  const col = (nombre) => cab.indexOf(nombre);
  const cViaje = col("trip_id"), cLlegada = col("arrival_time"), cSalida = col("departure_time"),
        cParada = col("stop_id"), cOrden = col("stop_sequence"), cRecogida = col("pickup_type");
  if (cViaje < 0 || cParada < 0 || cOrden < 0 || (cSalida < 0 && cLlegada < 0)) {
    throw new Error("stop_times.txt: faltan columnas obligatorias");
  }
  const maxCol = Math.max(cViaje, cLlegada, cSalida, cParada, cOrden, cRecogida) + 1;

  // Capacidad: una fila por salto de línea restante, con holgura.
  let cap = 0;
  for (let i = p; i < n; i++) if (buf[i] === NL) cap++;
  cap += 8;

  const tmpHora = new Int32Array(cap), tmpViaje = new Int32Array(cap),
        tmpParada = new Int32Array(cap), tmpBand = new Uint8Array(cap);
  // Fila con el stop_sequence más alto de cada viaje = su última parada.
  const filaUltima = new Int32Array(nViajes).fill(-1);
  const ordenUltima = new Int32Array(nViajes).fill(-1);
  const paradaPrimera = new Int32Array(nViajes).fill(-1);
  const ordenPrimera = new Int32Array(nViajes).fill(0x7fffffff);

  const ini = new Int32Array(maxCol), fin = new Int32Array(maxCol);
  let filas = 0, sinHora = 0, huerfanas = 0;
  let anteriorIni = -1, anteriorFin = -1, anteriorViaje = -1;

  while (p < n) {
    // Trocear la fila en campos, respetando comillas.
    let c = 0, campoIni = p;
    for (; p <= n; p++) {
      const ch = p < n ? buf[p] : NL;
      if (ch === COMILLA) { // campo entrecomillado: saltar hasta el cierre
        p++;
        while (p < n && !(buf[p] === COMILLA && buf[p + 1] !== COMILLA)) p += buf[p] === COMILLA ? 2 : 1;
        continue;
      }
      if (ch !== COMA && ch !== NL) continue;
      if (c < maxCol) {
        let f = p;
        if (f > campoIni && buf[f - 1] === CR) f--;
        ini[c] = campoIni; fin[c] = f;
      }
      c++;
      campoIni = p + 1;
      if (ch === NL) { p++; break; }
    }
    if (c < maxCol) continue; // línea vacía o truncada (la última del fichero)

    // trip_id: el fichero viene agrupado por viaje, así que casi siempre es
    // byte a byte el de la fila anterior y nos ahorramos crear el string.
    let vi;
    const ti = ini[cViaje], tf = fin[cViaje];
    if (anteriorIni >= 0 && tf - ti === anteriorFin - anteriorIni &&
        buf.compare(buf, anteriorIni, anteriorFin, ti, tf) === 0) {
      vi = anteriorViaje;
    } else {
      vi = mapaViaje.get(buf.toString("utf8", ti, tf)) ?? -1;
      anteriorIni = ti; anteriorFin = tf; anteriorViaje = vi;
    }
    if (vi < 0) { huerfanas++; continue; }

    // En este feed el stop_id de stop_times viene sin comillas, pero si algún
    // día vinieran entrecomilladas el string llevaría las comillas dentro y la
    // búsqueda fallaría en silencio para TODAS las filas.
    let si = ini[cParada], sf = fin[cParada];
    if (sf - si >= 2 && buf[si] === COMILLA) { si++; sf--; }
    const pi = mapaParada.get(buf.toString("utf8", si, sf));
    if (pi === undefined) { huerfanas++; continue; }

    let seg = cSalida >= 0 ? horaSeg(buf, ini[cSalida], fin[cSalida]) : -1;
    if (seg < 0 && cLlegada >= 0) seg = horaSeg(buf, ini[cLlegada], fin[cLlegada]);

    let band = 0;
    if (seg < 0) { band |= SIN_HORA; sinHora++; seg = 0; }
    if (cRecogida >= 0 && entero(buf, ini[cRecogida], fin[cRecogida]) === 1) band |= SIN_RECOGIDA;

    const orden = entero(buf, ini[cOrden], fin[cOrden]);
    // stop_sequence empieza en 0 en este feed, así que "la última" es el máximo
    // por viaje, nunca un número fijo.
    if (orden > ordenUltima[vi]) { ordenUltima[vi] = orden; filaUltima[vi] = filas; }
    if (orden < ordenPrimera[vi]) { ordenPrimera[vi] = orden; paradaPrimera[vi] = pi; }

    tmpHora[filas] = seg; tmpViaje[filas] = vi; tmpParada[filas] = pi; tmpBand[filas] = band;
    filas++;
  }

  // La última parada de cada viaje es llegada, no salida.
  const vUltimaParada = new Int32Array(nViajes).fill(-1);
  for (let v = 0; v < nViajes; v++) {
    const f = filaUltima[v];
    if (f >= 0) { tmpBand[f] |= ES_ULTIMA; vUltimaParada[v] = tmpParada[f]; }
  }

  /* ------------- counting sort por parada, y dentro de cada una por hora ------------- */

  const inicio = new Int32Array(nParadas + 1);
  for (let i = 0; i < filas; i++) inicio[tmpParada[i] + 1]++;
  for (let i = 0; i < nParadas; i++) inicio[i + 1] += inicio[i];

  const sHora = new Int32Array(filas), sViaje = new Int32Array(filas), sBand = new Uint8Array(filas);
  const cursor = Int32Array.from(inicio.subarray(0, nParadas));
  for (let i = 0; i < filas; i++) {
    const d = cursor[tmpParada[i]]++;
    sHora[d] = tmpHora[i]; sViaje[d] = tmpViaje[i]; sBand[d] = tmpBand[i];
  }

  // Cada bloque de parada ordenado por hora (media 52 filas, máximo ~1.900).
  const perm = [];
  for (let s = 0; s < nParadas; s++) {
    const a = inicio[s], b = inicio[s + 1], len = b - a;
    if (len < 2) continue;
    perm.length = 0;
    for (let k = 0; k < len; k++) perm.push(k);
    perm.sort((x, y) => sHora[a + x] - sHora[a + y]);
    const h = sHora.slice(a, b), v = sViaje.slice(a, b), g = sBand.slice(a, b);
    for (let k = 0; k < len; k++) {
      sHora[a + k] = h[perm[k]]; sViaje[a + k] = v[perm[k]]; sBand[a + k] = g[perm[k]];
    }
  }

  // Líneas de las que se puede SALIR en cada parada, para el buscador, las
  // paradas cercanas y el selector de línea del tablero.
  //
  // Se salta la última parada del viaje: hay líneas que solo terminan en un
  // sitio (los nocturnos del Vallès acaban todos en rda. Sant Pere) y anunciarlas
  // ahí sería ofrecer una línea a la que nunca te puedes subir.
  const prTmp = new Array(nParadas);
  for (let s = 0; s < nParadas; s++) {
    const set = new Set();
    for (let i = inicio[s]; i < inicio[s + 1]; i++) {
      if (sBand[i] & ES_ULTIMA) continue;
      const r = vRuta[sViaje[i]];
      if (r >= 0) set.add(r);
    }
    prTmp[s] = [...set];
  }

  const tPasos = Date.now() - t1;
  const rss = Math.round(process.memoryUsage().rss / 1e6);
  console.log(
    `GTFS bus: ${nParadas} paradas · ${nRutas} líneas · ${nViajes} viajes · ${filas} pasos · ` +
    `RSS ${rss} MB · ${tEstaticos + tPasos} ms`
  );
  if (huerfanas) console.log(`GTFS bus: ${huerfanas} pasos huérfanos descartados`);

  return {
    nParadas, nRutas, nViajes, nServicios, filas, sinHora, huerfanas,
    conDiasBase, altas: filasExc.length,
    vigencia: { desde: vigDesde === Infinity ? null : vigDesde,
                hasta: vigHasta === -Infinity ? null : vigHasta },
    ms: tEstaticos + tPasos, rss,
    pId, pNombre, pNorm, pLat, pLon, mapaParada,
    rCodigo, rNombre, rOperador,
    vRuta, vServicio, vDireccion, vId, vUltimaParada, vPrimeraParada: paradaPrimera,
    svcDias, svcDesde, svcHasta, excepciones,
    inicio, sHora, sViaje, sBand, paradaRutas: prTmp,
  };
}

/* ----------------------------------------------------------- estado del módulo */

let idx = null;
let construyendo = null;

export function asegurarIndice({ force = false } = {}) {
  if (idx && !force) return Promise.resolve(idx);
  if (construyendo) return construyendo;
  construyendo = (async () => {
    const meta = await asegurarFeed({ force });
    idx = construir(meta.dir);
    idx.meta = meta;
    return idx;
  })().finally(() => { construyendo = null; });
  return construyendo;
}

export const indiceListo = () => idx;
export const estaDescargando = () => !!construyendo;

/* ------------------------------------------------- servicios activos por fecha */

const cacheServicios = new Map(); // ymd -> Uint8Array (se conservan 2)

function serviciosActivos(ix, ymd) {
  const hit = cacheServicios.get(ymd);
  if (hit) return hit;
  const act = new Uint8Array(ix.nServicios);
  const bit = (diaSemana(ymd) + 6) % 7; // JS: 0=domingo; calendar.txt: 0=lunes
  for (let s = 0; s < ix.nServicios; s++) {
    if (((ix.svcDias[s] >> bit) & 1) && ymd >= ix.svcDesde[s] && ymd <= ix.svcHasta[s]) act[s] = 1;
  }
  const exc = ix.excepciones.get(ymd);
  if (exc) {
    for (const s of exc.altas) act[s] = 1;
    for (const s of exc.bajas) act[s] = 0;
  }
  // Solo hacen falta hoy y ayer: sin tope, esto sería una fuga lenta.
  if (cacheServicios.size >= 2) cacheServicios.delete(cacheServicios.keys().next().value);
  cacheServicios.set(ymd, act);
  return act;
}

/* --------------------------------------------------------------- consultas */

export function paradaPorId(id) {
  const ix = idx; if (!ix) return null;
  const i = ix.mapaParada.get(String(id));
  return i === undefined ? null : fichaParada(ix, i);
}

function fichaParada(ix, i) {
  // Se quitan repetidos POR CÓDIGO, no por ruta: 30 códigos públicos los
  // comparten varios route_id (cuatro rutas distintas se llaman "e9"), y sin
  // esto la parada listaba "e9 e9".
  const codigos = [...new Set(ix.paradaRutas[i].map((r) => ix.rCodigo[r]))];
  return {
    id: ix.pId[i], name: ix.pNombre[i],
    lat: ix.pLat[i] || null, lon: ix.pLon[i] || null,
    lineas: codigos.sort((a, b) => a.localeCompare(b, "ca", { numeric: true })),
  };
}

export function buscarParadas(q, { limite = 20 } = {}) {
  const ix = idx; if (!ix) return [];
  const t = norm(q.trim());
  if (!t) return [];
  // Se recorren las 9.010 (menos de 1 ms): cortar antes se saltaría paradas que
  // empiezan por el texto y salen tarde en el fichero, que son justo las buenas.
  const empieza = [], contiene = [];
  for (let i = 0; i < ix.nParadas; i++) {
    const nn = ix.pNorm[i];
    if (nn.startsWith(t)) empieza.push(i);
    else if (nn.includes(t)) contiene.push(i);
  }
  return [...empieza, ...contiene].slice(0, limite).map((i) => fichaParada(ix, i));
}

export function paradasCerca(lat, lon, radio, limite = 6) {
  const ix = idx; if (!ix || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const c = caja(lat, lon, radio);
  const out = [];
  for (let i = 0; i < ix.nParadas; i++) {
    const la = ix.pLat[i], lo = ix.pLon[i];
    if (!la || la < c.latMin || la > c.latMax || lo < c.lonMin || lo > c.lonMax) continue;
    const m = haversine(lat, lon, la, lo);
    if (m <= radio) out.push({ ...fichaParada(ix, i), metros: Math.round(m) });
  }
  out.sort((a, b) => a.metros - b.metros);
  return out.slice(0, limite);
}

// Primer índice del bloque [a,b) cuya hora sea >= objetivo.
function limiteInferior(sHora, a, b, objetivo) {
  let lo = a, hi = b;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sHora[mid] < objetivo) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Próximas salidas de una parada.
//
// Se consultan DOS días de servicio, no uno: un viaje con horas >= 24:00
// pertenece al día ANTERIOR, así que a las 00:30 los buses que pasan ahora
// están en el horario de ayer, apuntados como "24:30". Los de ayer se desplazan
// +86400 para poder compararlos con el reloj de hoy.
export function proximasEnParada(paradaIdx, { ymd, seg, ventanaSeg = 7200, gracia = -60 }) {
  const ix = idx; if (!ix) return [];
  const a = ix.inicio[paradaIdx], b = ix.inicio[paradaIdx + 1];
  const out = [];

  for (const [fecha, desplazamiento] of [[ymd, 0], [ymdSuma(ymd, -1), 86400]]) {
    const act = serviciosActivos(ix, fecha);
    // OJO: el límite superior PUEDE pasar de 86400 y no se recorta. Una ventana
    // de 2 h a las 23:30 tiene que llegar a las 01:30 = 91800, o se pierde
    // entera la madrugada.
    const desde = seg + desplazamiento + gracia;
    const hasta = seg + desplazamiento + ventanaSeg;

    for (let i = limiteInferior(ix.sHora, a, b, desde); i < b; i++) {
      const t = ix.sHora[i];
      if (t > hasta) break;
      const band = ix.sBand[i];
      if (band & (ES_ULTIMA | SIN_RECOGIDA | SIN_HORA)) continue;
      const v = ix.sViaje[i];
      if (!act[ix.vServicio[v]]) continue;

      const r = ix.vRuta[v];
      const destino = ix.vUltimaParada[v];
      const origen = ix.vPrimeraParada[v];
      out.push({
        linea: r >= 0 ? ix.rCodigo[r] : "?",
        recorrido: r >= 0 ? ix.rNombre[r] : null,
        operador: r >= 0 ? ix.rOperador[r] : null,
        destino: destino >= 0 ? ix.pNombre[destino] : null,
        origen: origen >= 0 ? ix.pNombre[origen] : null,
        hora: hhmmDeSeg(t),
        enMin: Math.round((t - desplazamiento - seg) / 60),
        // Con esto se puede pedir el recorrido completo de ESTE autobús, no de
        // su línea: de dónde viene, por dónde ha pasado y hasta dónde sigue.
        viaje: ix.vId[v] || null,
      });
    }
  }
  out.sort((x, y) => x.enMin - y.enMin);
  return out;
}

export function indiceDeParada(id) {
  return idx ? idx.mapaParada.get(String(id)) : undefined;
}

/* -------------------------------------------------------------- un solo bus */

// Recorrido completo de UN autobús concreto: de dónde viene, por dónde ha pasado
// ya y hasta dónde sigue. Es otra pregunta que la del recorrido de la línea: la
// línea tiene servicios parciales y dos sentidos, y este bus hace uno solo.
export function itinerarioDeViaje(idPublico, { ymd, seg } = {}) {
  const ix = idx; if (!ix) return null;
  const id = Number(idPublico);
  if (!Number.isInteger(id) || id <= 0) return null;

  // Barrido lineal de los 29.721 viajes: menos de un milisegundo, y ahorra
  // mantener un mapa de por vida para una consulta que se hace al tocar una fila.
  let v = -1;
  for (let i = 0; i < ix.nViajes; i++) if (ix.vId[i] === id) { v = i; break; }
  if (v < 0) return null;

  // Los pasos de un viaje están repartidos por los bloques de sus paradas, así
  // que toca una pasada. Se ordenan por hora, que es el orden del recorrido.
  const arr = [];
  for (let s = 0; s < ix.nParadas; s++) {
    for (let i = ix.inicio[s]; i < ix.inicio[s + 1]; i++) {
      if (ix.sViaje[i] === v) arr.push({ parada: s, hora: ix.sHora[i], band: ix.sBand[i] });
    }
  }
  if (!arr.length) return null;
  arr.sort((a, b) => a.hora - b.hora);

  // ¿Las horas de este viaje son de hoy o de la madrugada de ayer? Un viaje
  // apuntado a las "24:30" pertenece al día anterior. Se elige el día de servicio
  // activo que deja el viaje MÁS CERCA de ahora, que es la misma interpretación
  // con la que el tablero lo enseñó.
  //
  // El desplazamiento de un día SOLO se plantea si el viaje se mete de verdad en
  // la madrugada (alguna hora >= 24:00). Sin esta condición, un viaje de las
  // 13:30 que no circula el lunes se colaba como "el de ayer a las 13:30",
  // a 1.410 minutos de distancia, y decía que sí circulaba.
  const trasnocha = arr[arr.length - 1].hora >= 86400;
  const candidatos = trasnocha ? [[ymd, 0], [ymdSuma(ymd, -1), 86400]] : [[ymd, 0]];
  let desp = 0, mejor = Infinity, activo = false;
  for (const [fecha, d] of candidatos) {
    if (!ymd || !serviciosActivos(ix, fecha)[ix.vServicio[v]]) continue;
    const dist = Math.abs(arr[0].hora - d - seg);
    if (dist < mejor) { mejor = dist; desp = d; activo = true; }
  }

  const r = ix.vRuta[v];
  return {
    viaje: String(id),
    linea: r >= 0 ? ix.rCodigo[r] : "?",
    recorrido: r >= 0 ? ix.rNombre[r] : null,
    operador: r >= 0 ? ix.rOperador[r] : null,
    // `false` = este bus no circula en la fecha consultada (es de otro
    // calendario). Las horas siguen valiendo como horario, pero no hay cuenta atrás.
    circula: activo,
    desde: ix.pNombre[arr[0].parada],
    hasta: ix.pNombre[arr[arr.length - 1].parada],
    paradas: arr.map((p, i) => ({
      id: ix.pId[p.parada],
      name: ix.pNombre[p.parada],
      lat: ix.pLat[p.parada] || null, lon: ix.pLon[p.parada] || null,
      hora: hhmmDeSeg(p.hora),
      enMin: activo ? Math.round((p.hora - desp - seg) / 60) : null,
      final: i === arr.length - 1 || !!(p.band & ES_ULTIMA),
    })),
  };
}

/* ------------------------------------------------------------------- líneas */

// Buscador de líneas: por código primero (es lo que sabe la gente: "N82") y
// luego por el nombre del recorrido ("Malgrat"). Son 948, se recorren enteras.
export function buscarLineas(q, { limite = 8 } = {}) {
  const ix = idx; if (!ix) return [];
  const t = norm(q.trim());
  if (!t) return [];
  const exacto = [], empieza = [], contiene = [];
  const vistos = new Set();
  for (let i = 0; i < ix.nRutas; i++) {
    const cod = norm(ix.rCodigo[i]);
    // Varios route_id comparten código público (cuatro rutas se llaman "e9"):
    // la línea se enseña una vez.
    if (vistos.has(cod)) continue;
    const nom = norm(ix.rNombre[i] || "");
    if (cod === t) { vistos.add(cod); exacto.push(i); }
    else if (cod.startsWith(t)) { vistos.add(cod); empieza.push(i); }
    else if (nom.includes(t)) { vistos.add(cod); contiene.push(i); }
  }
  return [...exacto, ...empieza, ...contiene].slice(0, limite).map((i) => ({
    linea: ix.rCodigo[i], recorrido: ix.rNombre[i], operador: ix.rOperador[i], fuente: "gtfs",
  }));
}

// Recorrido de una línea, por sentidos.
//
// El índice tiró `stop_sequence` a propósito (ocupaba 470.000 enteros para
// responder una sola pregunta que ya va en un bit). El orden se recupera de las
// HORAS: dentro de un viaje son monótonas crecientes —para eso GTFS usa "25:10"
// en vez de "01:10"—, así que ordenar sus pasos por hora reconstruye el trazado
// sin guardar nada más.
export function itinerariosDeLinea(codigo, { ymd, seg, gracia = -60 } = {}) {
  const ix = idx; if (!ix) return null;
  const rutas = [];
  for (let i = 0; i < ix.nRutas; i++) if (ix.rCodigo[i] === codigo) rutas.push(i);
  if (!rutas.length) return null;

  const setRutas = new Set(rutas);
  const viajes = new Set();
  for (let v = 0; v < ix.nViajes; v++) if (setRutas.has(ix.vRuta[v])) viajes.add(v);
  if (!viajes.size) return { linea: codigo, sentidos: [] };

  // Una sola pasada por el índice: los pasos de un viaje están repartidos entre
  // los bloques de sus paradas, así que no hay atajo más corto que recorrerlo.
  const pasos = new Map();  // viaje -> [{ parada, hora }]
  for (let s = 0; s < ix.nParadas; s++) {
    for (let i = ix.inicio[s]; i < ix.inicio[s + 1]; i++) {
      const v = ix.sViaje[i];
      if (!viajes.has(v)) continue;
      let arr = pasos.get(v);
      if (!arr) pasos.set(v, (arr = []));
      arr.push({ parada: s, hora: ix.sHora[i], band: ix.sBand[i] });
    }
  }
  for (const arr of pasos.values()) arr.sort((a, b) => a.hora - b.hora);

  // Los servicios activos de hoy y de ayer: un viaje que arranca a las "24:30"
  // pertenece al día anterior, igual que en el tablero de una parada.
  const dias = ymd ? [[ymd, 0], [ymdSuma(ymd, -1), 86400]] : [];
  const activos = dias.map(([f, d]) => [serviciosActivos(ix, f), d]);

  // Se agrupa por SENTIDO (ida y vuelta), no por destino. Agrupar por destino
  // partía la N82 en cinco bloques: los servicios parciales que acaban en Mataró
  // no son otro sentido, son la misma dirección con menos recorrido —el mismo
  // asunto del R1 a Calella / Blanes / Maçanet—. Los destinos parciales se
  // enumeran aparte, que es lo que hay que saber al subirse.
  // La clave lleva también la RUTA: hay 30 códigos públicos que comparten varios
  // route_id, y son recorridos de verdad distintos (con "e9" se llaman tanto
  // Barcelona-Caldes como Barcelona-Santa Maria d'Oló). Mezclarlos daba un
  // itinerario de 61 paradas que empezaba en un pueblo que no viene a cuento, y
  // encima el direction_id de una ruta no tiene por qué ir en el mismo sentido
  // que el de la otra. Separados, cada uno se lee con su nombre.
  const grupos = new Map();
  for (const [v, arr] of pasos) {
    if (!arr.length) continue;
    const clave = ix.vRuta[v] * 2 + ix.vDireccion[v];
    let g = grupos.get(clave);
    if (!g) grupos.set(clave, (g = { ruta: ix.vRuta[v], viajes: [] }));
    g.viajes.push({ v, arr });
  }

  const sentidos = [];
  for (const g of grupos.values()) {
    // El próximo viaje de verdad: el primero que sale del inicio del recorrido
    // dentro de un día de servicio activo.
    let proximo = null, mejor = Infinity, hoy = 0;
    for (const t of g.viajes) {
      const t0 = t.arr[0].hora;
      // Cuántos pasan HOY. No vale el total de viajes del grupo: los 21 de la
      // N82 están repartidos entre tres calendarios que no coinciden nunca
      // (diario de octubre a mayo, noches de viernes y sábado de verano, noches
      // de domingo a jueves), así que sumarlos diría el triple de lo que pasa.
      if (activos.length && activos[0][0][ix.vServicio[t.v]]) hoy++;
      for (const [act, desp] of activos) {
        if (!act[ix.vServicio[t.v]]) continue;
        const efectiva = t0 - desp;
        if (efectiva >= seg + gracia && efectiva < mejor) { mejor = efectiva; proximo = { ...t, desp }; }
      }
    }
    // Con próximo viaje se enseña ESE recorrido con sus horas (es el bus que vas
    // a coger, aunque sea un servicio parcial). Sin él, el trazado más completo
    // del grupo y sin horas: no se inventa una hora que hoy no existe.
    const largo = g.viajes.reduce((a, b) => (b.arr.length > a.arr.length ? b : a), g.viajes[0]);
    const elegido = proximo || largo;
    const desp = proximo ? proximo.desp : 0;

    // Los demás finales de este mismo sentido: los servicios parciales. Van
    // contados, porque "3 de 18" no se lee igual que "la mitad".
    const finales = new Map();
    for (const t of g.viajes) {
      const d = ix.vUltimaParada[t.v];
      const nombre = d >= 0 ? ix.pNombre[d] : null;
      if (nombre) finales.set(nombre, (finales.get(nombre) || 0) + 1);
    }
    const propio = ix.pNombre[elegido.arr[elegido.arr.length - 1].parada];

    sentidos.push({
      hacia: propio,
      desde: ix.pNombre[elegido.arr[0].parada],
      // Solo se dice cuando el código tiene más de un recorrido: si no, repetir
      // el nombre de la línea en cada sentido es ruido.
      recorrido: rutas.length > 1 ? ix.rNombre[g.ruta] : null,
      otros_finales: [...finales.entries()]
        .filter(([n]) => n !== propio)
        .sort((a, b) => b[1] - a[1])
        .map(([hacia, n]) => ({ hacia, n })),
      viajes: g.viajes.length,   // en todo el feed, contando los tres calendarios
      hoy,                        // los que circulan en la fecha consultada
      // `salida: null` significa "no hay próximo paso en la ventana de dos días
      // de servicio que se consulta". No se afirma "hoy no circula", que es una
      // cosa distinta: a las 23:00 puede haber pasado doce veces ya.
      salida: proximo
        ? { hora: hhmmDeSeg(proximo.arr[0].hora), enMin: Math.round((mejor - seg) / 60) }
        : null,
      paradas: elegido.arr.map((p, i) => ({
        id: ix.pId[p.parada],
        name: ix.pNombre[p.parada],
        lat: ix.pLat[p.parada] || null, lon: ix.pLon[p.parada] || null,
        hora: proximo ? hhmmDeSeg(p.hora) : null,
        enMin: proximo ? Math.round((p.hora - desp - seg) / 60) : null,
        // La última no es una salida: es donde se baja todo el mundo.
        final: i === elegido.arr.length - 1 || !!(p.band & ES_ULTIMA),
      })),
    });
  }
  // El sentido que sale antes, primero.
  sentidos.sort((a, b) => (a.salida?.enMin ?? 1e9) - (b.salida?.enMin ?? 1e9));

  const r = rutas[0];
  return {
    linea: codigo, fuente: "gtfs",
    recorrido: ix.rNombre[r], operador: ix.rOperador[r],
    variantes: rutas.length, sentidos,
  };
}
