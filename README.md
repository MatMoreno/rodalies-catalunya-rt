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
| Catálogo de estaciones (202) con sus líneas | GRS `/stations` | ✅ siempre |
| Salidas de una estación: destino, hora, vía, retraso | GRS `/departures` | ✅ solo en horario de servicio (~05:00–00:30) |
| Trenes circulando: próxima parada, retraso, ETA | GRS `/departures`, `/trains/{id}` | ✅ solo en horario de servicio (~05:00–00:30) |

> El GTFS-RT de Renfe **no** publica posiciones de Rodalies (solo Madrid/Murcia…).
> Las posiciones salen de la API de la Generalitat (`serveisgrs`), que es en vivo:
> fuera de horario devuelve listas vacías o `500 "Dades no disponibles"`.

## Uso

```bash
npm install
npm start              # http://localhost:3020  (PORT para cambiarlo)
```

- `/`             → **próximos trenes desde tu parada** (la vista principal: a qué
  hora pasa cada tren por tu estación y cuántos minutos faltan).
  `?p=79404` abre una parada concreta; la última elegida se recuerda.
- `/estado.html`  → panel de incidencias/estado por línea.
- `/linea.html`   → trenes en vivo sobre el diagrama de la línea.
  - `?l=R2` selecciona línea · `?demo=1` inyecta trenes de prueba (para verla fuera de horario).

## API (proxy local, evita CORS)

- `GET /api/estado` · `GET /api/estado/:linea` · `GET /api/incidencias` — estado/incidencias (`?force=1` salta caché 30 s).
- `GET /api/lineas` — catálogo de líneas para el selector.
- `GET /api/paradas` — catálogo de estaciones (`?q=` filtra por nombre, sin acentos).
- `GET /api/parada/:id/salidas` — próximos trenes de una parada: destino, sentido,
  hora real, hora prevista, minutos restantes, retraso y vía.
  `?linea=R1` · `?sentido=Maçanet-Massanes` · `?limite=N`.
- `GET /api/linea/:id/vivo` — paradas ordenadas + trenes situados entre paradas.
  Separa `trenes` (circulando) de `proximas_salidas` (aún sin salir). `?demo=1` para datos sintéticos.

## Cómo hay que leer los datos de la API de Rodalies

Tres cosas no evidentes, verificadas contra datos reales (sondeando el mismo tren
varias veces). Saltárselas produce horarios plausibles pero falsos:

1. **`stations[].arrivalDateHour` es un ETA EN VIVO, no el horario programado**: ya
   incluye el retraso y se mueve solo entre consultas. La hora *prevista* se obtiene
   restando `delay`, nunca sumándolo (si no, el retraso se cuenta dos veces).
2. **Un tren cuya `nextStation` es su `originStation` todavía no ha salido.** Es una
   salida futura, no un tren en marcha: situarlo entre dos paradas amontona varios
   trenes en el mismo tramo.
3. **El feed arrastra registros caducados**: su próxima parada quedó muy atrás y
   llevan un `delay` imposible (−50 min). Se descartan.

Además, las horas vienen **en hora de Barcelona y sin zona horaria**, así que el reloj
que se muestra sale de `requestedAt` de la API, no del servidor.

## Por qué el panel de parada separa los dos sentidos

Una línea presta **servicios parciales**: en R1 hacia el norte unos trenes acaban en
Calella, otros en Blanes y otros en Maçanet-Massanes. Listados juntos, el viajero
necesita saberse el orden de las 31 paradas para deducir que un tren a Calella no le
sirve para ir a Barcelona.

Por eso cada salida lleva un `sentido`, deducido comparando la posición del destino
con la de tu parada en el orden de la línea, y etiquetado con el **extremo de la
línea** (como la señalética). La lista se agrupa por sentido y cada fila declara su
**destino real**, que puede ser un punto intermedio de ese sentido.

## Notas de implementación

- El código de línea sale del sufijo del `routeId`: `51T0221R4` → `R4`.
- GTFS-RT codifica "sin fin previsto" como `end = 0`; se trata como abierto (vigente).
- El feed a veces etiqueta el catalán como idioma `es`; se muestran ambos textos deduplicados.
- Caché en memoria de 30 s para no martillear el feed de Renfe.
