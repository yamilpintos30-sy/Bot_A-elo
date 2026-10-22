-- Bot Añelo: clientes reales y códigos de 4 dígitos.
--
-- 1) Los códigos de cliente y subcliente ahora son de 4 dígitos (0001, 0000):
--    se aceptan sólo números, de cualquier largo, respetando los ceros a la izquierda.
alter table public.anelo_clientes drop constraint if exists anelo_clientes_codigo_check;
alter table public.anelo_clientes add constraint anelo_clientes_codigo_check check (codigo ~ '^\d{1,10}$');
alter table public.anelo_plantas drop constraint if exists anelo_plantas_codigo_check;
alter table public.anelo_plantas add constraint anelo_plantas_codigo_check check (codigo ~ '^\d{1,10}$');

-- 2) Los cinco clientes que se usan por ahora, cada uno con la operadora
--    "OPERADORAS TODAS" (0000), que por el momento abarca a todas.
insert into public.anelo_clientes (codigo, nombre, alias) values
  ('0001', 'HALLIBURTON ARGENTINA SRL',      array['halliburton']),
  ('0002', 'TEKUN SA',                       array['tekun']),
  ('0003', 'CAGSA S A',                      array['cagsa']),
  ('0004', 'HIJOS DE GUILLERMO DUCOS S.A.',  array['hijos de guillermo ducos', 'ducos']),
  ('0005', 'A.C.A',                          array['aca'])
on conflict (codigo) do update
  set nombre = excluded.nombre, alias = excluded.alias, activo = true;

insert into public.anelo_plantas (cliente_id, codigo, nombre, alias)
select c.id, '0000', 'OPERADORAS TODAS', array['operadoras todas', 'todas']
from public.anelo_clientes c
where c.codigo in ('0001', '0002', '0003', '0004', '0005')
on conflict (cliente_id, codigo) do update
  set nombre = excluded.nombre, alias = excluded.alias, activo = true;

-- 3) Los clientes de prueba (9999xx) dejan de aparecer en los menús.
update public.anelo_clientes set activo = false where codigo like '9999%';

notify pgrst, 'reload schema';
