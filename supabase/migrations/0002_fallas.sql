-- =============================================================================
--  Bot Añelo — fallas críticas (para el panel, sección "Bot Añelo")
--  Ejecutar en el SQL Editor del mismo proyecto de Supabase (tablas anelo_*).
-- =============================================================================

-- Problemas que una persona tiene que revisar. Ejemplo: un comprobante de VTV o
-- seguro cuya patente (pedida, nombre del archivo o contenido) no coincide: el
-- bot NO lo entrega y lo registra acá.
create table if not exists public.anelo_fallas (
  id               bigint generated always as identity primary key,
  tipo             text not null,
  severidad        text not null check (severidad in ('critica', 'advertencia')),
  descripcion      text not null,
  dominio          text,
  conversation_id  text,
  telefono         text,
  detalle          jsonb not null default '{}'::jsonb,
  revisada         boolean not null default false,
  revisada_el      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists anelo_fallas_pendientes_idx on public.anelo_fallas (revisada, created_at desc);

alter table public.anelo_fallas enable row level security;
