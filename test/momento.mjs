// El momento fijo de los fixtures, escrito en la MISMA convención que la API de
// Rodalies: hora de pared de Barcelona y sin zona horaria ("2026-07-27T07:55:00").
//
// Aquí estaba el motivo de que las pruebas solo pasaran en una máquina en UTC.
// `Date.parse` de una fecha sin zona la lee en hora LOCAL, y `toISOString()` la
// vuelve a escribir en UTC: las dos convenciones mezcladas en la misma línea. En
// Madrid en julio eso desplaza cada hora del fixture dos horas, así que el tren
// que llega "dentro de 3 min" entraba en el código como uno que pasó hace 117 y
// se descartaba por caducado. Ocho de doce pruebas fallaban por eso, en Madrid,
// en Los Ángeles y en Tokio; en UTC pasaban las doce.
//
// Se formatea a mano en hora local para no volver a juntarlas, y así el fixture
// dice lo mismo que dice el feed de verdad.
export const MOMENTO = "2026-07-27T07:55:00";
export const t0 = Date.parse(MOMENTO);

const dos = (n) => String(n).padStart(2, "0");

// Minutos desde MOMENTO -> hora de pared, como la publica la API.
export const min = (m) => {
  const d = new Date(t0 + m * 60_000);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}` +
         `T${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
};
