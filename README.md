# Recordatorious Bot (MVP Free)

Este proyecto es un bot de Telegram que te permite guardar y recuperar datos simples como números de teléfono, contraseñas de candados o matrículas de coches usando una sintaxis muy sencilla. Es una versión **MVP Free** sin límites ni funciones de pago.

## Cómo funciona

- **Guardar datos**: envía un mensaje al bot empezando con `#` seguido de la clave, un guion `-` y el valor.
  
  Ejemplo:
  ```
  #matrícula coche - 1234ABC
  #tel papá - 612345678
  #wifi casa - PepeWifi / clave123
  ```
- **Consultar datos**: envía un mensaje empezando con `?` y la clave (o parte de la clave). Se realizará una búsqueda por coincidencia parcial.
  
  Ejemplo:
  ```
  ?matrícula coche
  ?tel
  ```
- **Eliminar datos**: envía un mensaje empezando con `-` y la clave.
  
  Ejemplo:
  ```
  -matrícula coche
  ```
- **Plantillas de ejemplo**: al enviar `/start` el bot responderá con ejemplos listos para copiar y pegar.

## Instalación

1. Clona o descarga este repositorio.
2. Instala las dependencias con npm:
   ```bash
   npm install
   ```
3. Copia el fichero `.env.example` a `.env` y completa los valores:
   - `BOT_TOKEN`: el token de tu bot de Telegram (lo obtienes de BotFather).
   - `SUPABASE_URL` y `SUPABASE_ANON_KEY`: los datos de tu proyecto de Supabase.
4. (Opcional) Crea la tabla `records` en tu base de datos de Supabase ejecutando la siguiente SQL:
   ```sql
   create table if not exists records (
     id        uuid primary key default uuid_generate_v4(),
     user_id   bigint not null,
     key_norm  text not null,
     key_text  text not null,
     value     text not null,
     created_at timestamptz not null default now(),
     unique (user_id, key_norm)
   );
   -- índice para búsquedas por key_norm
   create index if not exists records_key_norm_idx on records (user_id, key_norm);
   ```
5. Inicia el bot:
   ```bash
   npm start
   ```

## Notas

- Este bot utiliza Supabase como base de datos. Debes crear un proyecto en [Supabase](https://supabase.com) y obtener la URL y la `anon key` para que funcione.
- Para simplificar el despliegue, el bot utiliza pooling en lugar de webhooks. Si lo despliegas en un entorno en la nube con HTTPS y dominio, puedes utilizar webhooks para mayor eficiencia.
- Actualmente no se implementa cifrado ni funciones de pago; estas se añadirán en versiones futuras.

## Licencia

MIT
