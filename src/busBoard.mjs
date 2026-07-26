// Panel de salidas de UNA parada de bus: "¿a qué hora pasa mi bus?".
//
// Junta dos redes que no se parecen en nada:
//   · Interurbanos de la Generalitat -> horario GTFS. Programado, sin retrasos.
//   · Urbanos de Barcelona (TMB)     -> iBus. Minutos reales, sin horario.
// Ambas acaban en la misma forma `salidas[]` que `stopBoard.mjs`, para que la
// interfaz pueda pintarlas con el mismo molde.
//
// DIFERENCIA DE FONDO CON EL TREN: aquí una "parada" es un poste físico, y cada
// sentido de la calzada tiene el suyo con su propio código. Las salidas de una
// parada ya son casi siempre de un solo sentido, así que no se replica el
// `calcularSentido` de los trenes (que existe porque una estación sirve los dos
// sentidos desde un único id). Lo que sí manda aquí es la LÍNEA.

import {
  asegurarIndice, indiceListo, estaDescargando, indiceDeParada,
  paradaPorId, buscarParadas, paradasCerca, proximasEnParada,
  buscarLineas, itinerariosDeLinea, itinerarioDeViaje,
} from "./gtfsIndex.mjs";
import { getParadasTMB, getLineasTMB, getIBus, getRecorridoTMB, estadoTMB } from "./tmb.mjs";
import { ahoraRed, hhmmDeSeg, segDeHora, ymdBonito } from "./tiempo.mjs";
import { haversine, caja, norm } from "./geo.mjs";
import { getStations, cacheStatic } from "./api.mjs";
import { TMB_ACTIVO } from "./config.mjs";

// Un poste de TMB y uno de la Generalitat a menos de esto son el mismo sitio.
const METROS_MISMO_POSTE = 30;

/* ------------------------------------------------------------ identidad de parada */

// Ids prefijados porque hay dos catálogos: "gen:PF08019187" / "tmb:2608".
// Se parte por el PRIMER ':' (nunca split, que rompería un id con dos puntos)
// y un id pelado se entiende como interurbano, para que los enlaces a mano
// queden legibles.
function resolver(id) {
  const s = String(id || "");
  const i = s.indexOf(":");
  if (i < 0) return { fuente: "gen", local: s };
  const fuente = s.slice(0, i), local = s.slice(i + 1);
  if (fuente !== "gen" && fuente !== "tmb") {
    const e = new Error(`Parada ${s} no encontrada`);
    e.status = 404;
    throw e;
  }
  return { fuente, local };
}

const noEncontrada = (id) => {
  const e = new Error(`Parada ${id} no encontrada`);
  e.status = 404;
  return e;
};

/* --------------------------------------------------------------------- catálogos */

async function fichaTMB(codi) {
  const p = (await getParadasTMB()).find((x) => x.id === String(codi));
  if (!p) return null;
  const lineas = await getLineasTMB();
  return {
    id: "tmb:" + p.id, fuente: "tmb", name: p.name, detalle: p.detalle,
    lat: p.lat, lon: p.lon,
    // iBus no publica qué líneas paran aquí si no viene ninguna en camino, así
    // que la lista de líneas de una parada de TMB solo se conoce en vivo.
    lineas: [], _codi: p.id, _lineas: lineas,
  };
}

function fichaGen(local) {
  const p = paradaPorId(local);
  return p ? { ...p, id: "gen:" + p.id, fuente: "gtfs" } : null;
}

// Poste de TMB pegado a uno de la Generalitat (o al revés). Es lo que permite
// que una parada de Barcelona enseñe a la vez el interurbano con horario y el
// urbano en tiempo real, en vez de dos tableros inconexos.
async function posteHermanoTMB(lat, lon) {
  if (!TMB_ACTIVO || !Number.isFinite(lat)) return null;
  const paradas = await getParadasTMB();
  const c = caja(lat, lon, METROS_MISMO_POSTE);
  let mejor = null, mejorM = Infinity;
  for (const p of paradas) {
    if (p.lat < c.latMin || p.lat > c.latMax || p.lon < c.lonMin || p.lon > c.lonMax) continue;
    const m = haversine(lat, lon, p.lat, p.lon);
    if (m < mejorM) { mejorM = m; mejor = p; }
  }
  return mejorM <= METROS_MISMO_POSTE ? mejor : null;
}

