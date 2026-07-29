// Servidor HTTP: expone la API de estado/incidencias de Rodalies Catalunya
// y sirve el panel web (public/).
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getIncidencias, getEstadoLineas } from "./rodalies.mjs";
import { getLines, getStations } from "./api.mjs";
import { getLineaEnVivo } from "./liveLine.mjs";
import { getSalidasParada } from "./stopBoard.mjs";
import { asegurarIndice } from "./gtfsIndex.mjs";
import { BUS_ACTIVO } from "./config.mjs";
import {
  getEstadoBus, buscarParadasBus, getParadaBus,
  getSalidasParadaBus, getParadasBusCercaEstacion,
  buscarTodo, getLineaBus, getViajeBus,
} from "./busBoard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3020;

// CORS abierto: es un proxy de solo lectura de datos públicos, así puede
// consumirlo el artifact u otra web. (Nota: una página https no podrá llamar
// a http://localhost por "mixed content"; para eso hay que desplegar con https.)
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// Envuelve un handler async y canaliza los errores a una respuesta JSON limpia.
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    // Un 404 nuestro (parada/línea inexistente) no es un fallo del feed.
    const code = err.status === 404 ? 404 : 502;
    // Hay tres feeds en juego (Renfe, Rodalies y el GTFS de bus): culpar
    // siempre a Renfe despistaba al depurar.
    res.status(code).json({
      error: code === 404 ? String(err.message) : `No se pudo leer ${err.fuente || "el feed"}`,
      detalle: String(err.message || err),
    });
  });

// Todas las incidencias de Catalunya (crudas y parseadas).
app.get("/api/incidencias", wrap(async (req, res) => {
  res.json(await getIncidencias({ force: req.query.force === "1" }));
}));

// Estado por línea (R1–R17, RG1…): normal o incidencia.
app.get("/api/estado", wrap(async (req, res) => {
  res.json(await getEstadoLineas({ force: req.query.force === "1" }));
}));

// Estado de una línea concreta: /api/estado/R4
app.get("/api/estado/:linea", wrap(async (req, res) => {
  const linea = req.params.linea.toUpperCase();
  const { lineas } = await getEstadoLineas();
  const found = lineas.find((l) => l.linea === linea);
  if (!found) return res.status(404).json({ error: `Línea ${linea} no encontrada` });
  res.json(found);
}));

// --- Vista de línea EN VIVO (backend oficial de Rodalies) ---

// Catálogo de líneas para el selector.
app.get("/api/lineas", wrap(async (_req, res) => {
  const lineas = (await getLines()).sort((a, b) => a.orderNumber - b.orderNumber);
  res.json({ lineas });
}));

// Línea con sus paradas + trenes situados entre paradas, en vivo.
app.get("/api/linea/:id/vivo", wrap(async (req, res) => {
  res.json(await getLineaEnVivo(req.params.id.toUpperCase(), { demo: req.query.demo === "1" }));
}));

// --- Salidas por PARADA (la vista principal) ---

// Catálogo de estaciones para el buscador. ?q= filtra por nombre.
app.get("/api/paradas", wrap(async (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  let paradas = await getStations();
  if (q) {
    // Sin acentos: NFD separa la tilde en marca combinante y \p{M} la quita.
    const norm = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const nq = norm(q);
    paradas = paradas.filter((s) => norm(s.name).includes(nq));
  }
  res.json({ paradas, total: paradas.length });
}));

// Próximos trenes desde una parada.
// ?linea=R1 filtra por línea · ?sentido=<extremo> por dirección · ?limite=N recorta.
app.get("/api/parada/:id/salidas", wrap(async (req, res) => {
  const limite = Math.min(60, Math.max(1, Number(req.query.limite) || 30));
  const linea = req.query.linea ? String(req.query.linea).toUpperCase() : null;
  const sentido = req.query.sentido ? String(req.query.sentido) : null;
  res.json(await getSalidasParada(req.params.id, { linea, sentido, limite }));
}));

// --- BUS: horarios (GTFS de la Generalitat) + tiempo real (iBus de TMB) ---
//
// Todo esto vive detrás de `BUS_ACTIVO`, que viene apagado (ver config.mjs).

// La única ruta de bus que responde siempre: dice si el modo está encendido.
// La web la usa para enseñar u ocultar el enlace del menú, así que tiene que
// contestar también con la bandera apagada, y sin dar un 404 que ensucie la
// consola del navegador cada vez que se carga una página.
app.get("/api/bus/activo", (_req, res) => res.json({ activo: BUS_ACTIVO }));

// Con el modo apagado, el resto de la superficie de bus deja de existir: un 404
// limpio en la puerta, en vez de un `if` repetido en cada una de las ocho rutas.
app.use(["/api/bus", "/api/parada/:id/buses"], (_req, res, next) => {
  if (BUS_ACTIVO) return next();
  res.status(404).json({ error: "El modo bus está desactivado en este servidor" });
});

