# Rodalies Catalunya · Estado en tiempo real

Servicio que responde **"¿a qué hora pasa mi tren por mi parada?"** en Catalunya, y
muestra el **estado del servicio e incidencias por línea** de Rodalies (R1–R17, RG1,
RT…) en tiempo real. Sin base de datos, sin build, con dos dependencias: Express y
el descodificador de GTFS-Realtime.

Node ≥ 18 (usa `fetch` nativo). `npm install && npm start` y ya está.

## Qué hay dentro

| Parte | Estado | Fuente |
|---|---|---|
| **Próximos trenes desde tu parada** (`/`) | funcionando | API oficial de Rodalies (GRS) |
| **Estado e incidencias por línea** (`/estado.html`) | funcionando | GTFS-Realtime de Renfe |
| **Trenes en vivo sobre la línea** (`/linea.html`) | funcionando | API oficial de Rodalies (GRS) |
| **Buses: horarios + tiempo real** (`/bus.html`) | terminado, **apagado por defecto** | GTFS de la Generalitat + iBus de TMB |

El **modo bus está entero y probado, pero no se enseña**: le falta un repaso en
navegador, y no tiene sentido que quien clone esto para ver los trenes se baje 25 MB
de horarios de bus. Vive detrás de una bandera: `BUS=1` en el `.env` y aparece el
enlace *Buses* en el menú con todo lo que hay debajo. Apagada, la app no registra
sus rutas, no descarga el feed y no enseña ningún enlace muerto.

Las cuatro fuentes:

1. **Estado / incidencias por línea** → GTFS-Realtime de Renfe (`alerts.pb`, núcleo 51).
2. **Posición de cada tren en vivo** (entre qué paradas está + ETA a la siguiente)
   → **API oficial de Rodalies** `https://serveisgrs.rodalies.gencat.cat/api`
   (la que usa su propia web; sin autenticación; contrato en `/api/v3/api-docs`).
3. **Horarios de bus interurbano** (948 líneas, toda Catalunya) → **GTFS de la
   Generalitat**, sin autenticación. Horario publicado, no tiempo real.