// Y el mismo salto al revés: el poste interurbano pegado a uno de TMB, para que
// una parada urbana con un interurbano al lado no esconda su horario. Sin esto,
// un tablero "tmb:" de madrugada sale vacío aunque por ese mismo poste pase un
// bus nocturno de la Generalitat dentro de diez minutos.
function posteHermanoGen(lat, lon) {
  if (!Number.isFinite(lat)) return undefined;
  const [cerca] = paradasCerca(lat, lon, METROS_MISMO_POSTE, 1);
  return cerca ? indiceDeParada(cerca.id) : undefined;
}

/* ----------------------------------------------------------------------- estado */

export async function getEstadoBus({ force = false } = {}) {
  // Responde AL MOMENTO aunque el feed se esté bajando: la interfaz necesita
  // poder pintar un esqueleto en vez de quedarse colgada 25 MB.
  const ix = indiceListo();
  if (!ix) {
    if (force) asegurarIndice({ force }).catch(() => {});
    return {
      estado: estaDescargando() ? "descargando" : "sin_datos",
      fuentes: { gtfs: { disponible: false }, tmb: estadoTMB() },
    };
  }
  if (force) await asegurarIndice({ force: true });
  // Se toca TMB una vez antes de contestar. Sin esto, `fuentes.tmb` decía
  // "disponible" con unas claves erróneas solo porque todavía no había fallado
  // nada, que es justo la mentira que este campo existe para evitar. El
  // catálogo se cachea 24 h, así que en régimen no cuesta ninguna petición.
  if (TMB_ACTIVO) await getParadasTMB();
  return { estado: "listo", ...resumenIndice(indiceListo()), fuentes: fuentes(indiceListo()) };
}

function resumenIndice(ix) {
  return {
    paradas: ix.nParadas, lineas: ix.nRutas, viajes: ix.nViajes, pasos: ix.filas,
    servicios: ix.nServicios, sin_hora: ix.sinHora, huerfanas: ix.huerfanas,
    ms: ix.ms, rss_mb: Math.round(process.memoryUsage().rss / 1e6),
  };
}

function fuentes(ix) {
  const hoy = ahoraRed().ymd;
  const v = ix.vigencia;
  const caducado = !!(v.hasta && hoy > v.hasta);
  return {
    gtfs: {
      disponible: true,
      publicado: ix.meta?.publicado || null,
      descargado: ix.meta?.descargado || null,
      vigencia: v,
      caducado,
      // Se dice en claro para que la interfaz no tenga que formatear fechas.
      aviso: caducado ? `El horario publicado terminó el ${ymdBonito(v.hasta)}. Puede estar desactualizado.` : null,
    },
    tmb: estadoTMB(),
  };
}

/* -------------------------------------------------------------------- buscador */

// El catálogo son 9.010 paradas (~1,1 MB de JSON): el filtrado es del servidor,
// a diferencia de /api/paradas, que sí manda las 202 estaciones enteras.
export async function buscarParadasBus(q, { limite = 20, lat = null, lon = null, radio = 600 } = {}) {
  await asegurarIndice();

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const paradas = await cercaDePunto(lat, lon, radio, limite);
    return { paradas, total: paradas.length };
  }

  const texto = String(q || "").trim();
  if (texto.length < 2) return { paradas: [], total: 0, aviso: "Escribe al menos 2 letras." };

  const gen = buscarParadas(texto, { limite }).map((p) => ({ ...p, id: "gen:" + p.id, fuente: "gtfs" }));

  // Paradas de TMB por nombre (solo si hay claves: sin ellas el catálogo va vacío).
  const t = norm(texto);
  const tmb = (await getParadasTMB())
    .filter((p) => norm(p.name).includes(t))
    .slice(0, limite)
    .map((p) => ({ id: "tmb:" + p.id, fuente: "tmb", name: p.name, detalle: p.detalle,
                   lat: p.lat, lon: p.lon, lineas: [] }));

  // Las que empiezan por el texto, primero; y con los huecos repartidos entre
  // los dos catálogos, porque si no las interurbanas (que hay tres veces más y
  // van delante en la concatenación) se los quedan todos y buscar "mercè" nunca
  // llegaría a enseñar la parada urbana que se llama así.
  const paradas = repartir(
    fusionar([...gen, ...tmb])
      .sort((a, b) => (norm(b.name).startsWith(t) ? 1 : 0) - (norm(a.name).startsWith(t) ? 1 : 0)),
    limite);
  return { paradas, total: paradas.length };
}

