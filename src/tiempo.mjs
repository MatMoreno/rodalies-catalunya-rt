// Reloj de la red y aritmética de días de servicio del GTFS.
//
// Va aparte porque es la parte que falla en silencio: un tablero al que le
// falta la madrugada, o que va una hora desplazado, parece perfectamente
// correcto. Aislado se puede probar solo, sin levantar nada.
//
// Regla: NUNCA se le pregunta el día a la máquina. El servidor puede correr en
// UTC (el repo ya se verificó así) o en cualquier otra zona; la fecha de
// servicio del GTFS es siempre la de Madrid.

import { TZ_RED } from "./config.mjs";

// hourCycle:"h23" y NO hour12:false: con hour12:false algunas versiones de ICU
// devuelven "24" a medianoche y el cálculo se va un día entero.
const RELOJ = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ_RED,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

// -> { ymd: 20260725, seg: 70920, hhmm: "19:42" }
export function ahoraRed(d = new Date()) {
  const p = {};
  for (const { type, value } of RELOJ.formatToParts(d)) p[type] = value;
  return {
    ymd: Number(p.year + p.month + p.day),
    seg: +p.hour * 3600 + +p.minute * 60 + +p.second,
    hhmm: `${p.hour}:${p.minute}`,
  };
}

// Suma (o resta) días a un YYYYMMDD numérico.
// Restar 1 al número NO vale: 20260801 - 1 = 20260800, que no existe. Se pasa
// por una fecha UTC, que no tiene cambios de hora ni meses de longitud variable.
export function ymdSuma(ymd, dias) {
  const y = (ymd / 10000) | 0, m = ((ymd / 100) | 0) % 100, d = ymd % 100;
  const t = new Date(Date.UTC(y, m - 1, d) + dias * 86_400_000);
  return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
}

// 0 = domingo … 6 = sábado, que es el orden de las columnas de calendar.txt
// desplazado. Se calcula en UTC para que no lo toque ningún cambio de hora.
export function diaSemana(ymd) {
  const y = (ymd / 10000) | 0, m = ((ymd / 100) | 0) % 100, d = ymd % 100;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// 92400 -> "01:40". Se muestra la hora de reloj, no la del día de servicio:
// nadie espera leer "25:40" en un panel.
export function hhmmDeSeg(seg) {
  const t = ((seg % 86400) + 86400) % 86400;
  return String((t / 3600) | 0).padStart(2, "0") + ":" +
         String(((t / 60) | 0) % 60).padStart(2, "0");
}

// "20260725" -> "25/07/2026", para los avisos de vigencia.
export function ymdBonito(ymd) {
  const s = String(ymd);
  return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
}

// "00:10" o "0010" -> segundos desde medianoche. Para la palanca de depuración
// ?hora=, que es la única forma práctica de probar el salto de día.
export function segDeHora(txt) {
  const m = /^(\d{1,2}):?(\d{2})(?::(\d{2}))?$/.exec(String(txt).trim());
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + (+m[3] || 0);
}