// Estado del feed de bus: si está listo, de cuándo es y hasta cuándo vale.
// Responde AL MOMENTO aunque se esté descargando, para que la web pueda pintar
// un esqueleto en vez de quedarse colgada. ?force=1 comprueba si hay versión nueva.
app.get("/api/bus/estado", wrap(async (req, res) => {
  res.json(await getEstadoBus({ force: req.query.force === "1" }));
}));

// Buscador de paradas de bus. Son 9.010, así que el filtrado es del servidor:
// mandar el catálogo entero al navegador serían más de 1 MB por visita.
// ?q= nombre (sin acentos) · ?lat=&lon=&r= alternativa por cercanía · ?limite=
app.get("/api/bus/paradas", wrap(async (req, res) => {
  const num = (v) => (v == null ? null : Number(v));
  res.json(await buscarParadasBus(req.query.q || "", {
    limite: Math.min(50, Math.max(1, Number(req.query.limite) || 20)),
    lat: num(req.query.lat),
    lon: num(req.query.lon),
    radio: Math.min(3000, Math.max(50, Number(req.query.r) || 600)),
  }));
}));

// Buscador único: a veces no se busca una parada, se busca un bus. Devuelve
// líneas Y paradas para que la interfaz no obligue a elegir modo antes de saber
// qué se está buscando.
app.get("/api/bus/buscar", wrap(async (req, res) => {
  res.json(await buscarTodo(req.query.q || "", {
    limite: Math.min(50, Math.max(1, Number(req.query.limite) || 20)),
  }));
}));

// Recorrido de una línea, por sentidos, con las horas del próximo paso:
// /api/bus/linea/N82 · ?fecha=&hora= igual que el tablero.
app.get("/api/bus/linea/:codigo", wrap(async (req, res) => {
  res.json(await getLineaBus(req.params.codigo, {
    fecha: req.query.fecha ? Number(req.query.fecha) : null,
    hora: req.query.hora ? String(req.query.hora) : null,
  }));
}));

// Recorrido de UN autobús concreto, el de una fila del tablero: de dónde viene,
// por dónde ha pasado y hasta dónde sigue. /api/bus/viaje/1685576
app.get("/api/bus/viaje/:id", wrap(async (req, res) => {
  res.json(await getViajeBus(req.params.id, {
    fecha: req.query.fecha ? Number(req.query.fecha) : null,
    hora: req.query.hora ? String(req.query.hora) : null,
  }));
}));

// Ficha de una parada: /api/bus/parada/gen:PF08019187
app.get("/api/bus/parada/:id", wrap(async (req, res) => {
  res.json(await getParadaBus(req.params.id));
}));

// Próximos buses desde una parada.
// ?linea=L63 · ?destino=… · ?ventana=120 (min) · ?limite=N
// ?fecha=20260801&hora=00:10 fuerza el momento (para probar el cambio de día).
app.get("/api/bus/parada/:id/salidas", wrap(async (req, res) => {
  res.json(await getSalidasParadaBus(req.params.id, {
    linea: req.query.linea ? String(req.query.linea) : null,
    destino: req.query.destino ? String(req.query.destino) : null,
    ventana: Math.min(1440, Math.max(15, Number(req.query.ventana) || 120)),
    limite: Math.min(60, Math.max(1, Number(req.query.limite) || 30)),
    fecha: req.query.fecha ? Number(req.query.fecha) : null,
    hora: req.query.hora ? String(req.query.hora) : null,
  }));
}));

// Paradas de bus cerca de una ESTACIÓN de Rodalies (id del GRS, sin prefijo).
app.get("/api/parada/:id/buses", wrap(async (req, res) => {
  res.json(await getParadasBusCercaEstacion(req.params.id, {
    radio: Math.min(1500, Math.max(50, Number(req.query.radio) || 400)),
    limite: Math.min(20, Math.max(1, Number(req.query.limite) || 6)),
  }));
}));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(express.static(join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`Rodalies RT en http://localhost:${PORT}`);
  if (!BUS_ACTIVO) {
    // Se dice en el arranque para que nadie busque el error en otra parte: la
    // ausencia de buses es una decisión, no una avería.
    console.log("Modo bus apagado · BUS=1 en .env para encenderlo");
    return;
  }
  // El GTFS de bus son 25 MB: se baja en segundo plano y DESPUÉS de escuchar.
  // Si esto bloqueara el arranque, la parte de trenes —que ya funcionaba— se
  // quedaría esperando a los autobuses para dar señales de vida.
  asegurarIndice().catch((e) => console.error("GTFS bus:", e.message));
});
