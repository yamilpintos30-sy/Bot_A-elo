-- =============================================================================
--  Bot Añelo (SEA WHITE S.A.) — esquema inicial
--  Ejecutar en el SQL Editor del proyecto de Supabase PROPIO de este bot
--  (no en el de Enri). Todas las tablas llevan el prefijo anelo_ para que
--  nunca se confundan con las de Enri (bot_*).
-- =============================================================================

-- --- Conversaciones -----------------------------------------------------------

-- Estado de cada chat de WhatsApp (en qué paso está, qué consultó).
create table if not exists public.anelo_sessions (
  conversation_id  text primary key,
  telefono         text,
  state            text not null,
  context          jsonb not null default '{}'::jsonb,
  history          jsonb not null default '[]'::jsonb,
  handed_off_until timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Todo lo que entra y sale (para el análisis de conversaciones del panel).
create table if not exists public.anelo_messages (
  id               bigint generated always as identity primary key,
  conversation_id  text not null,
  telefono         text,
  direction        text not null check (direction in ('in', 'out')),
  rol              text check (rol in ('cargador', 'consulta')),
  content          text,
  state            text,
  meta             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists anelo_messages_conv_idx on public.anelo_messages (conversation_id, created_at);
create index if not exists anelo_messages_created_idx on public.anelo_messages (created_at);

-- --- Panel: contexto y análisis --------------------------------------------

-- Contexto del bot (editable desde el panel, con historial).
create table if not exists public.anelo_knowledge (
  id          text primary key,
  content     text not null,
  note        text,
  updated_at  timestamptz not null default now()
);

create table if not exists public.anelo_knowledge_versions (
  id           bigint generated always as identity primary key,
  knowledge_id text not null,
  content      text not null,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists anelo_knowledge_versions_idx on public.anelo_knowledge_versions (knowledge_id, created_at desc);

-- Último análisis con IA de las conversaciones, por período ("dias:30").
create table if not exists public.anelo_insights (
  id          text primary key,
  payload     jsonb not null,
  created_at  timestamptz not null default now()
);

-- --- Clientes y plantas -------------------------------------------------------

-- Cliente = el lugar/empresa (Total, Vista, Shell). El código lo define SEA WHITE
-- (6 dígitos) y NO se cambia una vez que tiene cargas: es parte de la clave en
-- la API de Vencimientos Añelo.
create table if not exists public.anelo_clientes (
  id          bigint generated always as identity primary key,
  codigo      text not null unique check (codigo ~ '^\d{6}$'),
  nombre      text not null,
  -- Formas en que la gente lo escribe por WhatsApp ("total", "total austral").
  alias       text[] not null default '{}',
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists anelo_clientes_nombre_idx on public.anelo_clientes (lower(nombre));

-- Subcliente = la planta. El mismo código de planta puede repetirse en clientes distintos.
create table if not exists public.anelo_plantas (
  id          bigint generated always as identity primary key,
  cliente_id  bigint not null references public.anelo_clientes (id) on delete restrict,
  codigo      text not null check (codigo ~ '^\d{6}$'),
  nombre      text not null,
  alias       text[] not null default '{}',
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (cliente_id, codigo)
);
create unique index if not exists anelo_plantas_nombre_idx on public.anelo_plantas (cliente_id, lower(nombre));

-- --- Cargadores -----------------------------------------------------------------

-- Únicos números que pueden SUBIR documentación (se reemplaza al subir el .txt).
-- Teléfono en 10 dígitos nacionales: 2914413200.
create table if not exists public.anelo_cargadores (
  telefono    text primary key check (telefono ~ '^\d{10}$'),
  nota        text,
  created_at  timestamptz not null default now()
);

-- --- Registro de cargas -----------------------------------------------------------

-- Cada PDF que manda un cargador (un "lote").
create table if not exists public.anelo_cargas (
  id               bigint generated always as identity primary key,
  conversation_id  text,
  telefono         text,
  cliente_codigo   text not null,
  planta_codigo    text not null,
  archivo          text,
  estado           text not null check (estado in ('procesando', 'completada', 'con_errores', 'fallida')),
  total            int not null default 0,
  correctos        int not null default 0,
  errores          int not null default 0,
  costo_usd        numeric(10, 4),
  -- Aceptados, rechazados con motivo, respuesta de SEA WHITE y nota del modelo.
  detalle          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create index if not exists anelo_cargas_created_idx on public.anelo_cargas (created_at desc);

-- Cada carnet cargado en SEA WHITE. Misma clave que la API:
-- cliente + planta + DNI/patente. Guarda lo que la API no tiene (el nombre) y el
-- id de SEA WHITE para pedir el PDF del carnet.
create table if not exists public.anelo_carnets (
  id               bigint generated always as identity primary key,
  cliente_codigo   text not null,
  planta_codigo    text not null,
  tipo             text not null check (tipo in ('chofer', 'dominio')),
  identificador    text not null,
  apellido_nombre  text,
  vencimiento      date not null,
  observaciones    text,
  seawhite_id      int,
  carga_id         bigint references public.anelo_cargas (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (cliente_codigo, planta_codigo, tipo, identificador)
);
-- Consulta de un chofer por DNI en todas las plantas.
create index if not exists anelo_carnets_ident_idx on public.anelo_carnets (tipo, identificador);

-- --- Seguridad ------------------------------------------------------------------
-- El bot entra con la service-role key (ignora RLS). RLS activo y sin políticas:
-- la anon key no puede leer ni escribir nada.
alter table public.anelo_sessions           enable row level security;
alter table public.anelo_messages           enable row level security;
alter table public.anelo_knowledge          enable row level security;
alter table public.anelo_knowledge_versions enable row level security;
alter table public.anelo_insights           enable row level security;
alter table public.anelo_clientes           enable row level security;
alter table public.anelo_plantas            enable row level security;
alter table public.anelo_cargadores         enable row level security;
alter table public.anelo_cargas             enable row level security;
alter table public.anelo_carnets            enable row level security;

-- --- Datos iniciales de PRUEBA -------------------------------------------------
-- Códigos 9999xx: nunca se confunden con un cliente real (en SEA WHITE no hay
-- ambiente de prueba; si el ingeniero quiere limpiar, borra todo lo 9999xx).
insert into public.anelo_clientes (codigo, nombre, alias) values
  ('999991', 'TOTAL AUSTRAL', array['total', 'total austral']),
  ('999992', 'VISTA ENERGY',           array['vista', 'vista energy'])
on conflict (codigo) do nothing;

insert into public.anelo_plantas (cliente_id, codigo, nombre, alias)
select c.id, '000001', 'Planta 1', array['p1', 'planta1', '1']
from public.anelo_clientes c
where c.codigo in ('999991', '999992')
on conflict (cliente_id, codigo) do nothing;

insert into public.anelo_cargadores (telefono, nota) values
  ('2914413200', 'Cargador inicial')
on conflict (telefono) do nothing;