// Los dos catálogos listan el mismo poste en Barcelona. Si coinciden en sitio y
// comparten alguna palabra del nombre, se queda UNO: el interurbano.
//
// Parece al revés (TMB es el que tiene tiempo real), pero el id "gen:" resuelve
// las DOS redes —el tablero de una parada interurbana ya busca su poste hermano
// de TMB y añade los minutos en vivo—, mientras que el catálogo de TMB no
// publica qué líneas paran en cada poste: quedarse con el id "tmb:" dejaba la
// fila del buscador sin ni un bullet. Con el interurbano se gana la lista de
// líneas y no se pierde el tiempo real.
//
// Los postes que solo existen en TMB (casi toda la red urbana) siguen con su id
// "tmb:" y su tablero en vivo.
function fusionar(lista) {
  const out = [];
  for (const p of lista) {
    const i = out.findIndex((o) =>
      o.fuente !== p.fuente && Number.isFinite(o.lat) && Number.isFinite(p.lat) &&
      haversine(o.lat, o.lon, p.lat, p.lon) <= METROS_MISMO_POSTE &&
      compartenPalabra(o.name, p.name));
    if (i < 0) { out.push({ ...p }); continue; }
    // Las dos fuentes son distintas por la condición de arriba, así que uno de
    // los dos es el interurbano y el otro el urbano, sin importar cuál llegó
    // antes a la lista.
    const gemelo = out[i];
    const gen = gemelo.fuente === "gtfs" ? gemelo : { ...p };
    const urbano = gemelo.fuente === "gtfs" ? p : gemelo;
    gen.lineas = [...new Set([...(gen.lineas || []), ...(urbano.lineas || [])])];
    // La distancia que vale es la del poste más cercano de los dos.
    if (Number.isFinite(urbano.metros)) gen.metros = Math.min(gen.metros ?? Infinity, urbano.metros);
    // "tmb:1240" -> "1240". Se guarda para que la fila pueda decir que ahí
    // también hay tiempo real.
    gen.tmb = urbano.id.slice(4);
    out[i] = gen;
  }
  return out;
}

function compartenPalabra(a, b) {
  const pal = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const A = pal(a);
  for (const w of pal(b)) if (A.has(w)) return true;
  return false;
}

async function cercaDePunto(lat, lon, radio, limite) {
  const gen = paradasCerca(lat, lon, radio, limite * 2)
    .map((p) => ({ ...p, id: "gen:" + p.id, fuente: "gtfs" }));

  const c = caja(lat, lon, radio);
  const tmb = [];
  for (const p of await getParadasTMB()) {
    if (p.lat < c.latMin || p.lat > c.latMax || p.lon < c.lonMin || p.lon > c.lonMax) continue;
    const m = haversine(lat, lon, p.lat, p.lon);
    if (m <= radio) tmb.push({ id: "tmb:" + p.id, fuente: "tmb", name: p.name, detalle: p.detalle,
                               lat: p.lat, lon: p.lon, lineas: [], metros: Math.round(m) });
  }
  const cerca = fusionar([...gen, ...tmb]).sort((a, b) => a.metros - b.metros);
  return repartir(cerca, limite);
}

// Los huecos se reparten entre los dos catálogos en vez de dárselos al primero
// que llegue. Hay 9.010 paradas interurbanas y 2.721 urbanas, y en Barcelona
// TMB tiene un poste cada 100 m: sin reparto, un catálogo se come la lista.
// Junto a Sants los seis más cercanos son urbanos y la estación de autobuses
// interurbanos —a 173 m, y la única fila que dice qué líneas paran ahí— se
// quedaba fuera. Si un catálogo no llega a su mitad, el otro se queda el resto.
//
// Se conserva el orden de entrada (por distancia o por relevancia, según quien
// llame), así que esto solo decide QUÉ entra, no en qué orden se lee.
function repartir(lista, limite) {
  const gen = lista.filter((p) => p.fuente === "gtfs");
  const tmb = lista.filter((p) => p.fuente !== "gtfs");
  const mitad = Math.ceil(limite / 2);
  const nGen = Math.min(gen.length, Math.max(mitad, limite - tmb.length));
  const elegidas = new Set([...gen.slice(0, nGen), ...tmb.slice(0, limite - nGen)]);
  return lista.filter((p) => elegidas.has(p));
}

