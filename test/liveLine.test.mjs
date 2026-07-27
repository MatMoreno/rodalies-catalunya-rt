// La vista de línea en vivo tenía el mismo fallo de lectura que el tablero: si
// `stations[0]` se toma por la próxima parada, el tren en marcha o desaparece o
// se dibuja pegado a la estación de la que salió hace media hora.
//
// Necesita `--experimental-test-module-mocks` (está en el script `npm test`).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const AHORA = "2026-07-27T07:55:00";
const t0 = Date.parse(AHORA);
const min = (m) => new Date(t0 + m * 60_000).toISOString().slice(0, 19);

const LINEA = {
  id: "R1", name: "R1", origin: "P1", destination: "P6",
  stations: [1, 2, 3, 4, 5, 6].map((i) => ({ id: String(i), name: "P" + i, accessible: false })),
};

const mkTren = ({ num, paradas, next, delay = 0 }) => ({
  commercialNumber: num,
  line: { id: "R1" },
  delay,
  stations: paradas.map(([id, m]) => ({ id, name: "P" + id, arrivalDateHour: min(m), departureDateHour: min(m) })),
  nextStation: { id: next, name: "P" + next },
  originStation: { id: paradas[0][0], name: "P" + paradas[0][0] },
  destinationStation: { id: paradas[paradas.length - 1][0], name: "P" + paradas[paradas.length - 1][0] },
  __apiNow: AHORA,
});

const TRENES = [
  // En marcha entre P3 y P4: salió de P1 hace 34 min.
  mkTren({ num: 25716, paradas: [["1", -34], ["2", -20], ["3", -8], ["4", 3], ["5", 12], ["6", 30]], next: "4" }),
  // Aún sin salir de P4.
  mkTren({ num: 25718, paradas: [["4", 11], ["5", 20], ["6", 38]], next: "4" }),
  // Fantasma congelado.
  mkTren({ num: 90000, paradas: [["1", -90], ["2", -70], ["3", -50], ["4", -35], ["5", 5]], next: "3", delay: -52 }),
];

mock.module("../src/api.mjs", {
  namedExports: {
    getLine: async () => LINEA,
    getDepartures: async () => TRENES,
    getStations: async () => [],
  },
});

const { getLineaEnVivo } = await import("../src/liveLine.mjs");

test("el tren en marcha se sitúa entre su parada anterior y la próxima", async () => {
  const r = await getLineaEnVivo("R1");

  assert.deepEqual(r.trenes.map((t) => t.tren), [25716]);
  const t = r.trenes[0];
  assert.equal(t.estado, "circulando");
  assert.equal(t.proxima.name, "P4");   // no "P1", que es de donde salió
  assert.equal(t.proxima.enMin, 3);
  assert.equal(t.anterior.name, "P3");
  assert.equal(t.direccion, 1);

  // El horario que se pinta empieza en la próxima parada, no en el origen.
  assert.deepEqual(t.horario.map((h) => h.li), [3, 4, 5]);
});

test("el que no ha salido va a próximas salidas y el fantasma se descarta", async () => {
  const r = await getLineaEnVivo("R1");
  assert.deepEqual(r.proximas_salidas.map((t) => t.tren), [25718]);
  assert.equal(r.proximas_salidas[0].estado, "programado");
  assert.equal(r.caducados, 1);
});
