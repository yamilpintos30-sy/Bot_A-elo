-- Bot Añelo: números de LOGÍSTICA (tercer grupo).
-- Consultan con otro menú: individual (por DNI, nombre o dominio) y listados
-- grupales en PDF de los choferes o dominios habilitados de un cliente.
-- Se carga desde el panel (Bot Añelo -> Logística), igual que la de choferes.
-- Si un número está en esta lista y en la de choferes, ve el menú de logística.
create table if not exists public.anelo_logistica (
  telefono    text primary key check (telefono ~ '^\d{10}$'),
  nota        text,
  created_at  timestamptz not null default now()
);
alter table public.anelo_logistica enable row level security;

notify pgrst, 'reload schema';
