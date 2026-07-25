// Servidor HTTP: expone la API de estado/incidencias de Rodalies Catalunya
// y sirve el panel web (public/).
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getIncidencias, getEstadoLineas } from "./rodalies.mjs";
import { getLines, getStations } from "./api.mjs";
import { getLineaEnVivo } from "./liveLine.mjs";
import { getSalidasParada } from "./stopBoard.mjs";

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
    res.status(code).json({
      error: code === 404 ? String(err.message) : "No se pudo leer el feed de Renfe",
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

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(express.static(join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`Rodalies RT en http://localhost:${PORT}`);
});
