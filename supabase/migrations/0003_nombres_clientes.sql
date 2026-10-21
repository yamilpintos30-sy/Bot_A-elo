-- Bot Añelo: nombres de los clientes de prueba sin "(PRUEBA)".
-- Solo cambia el nombre que se muestra; los códigos (999991, 999992) siguen
-- siendo los de prueba, así que el modo prueba los sigue reconociendo.
update public.anelo_clientes set nombre = 'TOTAL AUSTRAL' where codigo = '999991';
update public.anelo_clientes set nombre = 'VISTA ENERGY'  where codigo = '999992';
