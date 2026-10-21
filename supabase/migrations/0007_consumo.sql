-- Bot Añelo: consumo de Claude (pestaña "Costos" del panel).
-- Una fila por llamada: qué función, qué modelo respondió y los tokens. El panel
-- lo pasa a dólares con las tarifas oficiales.
create table if not exists public.anelo_consumo (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  funcion       text not null,
  modelo        text not null,
  entrada       bigint not null default 0,   -- tokens de entrada sin caché
  escritura_5m  bigint not null default 0,   -- escritura en caché (5 minutos)
  escritura_1h  bigint not null default 0,   -- escritura en caché (1 hora)
  lectura       bigint not null default 0,   -- lectura de caché
  salida        bigint not null default 0,   -- tokens generados
  sandbox       int    not null default 0    -- ejecuciones de código (separar carnets)
);
create index if not exists anelo_consumo_fecha_idx on public.anelo_consumo (created_at);
alter table public.anelo_consumo enable row level security;

-- Resumen por día (hora de Argentina), función y modelo: el panel lee pocas filas.
create or replace view public.anelo_consumo_diario with (security_invoker = true) as
select
  (created_at at time zone 'America/Argentina/Buenos_Aires')::date as fecha,
  funcion,
  modelo,
  count(*)          as llamadas,
  sum(entrada)      as entrada,
  sum(escritura_5m) as escritura_5m,
  sum(escritura_1h) as escritura_1h,
  sum(lectura)      as lectura,
  sum(salida)       as salida,
  sum(sandbox)      as sandbox
from public.anelo_consumo
group by 1, 2, 3;
revoke all on public.anelo_consumo_diario from anon, authenticated;
