// Distancias y normalización de texto, compartidas por el índice GTFS, el
// catálogo de TMB y las "paradas de bus cerca de la estación".

// NFD separa la tilde en marca combinante y \p{M} la quita: así "sant adria"
// encuentra "Sant Adrià" y "macanet" encuentra "Maçanet".
// Estaba duplicada en server.mjs y en index.html; el buscador de bus tiene que
// normalizar EXACTAMENTE igual que el cliente o las búsquedas no cuadran.
export const norm = (s) => (s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const R_TIERRA = 6_371_000; // metros
const rad = (g) => (g * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_TIERRA * Math.asin(Math.sqrt(a));
}

// Caja de recorte alrededor de un punto. Descarta el 99 % de los candidatos con
// dos comparaciones antes de tocar ningún seno.
export function caja(lat, lon, metros) {
  const dLat = metros / 111_320;
  const dLon = metros / (111_320 * Math.max(0.01, Math.cos(rad(lat))));
  return { latMin: lat - dLat, latMax: lat + dLat, lonMin: lon - dLon, lonMax: lon + dLon };
}
