// Descarga y caché en disco del GTFS de autobuses interurbanos de la Generalitat.
//
//   https://analisi.transparenciacatalunya.cat/download/bca2-b4i3/application/zip
//   ~25 MB, sin autenticación, republicado cada pocas semanas.
//
// El fichero se guarda en data/gtfs/actual/ y solo se vuelve a bajar si lleva
// más de GTFS_DIAS días. Con GET condicional, comprobar que no ha cambiado
// cuesta 1 KB en vez de 25 MB.
//
// Nada de esto ocurre al importar el módulo: la descarga se lanza DESPUÉS de
// que el servidor esté escuchando. La app de trenes no puede quedarse esperando
// 25 MB de buses para arrancar.

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync,
         rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GTFS_URL, GTFS_DIR, GTFS_DIAS } from "./config.mjs";
import { extraerZip } from "./unzip.mjs";

// shapes.txt son 77 MB de geometría de trazado que no usamos para nada.
const FICHEROS = ["agency.txt", "calendar.txt", "calendar_dates.txt",
                  "routes.txt", "stops.txt", "stop_times.txt", "trips.txt"];

const dirActual = () => join(GTFS_DIR, "actual");
const rutaMeta = () => join(GTFS_DIR, "meta.json");

export function leerMeta() {
  try {
    return JSON.parse(readFileSync(rutaMeta(), "utf8"));
  } catch {
    return null;
  }
}

function feedCompleto() {
  return FICHEROS.every((f) => existsSync(join(dirActual(), f)));
}

async function descargar(meta) {
  mkdirSync(GTFS_DIR, { recursive: true });
  const zipParcial = join(GTFS_DIR, "feed.zip.parcial");
  const zip = join(GTFS_DIR, "feed.zip");

  // GET condicional: si el servidor dice 304, nos ahorramos los 25 MB.
  const cab = { "user-agent": "rodalies-rt (uso personal)" };
  if (meta?.etag) cab["if-none-match"] = meta.etag;
  if (meta?.lastModified) cab["if-modified-since"] = meta.lastModified;

  const res = await fetch(GTFS_URL, { headers: cab, redirect: "follow",
                                      signal: AbortSignal.timeout(180_000) });
  if (res.status === 304) {
    res.body?.cancel();
    return { sinCambios: true };
  }
  if (!res.ok) throw new Error(`GTFS ${res.status} al descargar el feed de bus`);

  // Por streaming: la respuesta nunca se acumula entera en memoria.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipParcial));
  rmSync(zip, { force: true });
  renameSync(zipParcial, zip);

  return {
    sinCambios: false,
    zip,
    bytes: statSync(zip).size,
    etag: res.headers.get("etag") || null,
    lastModified: res.headers.get("last-modified") || null,
  };
}

// Extrae a un directorio nuevo y lo intercambia por el bueno.
//
// En Windows `rename` sobre un directorio que ya existe y no está vacío falla,
// así que no vale el intercambio de dos pasos de toda la vida: hay que apartar
// el viejo primero y poder devolverlo si algo se tuerce por el camino.
function instalar(zip) {
  const nuevo = join(GTFS_DIR, ".nuevo");
  const viejo = join(GTFS_DIR, ".viejo");
  rmSync(nuevo, { recursive: true, force: true });
  rmSync(viejo, { recursive: true, force: true });
  mkdirSync(nuevo, { recursive: true });

  const escritas = extraerZip(zip, nuevo, (n) => FICHEROS.includes(n));
  const faltan = FICHEROS.filter((f) => !(f in escritas));
  if (faltan.length) throw new Error(`GTFS incompleto, faltan: ${faltan.join(", ")}`);

  const actual = dirActual();
  const habia = existsSync(actual);
  if (habia) renameSync(actual, viejo);
  try {
    renameSync(nuevo, actual);
  } catch (e) {
    if (habia) renameSync(viejo, actual); // deshacer: mejor el feed viejo que ninguno
    throw e;
  }
  rmSync(viejo, { recursive: true, force: true });
  rmSync(zip, { force: true }); // ya está extraído: 25 MB que no hace falta guardar
  return escritas;
}

let enCurso = null; // vuelo único: si ya se está descargando, todos esperan lo mismo

export function asegurarFeed({ force = false } = {}) {
  if (enCurso) return enCurso;

  enCurso = (async () => {
    const meta = leerMeta();
    const edadMs = meta?.descargado ? Date.now() - meta.descargado : Infinity;
    const caducado = edadMs > GTFS_DIAS * 86_400_000;

    if (!force && !caducado && feedCompleto()) {
      console.log(`GTFS bus: caché en disco, ${Math.floor(edadMs / 86_400_000)} días`);
      return { ...meta, dir: dirActual(), descargadoAhora: false };
    }

    console.log(`GTFS bus: ${feedCompleto() ? "comprobando versión" : "descargando"}…`);
    const t0 = Date.now();
    const d = await descargar(meta);

    if (d.sinCambios && feedCompleto()) {
      console.log(`GTFS bus: sin cambios (304) en ${Date.now() - t0} ms`);
      const nuevoMeta = { ...meta, descargado: Date.now() };
      writeFileSync(rutaMeta(), JSON.stringify(nuevoMeta, null, 2));
      return { ...nuevoMeta, dir: dirActual(), descargadoAhora: false };
    }
    // Un 304 con el directorio incompleto (borrado a mano) obliga a bajarlo de
    // verdad: se repite la petición sin validadores.
    const datos = d.sinCambios ? await descargar(null) : d;

    const escritas = instalar(datos.zip);
    const entradas = {};
    let publicado = null;
    for (const [n, v] of Object.entries(escritas)) {
      entradas[n] = v.bytes;
      if (v.publicado && (!publicado || v.publicado > publicado)) publicado = v.publicado;
    }
    const nuevoMeta = {
      url: GTFS_URL,
      descargado: Date.now(),
      publicado,
      bytes: datos.bytes,
      etag: datos.etag,
      lastModified: datos.lastModified,
      entradas,
      version: 1,
    };
    writeFileSync(rutaMeta(), JSON.stringify(nuevoMeta, null, 2));
    console.log(`GTFS bus: feed listo en ${Date.now() - t0} ms (${(datos.bytes / 1e6).toFixed(1)} MB)`);
    return { ...nuevoMeta, dir: dirActual(), descargadoAhora: true };
  })().finally(() => { enCurso = null; });

  return enCurso;
}

export function rutaFichero(nombre) {
  return join(dirActual(), nombre);
}
