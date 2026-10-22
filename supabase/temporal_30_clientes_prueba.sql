-- TEMPORAL: 30 clientes ficticios para ver la lista de clientes con páginas
-- ([⬅️ Anteriores] 8 clientes [➡️ Ver más]). Códigos 9001-9030.
-- NO confirmar cargas con estos clientes: no existen en SEA WHITE.
-- Para sacarlos, correr el bloque "BORRAR" de abajo.

insert into public.anelo_clientes (codigo, nombre, alias) values
  ('9001', 'PETROLERA AUSTRAL SA',        array['petrolera austral']),
  ('9002', 'TRANSPORTES DEL VALLE SRL',   array['transportes del valle']),
  ('9003', 'NEUQUEN SERVICIOS SA',        array['neuquen servicios']),
  ('9004', 'PATAGONIA OIL SRL',           array['patagonia oil']),
  ('9005', 'LOGISTICA AÑELO SA',          array['logistica anelo']),
  ('9006', 'CUENCA ENERGIA SA',           array['cuenca energia']),
  ('9007', 'VACA MUERTA FLUIDOS SRL',     array['vaca muerta fluidos']),
  ('9008', 'GRUAS DEL SUR SA',            array['gruas del sur']),
  ('9009', 'PERFORACIONES ANDINAS SA',    array['perforaciones andinas']),
  ('9010', 'ARENAS DEL NORTE SRL',        array['arenas del norte']),
  ('9011', 'SERVICIOS PETROLEROS ROCA SA',array['servicios petroleros roca']),
  ('9012', 'COMAHUE TRANSPORTE SRL',      array['comahue transporte']),
  ('9013', 'PUERTO WHITE CARGAS SA',      array['puerto white cargas']),
  ('9014', 'RIO NEGRO LOGISTICA SRL',     array['rio negro logistica']),
  ('9015', 'MESETA EQUIPOS SA',           array['meseta equipos']),
  ('9016', 'SALINAS SERVICIOS SRL',       array['salinas servicios']),
  ('9017', 'CHIHUIDO ENERGIA SA',         array['chihuido energia']),
  ('9018', 'LOMA CAMPANA FLETES SRL',     array['loma campana fletes']),
  ('9019', 'BAHIA BLANCA TRANSPORTES SA', array['bahia blanca transportes']),
  ('9020', 'CENTENARIO OILFIELD SRL',     array['centenario oilfield']),
  ('9021', 'PLOTTIER MONTAJES SA',        array['plottier montajes']),
  ('9022', 'CUTRAL CO SERVICIOS SRL',     array['cutral co servicios']),
  ('9023', 'ZAPALA CAMIONES SA',          array['zapala camiones']),
  ('9024', 'AGUADA PICHANA SRL',          array['aguada pichana']),
  ('9025', 'SIERRA CHATA FLUIDOS SA',     array['sierra chata fluidos']),
  ('9026', 'EL TRAPIAL SERVICIOS SRL',    array['el trapial servicios']),
  ('9027', 'FORTIN DE PIEDRA SA',         array['fortin de piedra']),
  ('9028', 'LA AMARGA CHICA SRL',         array['la amarga chica']),
  ('9029', 'BANDURRIA TRANSPORTES SA',    array['bandurria transportes']),
  ('9030', 'RINCON DE LOS SAUCES SRL',    array['rincon de los sauces'])
on conflict (codigo) do update
  set nombre = excluded.nombre, alias = excluded.alias, activo = true;

insert into public.anelo_plantas (cliente_id, codigo, nombre, alias)
select c.id, '0000', 'OPERADORAS TODAS', array['operadoras todas', 'todas']
from public.anelo_clientes c
where c.codigo between '9001' and '9030'
on conflict (cliente_id, codigo) do update
  set nombre = excluded.nombre, alias = excluded.alias, activo = true;

notify pgrst, 'reload schema';


-- ===================== BORRAR (cuando termines de probar) =====================
-- delete from public.anelo_plantas
--   where cliente_id in (select id from public.anelo_clientes where codigo between '9001' and '9030');
-- delete from public.anelo_clientes where codigo between '9001' and '9030';
-- notify pgrst, 'reload schema';
