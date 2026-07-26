// Lector de ZIP mínimo: solo lo justo para el GTFS de la Generalitat.
//
// ¿Por qué no una dependencia? Porque las que hay (fflate, adm-zip) trabajan
// sobre el archivo ENTERO en memoria y devuelven todas las entradas de golpe.
// Aquí el archivo son 25 MB y contiene un shapes.txt de 77 MB que no queremos
// ni rozar. Trabajando sobre un descriptor de fichero se infla UNA entrada cada
// vez y a shapes.txt no se le leen ni los bytes comprimidos: el pico de memoria
// baja de ~55 MB a ~24 MB y el repo sigue con dos dependencias.
//
// El subconjunto del formato que hace falta es fijo y el productor es un solo
// sistema conocido. Y cuando algo no encaja, esto revienta con un error claro
// en el momento de la descarga, que es un riesgo muy distinto a devolver datos
// mal en silencio.

import { openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";

const FIN_CD = 0x06054b50;   // End Of Central Directory
const ENTRADA_CD = 0x02014b50; // cabecera del directorio central
const LOCAL = 0x04034b50;    // cabecera local, justo antes de los datos
const ZIP64_FIN = 0x06064b50;

function leer(fd, pos, n) {
  const b = Buffer.allocUnsafe(n);
  const leidos = readSync(fd, b, 0, n, pos);
  return leidos === n ? b : b.subarray(0, leidos);
}

// El EOCD está al final, pero puede llevar detrás un comentario de hasta 64 KB,
// así que se busca hacia atrás y vale la ÚLTIMA coincidencia (un comentario
// podría contener la firma por casualidad).
function buscarFinCD(fd, tamano) {
  const cola = Math.min(tamano, 66_000);
  const buf = leer(fd, tamano - cola, cola);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === FIN_CD) return { buf, i, base: tamano - cola };
  }
  throw new Error("ZIP inválido: no se encuentra el final del directorio central");
}

export function abrirZip(ruta) {
  const fd = openSync(ruta, "r");
  try {
    const tamano = statSync(ruta).size;
    const { buf, i } = buscarFinCD(fd, tamano);

    const nEntradas = buf.readUInt16LE(i + 10);
    const desplazamientoCD = buf.readUInt32LE(i + 16);

    // Zip64: en vez de implementarlo, se avisa. Este archivo no lo es (ni llega
    // a 65535 entradas ni a 4 GB); si algún día lo fuera, es el momento de
    // traerse fflate en lugar de ampliar esto a ciegas.
    if (nEntradas === 0xffff || desplazamientoCD === 0xffffffff) {
      throw new Error("ZIP en formato Zip64: no soportado por este lector");
    }

    const cd = leer(fd, desplazamientoCD, tamano - desplazamientoCD);
    const entradas = [];
    let p = 0;
    for (let n = 0; n < nEntradas; n++) {
      if (cd.readUInt32LE(p) !== ENTRADA_CD) break;
      const metodo = cd.readUInt16LE(p + 10);
      const compTam = cd.readUInt32LE(p + 20);
      const tam = cd.readUInt32LE(p + 24);
      const nomLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const comLen = cd.readUInt16LE(p + 32);
      const desplazamientoLocal = cd.readUInt32LE(p + 42);
      const nombre = cd.subarray(p + 46, p + 46 + nomLen).toString("utf8");
      // Fecha MS-DOS: en `fecha` los bits 0-4 son el día, 5-8 el mes y 9-15 los
      // años desde 1980. Es lo más parecido a una "fecha de publicación" que
      // trae el feed, y sirve para avisar de que el horario se ha quedado viejo.
      const dosFecha = cd.readUInt16LE(p + 14);
      const publicado = dosFecha
        ? `${1980 + (dosFecha >> 9)}-${String((dosFecha >> 5) & 15).padStart(2, "0")}-${String(dosFecha & 31).padStart(2, "0")}`
        : null;
      entradas.push({ nombre, metodo, compTam, tam, desplazamientoLocal, publicado });
      p += 46 + nomLen + extraLen + comLen;
    }
    return { fd, entradas };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

// Infla UNA entrada y devuelve su Buffer.
export function extraerEntrada(fd, entrada) {
  const cab = leer(fd, entrada.desplazamientoLocal, 30);
  if (cab.readUInt32LE(0) !== LOCAL) {
    throw new Error(`ZIP inválido: cabecera local corrupta en ${entrada.nombre}`);
  }
  // OJO: las longitudes de nombre y extra de la cabecera LOCAL no tienen por
  // qué coincidir con las del directorio central (el campo extra suele diferir).
  // Este es el fallo clásico al leer zips a mano: hay que usar las de aquí.
  // El tamaño comprimido y el método, en cambio, se toman del CENTRAL, porque
  // las entradas con descriptor de datos los traen a cero en la cabecera local.
  const inicio = entrada.desplazamientoLocal + 30 + cab.readUInt16LE(26) + cab.readUInt16LE(28);
  const crudo = leer(fd, inicio, entrada.compTam);

  if (entrada.metodo === 0) return crudo;              // almacenado
  if (entrada.metodo === 8) return inflateRawSync(crudo); // deflate
  throw new Error(`ZIP: método de compresión ${entrada.metodo} no soportado (${entrada.nombre})`);
}

// Extrae a `destino` las entradas cuyo nombre pase el filtro. Las demás no se
// leen siquiera. Devuelve { nombre: bytes } de lo extraído.
export function extraerZip(ruta, destino, filtro = () => true) {
  const { fd, entradas } = abrirZip(ruta);
  const escritas = {};
  try {
    for (const e of entradas) {
      // Nombre plano: el GTFS no trae subdirectorios y así no hay travesía de
      // rutas ("../") posible.
      const base = e.nombre.split(/[\\/]/).pop();
      if (!base || !filtro(base)) continue;
      writeFileSync(join(destino, base), extraerEntrada(fd, e));
      escritas[base] = { bytes: e.tam, publicado: e.publicado };
    }
  } finally {
    closeSync(fd);
  }
  return escritas;
}
