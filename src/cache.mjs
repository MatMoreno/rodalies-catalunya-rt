// Caché en memoria con TTL, compartida por los clientes de API (Rodalies, TMB)
// y por las consultas derivadas (paradas cercanas).

export function cached(ttlMs) {
  const store = new Map(); // key -> { at, val }
  return async (key, producer) => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.val;
    const val = await producer();
    store.set(key, { at: Date.now(), val });
    return val;
  };
}
