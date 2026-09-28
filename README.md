# Flip Siete

Juego de cartas push-your-luck multijugador en tiempo real. El servidor guarda la
partida completa y a cada jugador solo le manda lo que puede ver, así que nadie
puede espiar el mazo desde la consola del navegador.

- Node 18 o superior
- Una sola dependencia: `ws`
- De 2 a 8 jugadores, más hasta 3 bots para rellenar la mesa

## Probarlo en tu computadora

```bash
npm install
npm start
```

Abre `http://localhost:3000`. Para jugar contigo mismo, abre una segunda ventana
en modo incógnito (cada navegador guarda su propia identidad).

## Publicarlo gratis en Render

1. Sube esta carpeta a un repositorio de GitHub (sin `node_modules`).
2. En [render.com](https://render.com) crea un **Web Service** y conecta el repo.
3. Runtime **Node**, Build Command `npm install`, Start Command `npm start`.
4. Plan **Free**. Render asigna el puerto por la variable `PORT`; el servidor ya
   la lee, no toques nada.
5. Te queda una dirección tipo `https://flip-siete.onrender.com`. Ese es el enlace
   que le pasas a tus amigos.

El plan gratuito de Render duerme el servicio tras 15 minutos sin visitas: la
primera carga después de una pausa tarda unos 40 segundos. Alternativas con el
mismo código y sin cambios: Fly.io, Railway o Koyeb.

## Cómo se juega

- En tu turno pides carta o te plantas. Plantarte guarda los puntos de la ronda.
- Si sale un número que ya tienes, pierdes todo lo de esa ronda.
- Siete números distintos dan +15 y cierran la ronda para todos.
- Las cartas +2 a +10 suman al final; la ×2 duplica solo la suma de los números.
- Congelar planta a alguien de inmediato; Voltear 3 le obliga a robar tres
  cartas seguidas; Segunda oportunidad perdona un repetido.
- Gana quien llegue a 200 al cerrar una ronda.

El porcentaje de "riesgo" que ve cada jugador es la probabilidad real de repetir
con la siguiente carta, calculada con las cartas que quedan. Es información
legítima: en la mesa física todas las cartas están boca arriba.

## Estructura

```
server.js          reglas, salas, bots y WebSocket
public/index.html  cliente completo (sin build, sin dependencias)
```

Si alguien se desconecta a mitad de turno, cualquiera puede plantarlo pasados 30
segundos. Las salas vacías se borran solas a las 3 horas.