export async function getParadaBus(id) {
  await asegurarIndice();
  const { fuente, local } = resolver(id);
  const p = fuente === "tmb" ? await fichaTMB(local) : fichaGen(local);
  if (!p) throw noEncontrada(id);
  const { _codi, _lineas, ...limpia } = p;
  return limpia;
}

/* --------------------------------------------------------------------- salidas */

export async function getSalidasParadaBus(id, {
  linea = null, destino = null, ventana = 120, limite = 30,
  fecha = null, hora = null,
} = {}) {
  await asegurarIndice();
  const { fuente, local } = resolver(id);

  // Palanca de depuración: forzar el momento es la única forma práctica de
  // probar el salto de día y de mes sin esperar a la madrugada.
  const real = ahoraRed();
  const segForzado = hora != null ? segDeHora(hora) : null;
  const ahora = {
    ymd: fecha || real.ymd,
    seg: segForzado != null ? segForzado : real.seg,
  };
  ahora.hhmm = hhmmDeSeg(ahora.seg);
  const forzado = !!(fecha || segForzado != null);

  const parada = fuente === "tmb" ? await fichaTMB(local) : fichaGen(local);
  if (!parada) throw noEncontrada(id);

  const salidas = [];

  // --- interurbanos con horario ---
  // Si la parada es de TMB, el horario sale de su poste hermano interurbano
  // (si lo tiene): las dos redes comparten calzada en media Barcelona.
  const genIdx = fuente === "gen"
    ? indiceDeParada(local)
    : posteHermanoGen(parada.lat, parada.lon);
  if (genIdx !== undefined) {
    for (const s of proximasEnParada(genIdx, { ...ahora, ventanaSeg: ventana * 60 })) {
      salidas.push({
        fuente: "gtfs", linea: s.linea, operador: s.operador, recorrido: s.recorrido,
        destino: s.destino, origen: s.origen,
        // Para poder abrir el recorrido de ESE autobús. Las filas de TMB no lo
        // llevan: iBus da minutos, no viajes.
        viaje: s.viaje ? String(s.viaje) : null,
        hora: s.hora, programada: s.hora, enMin: s.enMin,
        // Un horario no tiene retraso ni andén ni cancelaciones: se emiten en
        // null a propósito, en vez de inventar un "En hora" que nadie ha medido.
        delay: null, anden: null, cancelado: false, accesible: null,
        tiempoReal: false, estado: "programado", observaciones: null,
        color: null, colorTexto: null,
      });
    }
  }

  // --- TMB en vivo ---
  // Vale tanto si la parada es de TMB como si es interurbana y tiene un poste de
  // TMB pegado: así una parada de Barcelona enseña las dos redes juntas.
  let codiTMB = fuente === "tmb" ? local : null;
  if (!codiTMB && !forzado) {
    const hermano = await posteHermanoTMB(parada.lat, parada.lon);
    codiTMB = hermano?.id || null;
  }
  // Con la hora forzada no se consulta el tiempo real: mezclar "dentro de 3 min"
  // de ahora con un horario de dentro de tres meses sería mentir.
  if (codiTMB && !forzado) {
    const lineasTMB = await getLineasTMB();
    for (const b of await getIBus(codiTMB)) {
      const info = lineasTMB.get(b.linea) || null;
      salidas.push({
        fuente: "tmb", linea: b.linea, operador: info?.operador || "TMB",
        recorrido: info?.descripcion || null,
        destino: b.destino || info?.destino || null, origen: null,
        hora: b.enMin != null ? hhmmDeSeg(real.seg + b.enMin * 60) : null,
        programada: null, enMin: b.enMin, viaje: null,
        delay: null, anden: null, cancelado: false, accesible: null,
        tiempoReal: true, estado: "circulando", observaciones: b.texto || null,
        color: info?.color || null, colorTexto: info?.colorTexto || null,
      });
    }
  }

  salidas.sort((a, b) => (a.enMin ?? 1e9) - (b.enMin ?? 1e9));

  // Resumen por línea: en una parada de 10 líneas es LA vista útil (buscas tu
  // bullet y lees un número). Se calcula sobre el tablero sin filtrar, para que
  // la tira siga enseñando todas las líneas aunque haya una seleccionada.
  const porLinea = new Map();
  for (const s of salidas) {
    let e = porLinea.get(s.linea);
    if (!e) porLinea.set(s.linea, (e = { linea: s.linea, n: 0, operador: s.operador,
                                         color: s.color, tiempoReal: false, proxima: null }));
    e.n++;
    e.tiempoReal = e.tiempoReal || s.tiempoReal;
    if (!e.proxima) e.proxima = { enMin: s.enMin, hora: s.hora, destino: s.destino };
  }
  // Y las líneas que paran aquí pero no tienen ningún paso en la ventana se
  // ofrecen igualmente, con `proxima: null`. Si no, una línea que pasa cada hora
  // desaparece del selector justo cuando más falta hace saber cuándo vuelve, y
  // de madrugada el selector se queda con tres de las veintiocho de la parada.
  // (El poste de TMB no publica sus líneas, así que ahí esta lista va vacía y
  // esto no añade nada.)
  for (const l of parada.lineas || []) {
    if (!porLinea.has(l)) {
      porLinea.set(l, { linea: l, n: 0, operador: null, color: null, tiempoReal: false, proxima: null });
    }
  }

  // Primero las que están a punto de pasar; las que hoy no pasan, al final y en
  // orden de código, que es como se leen en el poste.
  const lineas = [...porLinea.values()].sort((a, b) =>
    (a.proxima?.enMin ?? 1e9) - (b.proxima?.enMin ?? 1e9) ||
    a.linea.localeCompare(b.linea, "ca", { numeric: true }));

  // Los destinos solo se ofrecen con una línea elegida: una línea sí tiene
  // servicios parciales (el mismo lío de R1 a Calella / Blanes / Maçanet), pero
  // los destinos de diez líneas mezclados no le dicen nada a nadie.
  const destinos = [];
  if (linea) {
    const cuenta = new Map();
    for (const s of salidas) {
      if (s.linea !== linea || !s.destino) continue;
      cuenta.set(s.destino, (cuenta.get(s.destino) || 0) + 1);
    }
    for (const [hacia, n] of cuenta) destinos.push({ hacia, linea, n });
    destinos.sort((a, b) => b.n - a.n);
  }

  let filtradas = salidas;
  if (linea) filtradas = filtradas.filter((s) => s.linea === linea);
  if (destino) filtradas = filtradas.filter((s) => s.destino === destino);

  const { _codi, _lineas, ...paradaLimpia } = parada;
  return {
    generado: Math.floor(Date.now() / 1000),
    ahora: ahora.hhmm,
    fecha_servicio: ahora.ymd,
    forzado,
    ventana,
    parada: { ...paradaLimpia, tmb: codiTMB || null },
    lineas, destinos,
    salidas: filtradas.slice(0, limite),
    total: filtradas.length,
    en_servicio: salidas.length > 0,
    fuentes: fuentes(indiceListo()),
  };
}

