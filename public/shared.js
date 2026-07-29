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

  /* ------------------------------------------------------------------ bus */

  // Las líneas de bus son ~950 códigos: el mapa COLORES no puede cubrirlas, y
  // tampoco tendría sentido (nadie reconoce 950 colores).
  //
  // La distinción de MODO va en la FORMA, no en el color: el bullet de bus es
  // un óvalo completo, que además es lo que parece la señalética de autobús.
  // Así el color queda libre para ser arbitrario sin que se confunda nunca con
  // una línea de Rodalies, y el rojo de marca sigue reservado.
  //
  // Todos estos tonos están por DEBAJO del umbral de luminancia de textOn(), o
  // sea que el bullet de bus siempre sale en blanco sobre medio-oscuro. No es
  // un apaño del contraste: el tratamiento uniforme refuerza "esto es el bus",
  // mientras la paleta variada del tren conserva su carácter.
  const PALETA_BUS = [
    "#3d6b8e", "#2f7d6a", "#7a6aa8", "#8a6a3d", "#4d7a3d", "#8a4f6b", "#3f6f7f",
    "#6b5f8a", "#7f6a4a", "#4a6b5a", "#7a5a5a", "#5a6f8a", "#2e6f5e", "#6f4f7a",
  ];

  // FNV-1a de 32 bits: determinista y estable entre sesiones y entre páginas,
  // que es lo único que importa aquí (la misma línea, siempre el mismo color).
  function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  // Si la fuente publica un color oficial (TMB lo hace: COLOR_LINIA), manda ese.
  const colorBus = (code, oficial) =>
    oficial || PALETA_BUS[hash32(String(code || "").toUpperCase()) % PALETA_BUS.length];

  function bulletBus(code, size, oficial, oficialTexto) {
    const c = colorBus(code, oficial);
    const txt = oficialTexto || textOn(c);
    // Hay 25 códigos con espacio ("471 495") y otros como "C3Connect": el óvalo
    // crece, pero a partir de 5 caracteres la letra baja para que no reviente
    // la fila.
    const largo = String(code || "").length > 5 ? " bullet--largo" : "";
    return `<span class="bullet bullet--bus bullet--${size || "md"}${largo}" ` +
           `style="background:${c};color:${txt}">${esc(code)}</span>`;
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

  /* ------------------------------------------------ ¿está el modo bus encendido?

     El modo bus se enciende en el servidor (BUS=1), así que la web tiene que
     preguntarlo: el enlace del menú viene oculto en el HTML y solo se enseña si
     hay algo detrás. Preferimos eso a un enlace que lleva a una pantalla que no
     puede cargar nada.

     Una sola petición por página, compartida por quien la necesite (el menú y el
     bloque de buses cercanos del panel de tren). Si falla, se decide que no. */
  const bus = fetch("/api/bus/activo")
    .then((r) => (r.ok ? r.json() : { activo: false }))
    .then((j) => !!j.activo)
    .catch(() => false);

  bus.then((activo) => {
    if (!activo) return;
    document.querySelectorAll("[data-bus]").forEach((el) => el.removeAttribute("hidden"));
  });

  w.RR = { COLORES, color, esc, textOn, mix, tint, bullet, timeAgo, clockAt, getJSON,
           PALETA_BUS, colorBus, bulletBus, bus };
})(window);
