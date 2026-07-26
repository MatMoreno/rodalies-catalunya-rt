// Cliente de la API de TMB (buses urbanos de Barcelona).
//
//   https://api.tmb.cat/v1  ·  autenticación por ?app_id=&app_key=
//   Claves gratuitas en developer.tmb.cat
//
// Endpoints usados:
//   GET /transit/parades          -> catálogo de paradas (GeoJSON, 2.721)
//   GET /transit/linies/bus       -> líneas con su color de marca (116)
//   GET /ibus/stops/{codi}        -> próximos buses EN VIVO de esa parada
//
// SIN CLAVES TODO ESTO SE APAGA SOLO: cada función devuelve vacío al instante,
// sin peticiones ni ruido en el log. Como el propio catálogo de paradas está
// tras clave, quien no tenga cuenta simplemente no ve ninguna parada de TMB y
// se queda con los interurbanos completos.

import { TMB_APP_ID, TMB_APP_KEY, TMB_ACTIVO } from "./config.mjs";
import { cached } from "./cache.mjs";

const BASE = "https://api.tmb.cat/v1";
const cacheDia = cached(24 * 60 * 60_000); // catálogos: 24 h
const cacheVivo = cached(20_000);          // iBus: 20 s, como las salidas de tren

// Motivo por el que TMB no está disponible, para poder decirlo en la respuesta
// en vez de fingir que no hay buses.
let ultimoFallo = null;
// Hasta cuándo no se vuelve a intentar. Unas claves mal copiadas no se arreglan
// reintentando cada 20 s: sin esto, cada tablero de Barcelona lanzaba tres
// peticiones condenadas al 401.
let mudoHasta = 0;
const mudo = () => Date.now() < mudoHasta;

async function pedir(ruta) {
  const sep = ruta.includes("?") ? "&" : "?";
  // Las claves viajan solo de servidor a servidor: jamás salen en una respuesta
  // ni en una URL que vea el navegador.
  const url = `${BASE}${ruta}${sep}app_id=${encodeURIComponent(TMB_APP_ID)}&app_key=${encodeURIComponent(TMB_APP_KEY)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "rodalies-rt (uso personal)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const e = new Error(`TMB ${res.status} ${ruta}`);
    e.status = res.status;
    throw e;
  }
  // Si vuelve a responder, se olvida el fallo anterior: si no, una caída de un
  // minuto dejaría la app diciendo "TMB no disponible" para siempre.
  ultimoFallo = null;
  mudoHasta = 0;
  return res.json();
}

function anotarFallo(e) {
  // Un 404 es "esa línea o parada no existe", no una avería: no se apunta como
  // fallo del servicio ni silencia lo demás. Callar TMB entero porque alguien
  // pidió un código que no existe sería regalarle a un enlace roto el poder de
  // apagar el tiempo real de toda la app.
  if (e?.status === 404) return null;
  const auth = e?.status === 401 || e?.status === 403;
  ultimoFallo =
    auth ? "claves no autorizadas"
    : e?.name === "TimeoutError" || e?.name === "AbortError" ? "tiempo de espera agotado"
    : `error al consultar TMB (${e?.message || e})`;
  // Un problema de claves es de configuración, no pasajero: se calla diez
  // minutos. Un fallo de red, solo medio minuto.
  mudoHasta = Date.now() + (auth ? 600_000 : 30_000);
  return null;
}

// Catálogo de paradas. GeoJSON: properties.CODI_PARADA es el código que usa iBus.
export async function getParadasTMB() {
  if (!TMB_ACTIVO || mudo()) return [];
  try {
    return await cacheDia("parades", async () => {
      const j = await pedir("/transit/parades");
      const out = [];
      for (const f of j.features || []) {
        const p = f.properties || {};
        const [lon, lat] = f.geometry?.coordinates || [];
        if (p.CODI_PARADA == null || !Number.isFinite(lat)) continue;
        out.push({
          id: String(p.CODI_PARADA),
          name: p.NOM_PARADA || "",
          detalle: p.DESC_PARADA || p.ADRECA || null,
          municipio: p.NOM_POBLACIO || null,
          lat, lon,
        });
      }
      return out;
    });
  } catch (e) { anotarFallo(e); return []; }
}

// Líneas de bus, indexadas por su código público ("H12", "V15", "123"…).
// De aquí salen dos cosas que iBus no da: el destino y el COLOR OFICIAL.
export async function getLineasTMB() {
  if (!TMB_ACTIVO || mudo()) return new Map();
  try {
    return await cacheDia("linies", async () => {
      const j = await pedir("/transit/linies/bus");
      const m = new Map();
      for (const f of j.features || []) {
        const p = f.properties || {};
        const codigo = String(p.NOM_LINIA ?? p.CODI_LINIA ?? "").trim();
        if (!codigo || m.has(codigo)) continue;
        m.set(codigo, {
          codigo,
          // El código público ("H12") NO sirve para pedir el recorrido: ese
          // endpoint quiere CODI_LINIA ("212"). Con el público da 404 y con
          // ID_LINIA responde 200 con cero paradas, que es peor.
          codigoInterno: p.CODI_LINIA != null ? String(p.CODI_LINIA) : null,
          descripcion: p.DESC_LINIA || null,
          origen: p.ORIGEN_LINIA || null,
          destino: p.DESTI_LINIA || null,
          operador: p.NOM_OPERADOR || null,
          // Vienen en hexadecimal sin almohadilla ("DA291C").
          color: p.COLOR_LINIA ? `#${p.COLOR_LINIA}` : null,
          colorTexto: p.COLOR_TEXT_LINIA ? `#${p.COLOR_TEXT_LINIA}` : null,
        });
      }
      return m;
    });
  } catch (e) { anotarFallo(e); return new Map(); }
}