/* ---------------------------------------------------------------- por LÍNEA */

// A veces no se busca una parada: se busca un bus. "¿Por dónde pasa la N82?"
// no se puede contestar con un buscador de paradas, así que el buscador devuelve
// las dos cosas y la interfaz las enseña en la misma lista.
export async function buscarTodo(q, { limite = 20 } = {}) {
  await asegurarIndice();
  const texto = String(q || "").trim();
  if (texto.length < 2) return { lineas: [], paradas: [], total: 0, aviso: "Escribe al menos 2 letras." };

  const lineas = buscarLineas(texto, { limite: 8 });
  // Líneas de TMB por código o por descripción, con su color de marca.
  const t = norm(texto);
  for (const l of (await getLineasTMB()).values()) {
    if (lineas.length >= 12) break;
    const cod = norm(l.codigo);
    if (!(cod === t || cod.startsWith(t) || norm(l.descripcion || "").includes(t))) continue;
    if (lineas.some((x) => norm(x.linea) === cod)) continue;  // ya la trae el interurbano
    lineas.push({
      linea: l.codigo, recorrido: l.descripcion, operador: l.operador,
      fuente: "tmb", color: l.color, colorTexto: l.colorTexto,
    });
  }
  // El código exacto manda: quien escribe "e9" busca la e9, no "Sant Boi - e9…".
  lineas.sort((a, b) => (norm(b.linea) === t ? 1 : 0) - (norm(a.linea) === t ? 1 : 0));

  // Y si el texto no se parece al CÓDIGO de ninguna línea, las líneas pasan a ser
  // un añadido: "meridiana" es una calle, no una línea, y tres líneas de TMB que
  // llevan "Ciutat Meridiana" en la descripción no pueden empujar las paradas
  // fuera de la pantalla. Con "n82" o "h12" es al revés, y ahí sí van delante.
  const porCodigo = lineas.some((l) => norm(l.linea).startsWith(t));
  const recortadas = porCodigo ? lineas.slice(0, 8) : lineas.slice(0, 3);

  const { paradas } = await buscarParadasBus(texto, { limite });
  return {
    lineas: recortadas, paradas,
    total: recortadas.length + paradas.length,
    // Para que la interfaz sepa a qué se parece más lo que se ha escrito.
    coincide: porCodigo ? "linea" : "parada",
  };
}

