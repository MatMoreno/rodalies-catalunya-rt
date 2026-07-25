/* Utilidades compartidas entre las dos vistas (estado + trenes en vivo).
   Se exponen en window para poder usarse desde los scripts inline de cada página. */
(function (w) {
  "use strict";

  // Colores oficiales aproximados por línea de Rodalies.
  const COLORES = {
    R1: "#79c2ec", R2: "#009640", R2N: "#009640", R2S: "#009640", R3: "#e63027",
    R3A: "#e63027", R4: "#f5a800", R7: "#b4a7d6", R8: "#8f4799", R11: "#0069b4",
    R12: "#8d5b2c", R13: "#e6007e", R14: "#6f2c91", R15: "#94c11f", R16: "#e30613",
    R17: "#f39200", RG1: "#0069b4", RT1: "#00a19a", RT2: "#00a19a",
    RL3: "#7f8c8d", RL4: "#7f8c8d",
  };
  const color = (l) => COLORES[l] || "#5a6572";

  const esc = (s) =>
    (s ?? "").toString().replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Color de texto legible (blanco o tinta) según la luminancia del fondo.
  // Arregla el blanco-sobre-amarillo/lima/celeste de las badges claras.
  function textOn(hex) {
    const h = (hex || "").replace("#", "");
    if (h.length < 6) return "#fff";
    const ch = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
    return L > 0.38 ? "#10202e" : "#fff";
  }

  // Mezcla dos colores hex (t=0 → a, t=1 → b). Para tintar el color de línea.
  function mix(a, b, t) {
    const p = (h) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16));
    const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
    const m = (x, y) => Math.round(x + (y - x) * t);
    return `rgb(${m(r1, r2)}, ${m(g1, g2)}, ${m(b1, b2)})`;
  }
  const tint = (hex, t) => mix(hex, "#ffffff", t);

  // Badge de línea (átomo de marca). size: sm | md | lg
  function bullet(code, size) {
    const c = color(code);
    return `<span class="bullet bullet--${size || "md"}" style="background:${c};color:${textOn(c)}">${esc(code)}</span>`;
  }

  // "hace 5 min" / "hace 2 h" a partir de un timestamp unix (segundos).
  function timeAgo(unixSec) {
    if (!unixSec) return "";
    const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
    if (s < 60) return "hace un momento";
    const m = Math.floor(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    return `hace ${d} ${d === 1 ? "día" : "días"}`;
  }

  // "HH:MM" local a partir de un timestamp unix (segundos).
  function clockAt(unixSec) {
    if (!unixSec) return "";
    return new Date(unixSec * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  w.RR = { COLORES, color, esc, textOn, mix, tint, bullet, timeAgo, clockAt, getJSON };
})(window);
