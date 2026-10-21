-- Bot Añelo: números habilitados para CONSULTAR (choferes).
-- La app es cerrada: a un número que no es cargador ni está en esta lista el
-- bot no le responde nada. Se carga desde el panel (Bot Añelo -> Choferes).
create table if not exists public.anelo_consultores (
  telefono    text primary key check (telefono ~ '^\d{10}$'),
  nota        text,
  created_at  timestamptz not null default now()
);
alter table public.anelo_consultores enable row level security;
