-- Bot Añelo: estados para las cargas que no llegaron a SEA WHITE.
--   cancelada:     tocó Cancelar o cerró la conversación con la carga pendiente.
--   sin_confirmar: nunca confirmó (expiró la hora, o el bot se reinició en el medio).
-- Antes esas cargas quedaban para siempre en "procesando".
alter table public.anelo_cargas drop constraint if exists anelo_cargas_estado_check;
alter table public.anelo_cargas add constraint anelo_cargas_estado_check
  check (estado in ('procesando', 'completada', 'con_errores', 'fallida', 'cancelada', 'sin_confirmar'));

-- Las que ya quedaron colgadas (más de 2 horas en "procesando").
update public.anelo_cargas
   set estado = 'sin_confirmar', finished_at = now()
 where estado = 'procesando'
   and created_at < now() - interval '2 hours';
