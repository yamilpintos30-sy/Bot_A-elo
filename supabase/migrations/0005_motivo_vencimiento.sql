-- Bot Añelo: qué documento vence en la fecha de cada carnet cargado
-- (en los listados de estado, el "motivo de no acceso"). Lo usa la pestaña
-- "No habilitados" del panel para mostrar el porqué.
alter table public.anelo_carnets add column if not exists motivo_vencimiento text;

-- Para listar rápido los vencidos.
create index if not exists anelo_carnets_venc_idx on public.anelo_carnets (vencimiento);