// Recorrido de UN autobús concreto (el de una fila del tablero).
export async function getViajeBus(id, { fecha = null, hora = null } = {}) {
  await asegurarIndice();
  const real = ahoraRed();
  const segForzado = hora != null ? segDeHora(hora) : null;
  const ymd = fecha || real.ymd;
  const seg = segForzado != null ? segForzado : real.seg;

  const v = itinerarioDeViaje(id, { ymd, seg });
  if (!v) {
    // Puede ser un id inventado o de un feed anterior: 404, nunca un bus que no
    // es. El horario se renueva cada semana y los trip_id no son eternos.
    const e = new Error(`Viaje ${id} no encontrado`);
    e.status = 404;
    throw e;
  }
  for (const p of v.paradas) p.id = "gen:" + p.id;
  return { ...v, ahora: hhmmDeSeg(seg), fecha_servicio: ymd };
}

// Recorrido de una línea, sentido por sentido, con las horas del próximo paso.
export async function getLineaBus(codigo, { fecha = null, hora = null } = {}) {
  await asegurarIndice();
  const real = ahoraRed();
  const segForzado = hora != null ? segDeHora(hora) : null;
  const ymd = fecha || real.ymd;
  const seg = segForzado != null ? segForzado : real.seg;

  const gen = itinerariosDeLinea(codigo, { ymd, seg });
  if (gen) {
    // El índice trabaja con ids pelados; hacia fuera todo va prefijado, igual
    // que en el resto de la API (un id sin prefijo se resolvería como "gen:",
    // pero emitirlo a medias sería pedirle al cliente que se lo suponga).
    for (const s of gen.sentidos) for (const p of s.paradas) p.id = "gen:" + p.id;
    return { ...gen, ahora: hhmmDeSeg(seg), fecha_servicio: ymd, fuentes: fuentes(indiceListo()) };
  }

  // Si no es interurbana, puede ser urbana de Barcelona. TMB no publica horario
  // aquí, así que su recorrido va SIN horas: solo el orden de los postes, y cada
  // uno lleva a su tablero en vivo. Es lo que hay, y decirlo es mejor que
  // inventar una hora.
  const tmb = await getRecorridoTMB(codigo);
  if (tmb) return { ...tmb, ahora: hhmmDeSeg(seg), fecha_servicio: ymd, fuentes: fuentes(indiceListo()) };

  const e = new Error(`Línea ${codigo} no encontrada`);
  e.status = 404;
  throw e;
}

/* ------------------------------------- paradas de bus cerca de una ESTACIÓN de tren */

export async function getParadasBusCercaEstacion(stationId, { radio = 400, limite = 6 } = {}) {
  const estaciones = await getStations();
  const est = estaciones.find((s) => s.id === String(stationId));
  if (!est) throw noEncontrada(stationId);
  // Una estación sin coordenadas no es un fallo del feed: es una lista vacía.
  if (!Number.isFinite(est.lat) || !Number.isFinite(est.lon)) {
    return { paradas: [], total: 0, motivo: "sin coordenadas" };
  }
  await asegurarIndice();
  // Las estaciones no se mueven: se cachea 1 h con la caché que ya existe.
  const paradas = await cacheStatic(`cerca:${est.id}:${radio}:${limite}`,
    () => cercaDePunto(est.lat, est.lon, radio, limite));
  return { paradas, total: paradas.length, estacion: { id: est.id, name: est.name } };
}
