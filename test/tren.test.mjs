// Cómo se lee un tren del feed. Son casos sintéticos, pero calcados de lo que
// enseñaba el tablero de Arenys de Mar el 27/07 a las 07:55: de siete trenes
// hacia Barcelona solo salían los tres que aún no habían arrancado.
//
//   node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { proximaParada, registroCaducado } from "../src/tren.mjs";

const AHORA = Date.parse("2026-07-27T07:55:00");
const min = (m) => new Date(AHORA + m * 60_000).toISOString().slice(0, 19);

// Recorrido completo: paradas ya servidas incluidas, que es como viene de la API.
const tren = ({ paradas, next }) => ({
  stations: paradas.map(([id, m]) => ({ id, name: "P" + id, arrivalDateHour: min(m) })),
  nextStation: next != null ? { id: next, name: "P" + next } : null,
  originStation: { id: paradas[0][0] },
});

// El 25716: salió de Blanes hace 34 min y entra en Arenys dentro de 3.
const enMarcha = tren({
  paradas: [["1", -34], ["2", -20], ["3", -8], ["4", 3], ["5", 12], ["6", 30]],
  next: "4",
});

// El 25718: todavía parado en su estación de origen, sale dentro de 11 min.
const sinSalir = tren({
  paradas: [["4", 11], ["5", 20], ["6", 38]],
  next: "4",
});

test("la próxima parada es la que declara la API, no la primera del recorrido", () => {
  assert.equal(proximaParada(enMarcha, AHORA).id, "4");
  assert.equal(proximaParada(sinSalir, AHORA).id, "4");
});

test("un tren en marcha no es un registro caducado", () => {
  // Esta es la regresión: su stations[0] pasó hace 34 min, y eso lo borraba.
  assert.equal(registroCaducado(enMarcha, AHORA), false);
  assert.equal(registroCaducado(sinSalir, AHORA), false);
});

test("un fantasma congelado sí se descarta", () => {
  // Próxima parada declarada 50 min atrás: el registro dejó de refrescarse.
  const fantasma = tren({
    paradas: [["1", -90], ["2", -70], ["3", -50], ["4", -35], ["5", 5]],
    next: "3",
  });
  assert.equal(registroCaducado(fantasma, AHORA), true);
});

test("un viaje que ya terminó se descarta", () => {
  const terminado = tren({
    paradas: [["1", -60], ["2", -40], ["3", -20]],
    next: null,
  });
  assert.equal(registroCaducado(terminado, AHORA), true);
});

test("un ETA que tarda en refrescarse no borra el tren", () => {
  // La próxima parada figura 6 min atrás porque el tren va tarde y el ETA no se
  // ha movido: sigue circulando, y el margen es holgado a propósito.
  const rezagado = tren({
    paradas: [["1", -40], ["2", -6], ["3", 9], ["4", 25]],
    next: "2",
  });
  assert.equal(registroCaducado(rezagado, AHORA), false);
});

test("sin nextStation, la próxima parada es la primera cuya hora no ha pasado", () => {
  const sinNext = tren({
    paradas: [["1", -34], ["2", -20], ["3", 3], ["4", 12]],
    next: null,
  });
  assert.equal(proximaParada(sinNext, AHORA).id, "3");
  assert.equal(registroCaducado(sinNext, AHORA), false);
});

test("un tren sin recorrido no se da por caducado", () => {
  assert.equal(registroCaducado({ stations: [] }, AHORA), false);
  assert.equal(proximaParada({ stations: [] }, AHORA), null);
});
