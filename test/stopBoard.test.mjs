// El tablero de una parada, con la API simulada: reproduce lo que pasaba en
// Arenys de Mar el 27/07 a las 07:55, cuando de los trenes hacia Barcelona solo
// aparecía el que todavía no había salido de la estación.
//
// Necesita `--experimental-test-module-mocks` (está en el script `npm test`).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

// El momento y el formateo de horas viven en un solo sitio (ver momento.mjs):
// tres copias de la misma línea eran tres copias del mismo error.
import { MOMENTO as AHORA, t0, min } from "./momento.mjs";

// Línea de seis paradas; "mi parada" es la 4.
const LINEA = {
  id: "R1", name: "R1", origin: "P1", destination: "P6",
  stations: [1, 2, 3, 4, 5, 6].map((i) => ({ id: String(i), name: "P" + i, accessible: false })),
};

// Un tren tal y como lo devuelve la API: `stations[]` es el recorrido COMPLETO,
// con las paradas ya servidas (minutos negativos) incluidas.
const mkTren = ({ num, paradas, next, salida, delay = 0 }) => ({
  commercialNumber: num,
  line: { id: "R1" },
  delay,
  stations: paradas.map(([id, m]) => ({ id, name: "P" + id, arrivalDateHour: min(m), departureDateHour: min(m) })),
  nextStation: { id: next, name: "P" + next },
  originStation: { id: paradas[0][0], name: "P" + paradas[0][0] },
  destinationStation: { id: "6", name: "P6" },
  departureDateHourSelectedStation: min(salida),
  platformSelectedStation: "1",
  __apiNow: AHORA,
});

const TRENES = [
  // Salió hace 34 min y está entrando en mi parada: es el que faltaba.
  mkTren({ num: 25716, paradas: [["1", -34], ["2", -20], ["3", -8], ["4", 3], ["5", 12], ["6", 30]], next: "4", salida: 3 }),
  // Todavía parado en mi estación, sale dentro de 11 min.
  mkTren({ num: 25718, paradas: [["4", 11], ["5", 20], ["6", 38]], next: "4", salida: 11 }),
  // En marcha, pasa por mi parada dentro de 27 min.
  mkTren({ num: 25620, paradas: [["1", -10], ["2", 5], ["3", 18], ["4", 27], ["5", 36], ["6", 54]], next: "2", salida: 27 }),
  // En marcha y con +36 de retraso: la hora de horario era 07:51.
  mkTren({ num: 25616, paradas: [["1", -15], ["2", 2], ["3", 20], ["4", 32], ["5", 41], ["6", 59]], next: "2", salida: 32, delay: 36 }),
  // Fantasma: su próxima parada quedó 50 min atrás y el delay es imposible.
  mkTren({ num: 90000, paradas: [["1", -90], ["2", -70], ["3", -50], ["4", -35], ["5", 5]], next: "3", salida: -35, delay: -52 }),
  // Vivo, pero ya pasó por mi parada hace 6 min: no es un fantasma, es pasado.
  mkTren({ num: 90001, paradas: [["1", -40], ["2", -25], ["3", -14], ["4", -6], ["5", 4], ["6", 22]], next: "5", salida: -6 }),
];

mock.module("../src/api.mjs", {
  namedExports: {
    getStations: async () => [{ id: "4", name: "P4", accessible: true, lineas: ["R1"] }],
    getLine: async () => LINEA,
    getDepartures: async () => TRENES,
  },
});

const { getSalidasParada } = await import("../src/stopBoard.mjs");

test("el tablero enseña también los trenes que ya circulan", async () => {
  const r = await getSalidasParada("4");

  // Los cuatro que un viajero puede coger, en orden, y ni uno más.
  assert.deepEqual(r.salidas.map((s) => s.tren), [25716, 25718, 25620, 25616]);
  assert.deepEqual(r.salidas.map((s) => s.hora), ["07:58", "08:06", "08:22", "08:27"]);

  // El de dentro de 3 min está en marcha: es justo el que se perdía.
  assert.equal(r.salidas[0].enMin, 3);
  assert.equal(r.salidas[0].estado, "circulando");

  // Solo el fantasma cuenta como caducado; el que ya pasó sale por ser pasado.
  assert.equal(r.caducados, 1);
});

test("con retraso, la hora que manda es la real y la programada se deduce", async () => {
  const r = await getSalidasParada("4");
  const tarde = r.salidas.find((s) => s.tren === 25616);
  assert.equal(tarde.hora, "08:27");
  assert.equal(tarde.programada, "07:51");
  assert.equal(tarde.delay, 36);
});

test("el sentido se deduce del orden de paradas de la línea", async () => {
  const r = await getSalidasParada("4");
  assert.ok(r.salidas.every((s) => s.sentido?.hacia === "P6"));
  assert.deepEqual(r.sentidos, [{ hacia: "P6", n: 4 }]);
});