4. **Buses urbanos de Barcelona en tiempo real** → **iBus de TMB**, con claves
   gratuitas *opcionales* (ver [Buses](#buses-interurbanos--tmb)).

## Mapa del código

Un asunto por fichero, sin capas de más. Los de bus solo se usan con `BUS=1`.

| Fichero | De qué se ocupa |
|---|---|
| [`src/server.mjs`](src/server.mjs) | Rutas HTTP y estáticos. Nada de lógica: solo recorta parámetros y delega |
| [`src/api.mjs`](src/api.mjs) | Cliente de la API oficial de Rodalies (GRS) + caché |
| [`src/rodalies.mjs`](src/rodalies.mjs) | GTFS-Realtime de Renfe → incidencias y estado por línea |
| [`src/tren.mjs`](src/tren.mjs) | Cómo se lee UN tren del feed: su próxima parada y si el registro caducó |
| [`src/stopBoard.mjs`](src/stopBoard.mjs) | Salidas de una estación, con el sentido deducido del orden de la línea |
| [`src/liveLine.mjs`](src/liveLine.mjs) | Trenes situados entre paradas para el diagrama de línea |
| [`src/cache.mjs`](src/cache.mjs) | La factoría `cached(ttl)`, compartida por todos los clientes |
| [`src/config.mjs`](src/config.mjs) | Lector de `.env` de diez líneas; exporta valores ya resueltos |
| [`src/tiempo.mjs`](src/tiempo.mjs) | Reloj de la red y día de servicio GTFS. La parte que falla en silencio |
| [`src/geo.mjs`](src/geo.mjs) | Haversine, caja de recorte y normalización de texto |
| [`src/unzip.mjs`](src/unzip.mjs) | Lector ZIP mínimo: infla una entrada a la vez sobre un descriptor |
| [`src/gtfsFeed.mjs`](src/gtfsFeed.mjs) | Descarga del GTFS, caché en disco e intercambio atómico |
| [`src/gtfsIndex.mjs`](src/gtfsIndex.mjs) | Índice en typed arrays y todas las consultas sobre él |
| [`src/tmb.mjs`](src/tmb.mjs) | Cliente de TMB (iBus, paradas, líneas). Sin claves se apaga solo |
| [`src/busBoard.mjs`](src/busBoard.mjs) | Junta las dos redes de bus en una sola forma de respuesta |
| [`public/`](public/) | Cuatro páginas sin framework + `shared.js` + un solo `styles.css` |
| [`test/`](test/) | Pruebas sin red (`npm test`), con la API simulada y un momento fijo |

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
npm test               # pruebas sin red (API simulada), en cualquier zona horaria
```

- `/`             → **próximos trenes desde tu parada** (la vista principal: a qué
  hora pasa cada tren por tu estación y cuántos minutos faltan).
  `?p=79404` abre una parada concreta; la última elegida se recuerda.
- `/estado.html`  → panel de incidencias/estado por línea.
- `/linea.html`   → trenes en vivo sobre el diagrama de la línea.
  - `?l=R2` selecciona línea · `?demo=1` inyecta trenes de prueba (para verla fuera de horario).

No hace falta ninguna credencial para nada de lo anterior.

### Encender los buses

```bash
cp .env.example .env   # y poner BUS=1
npm start
```

Aparece *Buses* en el menú, y con él:

- `/bus.html`     → **próximos buses desde tu parada de bus**, o el **recorrido de
  una línea**. El buscador es el mismo para las dos cosas: escribe *Meridiana* y
  salen paradas, escribe *N82* y sale la línea. Cada fila del tablero se despliega
  para ver el recorrido completo de **ese** autobús.
  `?p=gen:PF08019187` (parada interurbana) · `?p=tmb:1240` (urbana de Barcelona) ·
  `?l=N82` (recorrido de una línea).
- En `/`, al final, las paradas de bus a menos de 400 m de la estación elegida.

La primera vez, el horario de bus (25 MB) se descarga en segundo plano **después**
de que el servidor empiece a escuchar: la parte de trenes responde desde el primer
instante y `/bus.html` enseña un aviso mientras se prepara. Los interurbanos van sin
credenciales; el tiempo real de Barcelona necesita las claves gratuitas de TMB (y sin
ellas todo lo demás sigue funcionando).

## API (proxy local, evita CORS)

- `GET /api/estado` · `GET /api/estado/:linea` · `GET /api/incidencias` — estado/incidencias (`?force=1` salta caché 30 s).
- `GET /api/lineas` — catálogo de líneas para el selector.
- `GET /api/paradas` — catálogo de estaciones (`?q=` filtra por nombre, sin acentos).
- `GET /api/parada/:id/salidas` — próximos trenes de una parada: destino, sentido,
  hora real, hora prevista, minutos restantes, retraso y vía.
  `?linea=R1` · `?sentido=Maçanet-Massanes` · `?limite=N`.
- `GET /api/linea/:id/vivo` — paradas ordenadas + trenes situados entre paradas.
  Separa `trenes` (circulando) de `proximas_salidas` (aún sin salir). `?demo=1` para datos sintéticos.

Bus (**solo con `BUS=1`**; apagado, todas devuelven 404 salvo la primera):

- `GET /api/bus/activo` — `{ activo: true|false }`. Responde siempre: es lo que usa la
  web para enseñar u ocultar el enlace del menú sin dejarlo muerto.
- `GET /api/bus/estado` — si el horario está listo, de cuándo es y hasta cuándo vale.
  Responde al instante incluso mientras se descarga. `?force=1` comprueba si hay versión nueva.
- `GET /api/bus/buscar` — buscador único: devuelve `lineas[]` **y** `paradas[]`, más
  un `coincide` (`"linea"` / `"parada"`) que dice a qué se parece más lo escrito, para
  que la interfaz sepa qué poner primero. Es el que usa la web.
- `GET /api/bus/paradas` — solo paradas. `?q=` por nombre (**filtra en el
  servidor**: son 9.010 paradas, más de 1 MB) · `?lat=&lon=&r=` por cercanía · `?limite=`.
- `GET /api/bus/linea/:codigo` — recorrido de una línea por sentidos, con las horas
  del **próximo paso** poste a poste (`/api/bus/linea/N82`). Cada sentido trae
  `hoy` (pasos en la fecha consultada), `otros_finales` (los servicios parciales) y
  `salida: null` si no queda ningún paso. Las urbanas de TMB responden con
  `sin_horario: true` y el trazado sin horas. `?fecha=&hora=` igual que el tablero.
- `GET /api/bus/viaje/:id` — recorrido de **un autobús concreto**, el de una fila del
  tablero (`/api/bus/viaje/1874197`): de dónde viene, por dónde ha pasado ya
  (`enMin` negativo) y hasta dónde sigue. El id es el `trip_id` del feed, que cada
  salida del tablero trae en su campo `viaje`.
- `GET /api/bus/parada/:id` — ficha de una parada.
- `GET /api/bus/parada/:id/salidas` — próximos buses. `?linea=` · `?destino=` ·
  `?ventana=120` (min) · `?limite=` · `?fecha=20260801&hora=00:10` fuerza el momento
  (la única forma práctica de probar el cambio de día).
- `GET /api/parada/:id/buses` — paradas de bus cerca de una **estación** de Rodalies.
  `?radio=400` (m) · `?limite=6`. Una estación sin coordenadas devuelve lista vacía con 200.

## Cómo hay que leer los datos de la API de Rodalies

Cuatro cosas no evidentes, verificadas contra datos reales (sondeando el mismo tren
varias veces). Saltárselas produce horarios plausibles pero falsos:

1. **`stations[]` es el recorrido COMPLETO, paradas ya servidas incluidas**, así que
   `stations[0]` es la **estación de origen** del tren, no su próxima parada. La
   próxima parada es `nextStation`, buscada dentro del recorrido (`src/tren.mjs`).
   Confundirlas no da una hora ligeramente mala: da un tablero **mutilado**, porque
   la hora del origen ya pasó y el tren entero se toma por un registro muerto. Se
   veía así: de los siete trenes hacia Barcelona que pasan por Arenys de Mar en una
   hora, solo salían los que **aún no habían arrancado** — el que estaba entrando en
   la estación, no.
2. **`stations[].arrivalDateHour` es un ETA EN VIVO, no el horario programado**: ya
   incluye el retraso y se mueve solo entre consultas. La hora *prevista* se obtiene
   restando `delay`, nunca sumándolo (si no, el retraso se cuenta dos veces).
3. **Un tren cuya `nextStation` es su `originStation` todavía no ha salido.** Es una
   salida futura, no un tren en marcha: situarlo entre dos paradas amontona varios
   trenes en el mismo tramo.
4. **El feed arrastra registros caducados**: llevan un `delay` imposible (−50 min) y
   las horas congeladas donde se quedaron. Se reconocen porque la parada que
   *declaran* como próxima quedó muy atrás, o porque su viaje ya terminó — nunca por
   la primera parada del recorrido, que es el error del punto 1. El margen es
   holgado (15 min) a propósito: un ETA que tarda en refrescarse es normal, y pasarse
   de estricto aquí borra trenes que sí existen.

Los dos primeros puntos se comprueban sin red con `npm test`: `test/stopBoard.test.mjs`
monta el caso de Arenys de Mar con la API simulada y espera los cuatro trenes, no uno.

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

## Buses: interurbanos + TMB

> Esta parte viene **apagada**: `BUS=1` en el `.env` para encenderla. Lo que sigue
> describe lo que hay detrás de la bandera.

### Sin claves, la mitad interurbana está completa

Los **interurbanos de la Generalitat** (948 líneas, toda Catalunya, incluidas las
metropolitanas AMB: `e3`, `e9`, `201`, `320`, `620`, `A4`…) no necesitan ninguna
credencial. Se descargan de
[analisi.transparenciacatalunya.cat](https://analisi.transparenciacatalunya.cat/Transport/Transport-de-viatgers-per-carretera-GTFS/bca2-b4i3)
una vez cada 7 días, se guardan en `data/gtfs/` (ignorado por git) y se indexan en
memoria al arrancar (~600 ms, unos 13 MB de índice).

Los **urbanos de Barcelona** (tiempo real de iBus) sí necesitan claves gratuitas de
[developer.tmb.cat](https://developer.tmb.cat). Se copia `.env.example` a `.env` y se
rellenan `TMB_APP_ID` / `TMB_APP_KEY`. **Sin ellas nada se rompe**: como el propio
catálogo de paradas de TMB está tras clave, simplemente no aparece ninguna parada
`tmb:` y el buscador, los tableros y las paradas cercanas siguen enteros. Si TMB
falla o tarda, el tablero degrada a "sin datos en tiempo real" y sigue dando el
horario; nunca devuelve un 5xx por eso. El motivo se ve en `fuentes.tmb.motivo`.

### Cosas del feed GTFS que no se pueden ignorar

Comprobadas contra el fichero real; saltárselas produce tableros plausibles y falsos:

- **`calendar.txt` tiene todos los días a 0**: hoy el servicio sale entero de las
  46.917 altas de `calendar_dates.txt`. Aun así se implementa el calendario
  **según la especificación** (máscara semanal ∧ rango, luego altas y bajas): si la
  Generalitat publica algún día el `calendar.txt` de verdad, el atajo dejaría el
  tablero vacío en silencio.
- **`prohibition` no es un booleano**: toma 0, 3, 4, 5, 6, 7, 8 y 9, y el valor
  mayoritario es `3` (338.102 de 469.853 filas). Filtrar por "truthy" borraría el
  79 % del tablero. Se ignora por completo.
- **`trip_headsign` está vacío en los 29.721 viajes**: el destino se deduce de la
  **última parada** del viaje (y `stop_sequence` empieza en 0, así que "última" es
  el máximo por viaje, nunca un número fijo).
- **El código público de la línea va entre paréntesis en `route_long_name`**
  (`"(L63) Barcelona (F.Macià)-el Palau"`); `route_short_name` es interno (`L1081`).
- **1.013 pasos con hora ≥ 24:00:00**: la madrugada pertenece al día de servicio
  anterior, así que cada consulta mira **dos días** (hoy y ayer, estos desplazados
  +86400). El límite superior de la ventana puede pasar de 86400 y no se recorta: si
  no, una ventana de 2 h a las 23:30 perdería la madrugada entera.
- La cabecera de `stop_times.txt` trae columnas extra y con **espacios delante**
  (`" stop_sequence"`): hay que hacer `trim()` a los nombres de columna.
- **El feed caduca el 31/12/2026.** Cuando pase, el tablero enseña una banda que lo
  dice, en vez de quedarse vacío para siempre sin explicación.

### Por qué el bus NO agrupa por sentido y el tren sí

En este feed una parada es un **poste físico** (`PF08019187`) y cada sentido de la
calzada tiene el suyo, con su propio código: las salidas de una parada ya son casi
siempre de un solo sentido. Una estación de tren, en cambio, sirve los dos sentidos
desde un único id, y por eso el panel de tren tiene que deducir el `sentido`.

Aquí lo que manda es la **línea**: lista plana cronológica, y encima una tira con la
próxima salida de cada línea (buscas tu bullet y lees un número). Los chips de
destino aparecen solo con una línea elegida, que es cuando el concepto aplica
(servicios parciales, el mismo problema del R1 a Calella / Blanes / Maçanet).
El campo `sentidos` **no se emite**: no se manda un campo que este caso no puede
rellenar con honestidad.

El selector de líneas ofrece **todas las de la parada**, no solo las que pasan
dentro de la ventana: en la av. Meridiana son 28 y a las 02:00 solo circulan 7
nocturnas. Las otras 21 salen apagadas pero se pueden elegir, porque "¿a qué hora
vuelve a pasar la 320?" es exactamente la pregunta que se hace a esa hora — y la
respuesta está a un toque de *Mirar todo el día*. Las líneas que **terminan** en la
parada no se ofrecen: hay 38 postes en Catalunya donde los buses solo llegan
(rda. Sant Pere es el de los nocturnos) y anunciar una línea a la que nunca te
puedes subir es peor que no decir nada. Esos postes lo dicen en claro.

### Buscar una línea, no una parada

A veces la pregunta no es "¿qué pasa por aquí?" sino "¿por dónde pasa la N82?", y un
buscador de paradas no la puede contestar. El buscador devuelve las dos cosas y
ordena según lo que se haya escrito: si se parece a un **código** de línea (`n82`,
`h12`, `e9`) las líneas van delante; si parece un **sitio** (`meridiana`, `sants`) van
delante las paradas y las líneas quedan como añadido, recortadas a tres. Así no hay
que elegir modo antes de saber qué se está buscando.

La vista de línea enseña cada sentido con el recorrido del **próximo paso** —el bus
que vas a coger, con su hora en cada poste— y cada poste lleva a su tablero. Si no
queda ningún paso, se enseña el trazado más completo del sentido, sin horas: no se
inventa una hora que hoy no existe.

Y cada fila del tablero se despliega para ver **ese autobús**, que es otra pregunta
distinta: la línea tiene dos sentidos y servicios parciales, pero el bus que viene
hace uno solo. Se ve de dónde salió, las paradas que ya dejó atrás (apagadas), la
tuya marcada y hasta dónde sigue. El id es el `trip_id` del feed guardado en un
`Int32Array` (los 29.721 son numéricos y el mayor es 1.926.297: 119 KB y ni una
cadena). El índice interno del viaje no serviría: cambia en cada reconstrucción, y
un enlace viejo acabaría enseñando **otro** autobús, que es peor que un 404.

Tres cosas que hubo que resolver ahí:

- **El orden de las paradas no está en el índice.** `stop_sequence` se tiró a
  propósito (470.000 enteros para responder una pregunta que ya cabe en un bit). Se
  recupera de las **horas**: dentro de un viaje son monótonas crecientes —para eso
  GTFS escribe "25:10" en vez de "01:10"—, así que ordenar sus pasos por hora
  reconstruye el trazado sin guardar nada más.
- **Agrupar por destino partía la N82 en cinco.** Los servicios que acaban antes no
  son otro sentido. Se agrupa por `direction_id` —que no vale nada comparando líneas
  distintas, pero dentro de una línea es exactamente lo que la especificación dice
  que es— y los destinos parciales se enumeran aparte, contados. Cuesta 30 KB.
- **La clave de grupo lleva también la ruta**, porque 30 códigos públicos comparten
  varios `route_id` y son recorridos distintos de verdad: con "e9" se llaman tanto
  Barcelona–Caldes como Barcelona–Santa Maria d'Oló. Juntos daban un itinerario de
  61 paradas que arrancaba en un pueblo que no venía a cuento.

Para pedir el recorrido de una línea urbana, TMB quiere el `CODI_LINIA` (`212`), no el
código público (`H12`): con el público responde 404 y con `ID_LINIA` responde 200 con
cero paradas, que es peor.

### Identidad de parada y mezcla de los dos catálogos

Los ids van prefijados: **`gen:PF08019187`** (interurbano) y **`tmb:1240`** (TMB).
Se parte por el *primer* `:`; un id sin prefijo se entiende como `gen:`. Un prefijo
desconocido da 404, no 502.

En Barcelona los dos catálogos listan el mismo poste. Si coinciden en sitio (≤30 m) y
comparten alguna palabra del nombre, se conserva **el interurbano**, porque su id
resuelve las dos redes: el tablero de una parada `gen:` busca su poste hermano de TMB
y añade los minutos en vivo, y al revés también. TMB, en cambio, **no publica qué
líneas paran en cada poste** (solo se sabe en vivo, cuando viene un bus), así que
quedarse con el id `tmb:` dejaba las filas del buscador sin un solo bullet. Las
paradas que solo existen en TMB conservan su id y su tablero en vivo, y donde no se
conocen las líneas se dice "en vivo" en lugar de fingir una lista.

## Notas de implementación

- El código de línea sale del sufijo del `routeId`: `51T0221R4` → `R4`.
- GTFS-RT codifica "sin fin previsto" como `end = 0`; se trata como abierto (vigente).
- El feed a veces etiqueta el catalán como idioma `es`; se muestran ambos textos deduplicados.
- Caché en memoria de 30 s para no martillear el feed de Renfe.
- **Nunca se le pregunta el día a la máquina**: la fecha de servicio del GTFS sale de
  un `Intl.DateTimeFormat` en `Europe/Madrid` (con `hourCycle:"h23"`, no
  `hour12:false`, que en algunas versiones de ICU devuelve "24" a medianoche). Se
  verificó con `TZ=UTC`, `Pacific/Auckland` y `America/Los_Angeles`: mismo tablero.
- El ZIP se lee con un descifrador propio de ~90 líneas (`src/unzip.mjs`) que infla
  una entrada a la vez sobre un descriptor de fichero. `fflate` exigiría los 25,7 MB
  en memoria y devolvería *todas* las entradas, incluido `shapes.txt` (77 MB, que
  aquí no se toca ni comprimido).
- `stop_times.txt` (23,7 MB) **nunca se convierte en string**: se escanea el Buffer y
  las horas se parsean de los dígitos. El índice queda en typed arrays (9 bytes por
  paso) y el RSS del proceso se queda en ~50-60 MB.
