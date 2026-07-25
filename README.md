# Rodalies Catalunya · Estado en tiempo real

Servicio que muestra el **estado del servicio e incidencias por línea** de Rodalies
de Catalunya (R1–R17, RG1, RT…) en tiempo real, a partir del feed **GTFS-Realtime
de Renfe** (`https://gtfsrt.renfe.com/alerts.pb`, núcleo `51`).

Dos fuentes, dos vistas:

1. **Estado / incidencias por línea** → GTFS-Realtime de Renfe (`alerts.pb`, núcleo 51).
2. **Posición de cada tren en vivo** (entre qué paradas está + ETA a la siguiente)
   → **API oficial de Rodalies** `https://serveisgrs.rodalies.gencat.cat/api`
   (la que usa su propia web; sin autenticación; contrato en `/api/v3/api-docs`).

## Qué da cada fuente (verificado en vivo)

| Dato | Fuente | Disponible |
|---|---|---|
| Incidencias / estado por línea (ca+es) | Renfe `alerts.pb` | ✅ siempre |
| Paradas ordenadas de cada línea | GRS `/lines/{id}` | ✅ siempre |
| Trenes circulando: próxima parada, retraso, ETA | GRS `/departures`, `/trains/{id}` | ✅ solo en horario de servicio (~05:00–00:30) |

> El GTFS-RT de Renfe **no** publica posiciones de Rodalies (solo Madrid/Murcia…).
> Las posiciones salen de la API de la Generalitat (`serveisgrs`), que es en vivo:
> fuera de horario devuelve listas vacías o `500 "Dades no disponibles"`.

## Uso

```bash
npm install
npm start              # http://localhost:3020  (PORT para cambiarlo)
```

- `/`            → panel de incidencias/estado por línea.
- `/linea.html`  → **trenes en vivo sobre el diagrama de la línea**.
  - `?l=R2` selecciona línea · `?demo=1` inyecta trenes de prueba (para verla fuera de horario).

## API (proxy local, evita CORS)

- `GET /api/estado` · `GET /api/estado/:linea` · `GET /api/incidencias` — estado/incidencias (`?force=1` salta caché 30 s).
- `GET /api/lineas` — catálogo de líneas para el selector.
- `GET /api/linea/:id/vivo` — paradas ordenadas + trenes situados entre paradas, con `nextStation`, `delay` y ETA. `?demo=1` para datos sintéticos.

## Notas de implementación

- El código de línea sale del sufijo del `routeId`: `51T0221R4` → `R4`.
- GTFS-RT codifica "sin fin previsto" como `end = 0`; se trata como abierto (vigente).
- El feed a veces etiqueta el catalán como idioma `es`; se muestran ambos textos deduplicados.
- Caché en memoria de 30 s para no martillear el feed de Renfe.
