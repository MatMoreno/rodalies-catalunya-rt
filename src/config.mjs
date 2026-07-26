// Configuración: lo que viene de fuera (claves de TMB, rutas del GTFS) resuelto
// UNA vez y exportado ya masticado.
//
// Nadie más lee `process.env`: en ESM los imports se elevan, así que un módulo
// que consultara el entorno al evaluarse podría correr antes que este lector y
// ver las variables vacías. Exportando valores resueltos, el orden da igual.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Lectura mínima de .env. Para dos claves no compensa traerse dotenv, y el repo
// vive con dos dependencias a propósito. Lo que ya viene en el entorno manda
// sobre el fichero, así `TMB_APP_ID=x npm start` sigue funcionando.
try {
  const txt = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const linea of txt.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(linea)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linea);
    if (!m) continue;
    const val = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch {
  // Sin .env se funciona igual, solo que sin la mitad de TMB.
}

// --- TMB (buses urbanos de Barcelona, tiempo real) ---
// Claves gratuitas de developer.tmb.cat. Sin ellas, TODA la parte de TMB se
// apaga sola y la app sigue dando los interurbanos completos.
export const TMB_APP_ID = process.env.TMB_APP_ID || "";
export const TMB_APP_KEY = process.env.TMB_APP_KEY || "";
export const TMB_ACTIVO = !!(TMB_APP_ID && TMB_APP_KEY);

// --- GTFS de autobuses interurbanos de la Generalitat ---
export const GTFS_URL =
  process.env.GTFS_URL ||
  "https://analisi.transparenciacatalunya.cat/download/bca2-b4i3/application/zip";
export const GTFS_DIR =
  process.env.GTFS_DIR || fileURLToPath(new URL("../data/gtfs", import.meta.url));
export const GTFS_DIAS = Number(process.env.GTFS_DIAS || 7);

// La red catalana vive en esta zona. Las horas del GTFS son de reloj de pared
// de aquí, no del reloj de la máquina que sirve la web.
export const TZ_RED = "Europe/Madrid";