let volcadoHecho = false;

// Próximos buses EN VIVO de una parada. Fuera de servicio devuelve lista vacía,
// que no es un error: de madrugada casi toda la red urbana está parada.
export async function getIBus(codiParada) {
  if (!TMB_ACTIVO || mudo()) return [];
  try {
    return await cacheVivo("ibus:" + codiParada, async () => {
      const j = await pedir(`/ibus/stops/${encodeURIComponent(codiParada)}`);
      const arr = j?.data?.ibus || [];
      // La forma exacta de estos objetos solo se puede confirmar con la red en
      // marcha, así que la primera respuesta con datos se vuelca una vez al log.
      if (arr.length && !volcadoHecho) {
        volcadoHecho = true;
        console.log("TMB iBus, primera respuesta con datos:", JSON.stringify(arr[0]));
      }
      return arr.map((b) => ({
        linea: String(b.line ?? b.routeId ?? "").trim(),
        enMin: Number.isFinite(Number(b["t-in-min"])) ? Number(b["t-in-min"]) : null,
        segundos: Number.isFinite(Number(b["t-in-s"])) ? Number(b["t-in-s"]) : null,
        texto: b["text-ca"] || null,
        destino: b.destination || b.desti || null,
      })).filter((b) => b.linea);
    });
  } catch (e) { anotarFallo(e); return []; }
}

// Recorrido de una línea urbana: sus paradas en orden, por sentido.
//
// TMB no publica horario por esta vía, así que esto va SIN horas: es el trazado
// y punto, y cada poste lleva a su tablero en vivo. `ORDRE` da el orden real y
// `ID_RECORREGUT` separa los dos sentidos, que vienen etiquetados con
// ORIGEN_SENTIT / DESTI_SENTIT.
export async function getRecorridoTMB(codigo) {
  if (!TMB_ACTIVO || mudo()) return null;
  const lineas = await getLineasTMB();
  const info = lineas.get(String(codigo).trim());
  if (!info?.codigoInterno) return null;
  try {
    return await cacheDia("rec:" + info.codigo, async () => {
      const j = await pedir(`/transit/linies/bus/${encodeURIComponent(info.codigoInterno)}/parades`);
      const porSentido = new Map();
      for (const f of j.features || []) {
        const p = f.properties || {};
        const [lon, lat] = f.geometry?.coordinates || [];
        const clave = p.ID_RECORREGUT;
        let s = porSentido.get(clave);
        if (!s) porSentido.set(clave, (s = { hacia: p.DESTI_SENTIT || null, desde: p.ORIGEN_SENTIT || null, paradas: [] }));
        s.paradas.push({
          id: "tmb:" + p.CODI_PARADA, name: p.NOM_PARADA || "", detalle: p.DESC_PARADA || null,
          lat, lon, orden: Number(p.ORDRE) || 0,
          hora: null, enMin: null, final: !!p.ES_DESTI,
        });
      }
      const sentidos = [...porSentido.values()];
      for (const s of sentidos) {
        s.paradas.sort((a, b) => a.orden - b.orden);
        s.paradas.forEach((p) => delete p.orden);
        s.viajes = null;   // TMB no publica ni viajes ni calendario por aquí
        s.salida = null;   // y sin horario no hay "próximo paso" que dar
        s.otros_finales = [];
      }
      return {
        linea: info.codigo, fuente: "tmb", recorrido: info.descripcion,
        operador: info.operador, color: info.color, colorTexto: info.colorTexto,
        variantes: sentidos.length, sin_horario: true, sentidos,
      };
    });
  } catch (e) { anotarFallo(e); return null; }
}

// Estado para el campo `fuentes.tmb` de la respuesta.
export function estadoTMB() {
  if (!TMB_ACTIVO) {
    return { disponible: false, motivo: "sin claves" };
  }
  return ultimoFallo
    ? { disponible: false, motivo: ultimoFallo }
    : { disponible: true, motivo: null };
}
