-- Migración 3: trabajar sin internet.
-- Los cambios hechos sin señal se guardan en el aparato y se suben después con aplicar_operacion().
-- Cada cambio lleva un código único (op_id): si se sube dos veces, la segunda se ignora.
-- Pegar en: Supabase → SQL Editor → New query → Run

-- Los viajes se identifican con un código creado en el aparato (para poder sacar el camión sin internet)
alter table viajes add column if not exists ref uuid unique default gen_random_uuid();
update viajes set ref = gen_random_uuid() where ref is null;
alter table viajes alter column ref set not null;

-- Registro de cambios ya aplicados
create table if not exists operaciones (
  op_id      uuid primary key,
  owner      uuid not null default auth.uid(),
  tipo       text not null,
  resultado  jsonb,
  creado     timestamptz not null default now()
);
alter table operaciones enable row level security;
drop policy if exists solo_dueno on operaciones;
create policy solo_dueno on operaciones for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

-- Las funciones ahora reciben la hora real en que se hizo el cambio
drop function if exists registrar_baja(bigint, numeric, text, bigint, text);
drop function if exists cerrar_viaje(bigint, jsonb, numeric, boolean);

create or replace function registrar_venta(p jsonb) returns bigint
language plpgsql as $$
declare
  v_id     bigint;
  v_tipo   text    := p->>'tipo';
  v_cli    bigint  := nullif(p->>'cliente_id', '')::bigint;
  v_viaje  bigint  := nullif(p->>'viaje_id', '')::bigint;
  v_pagado numeric := coalesce(nullif(p->>'pagado', '')::numeric, 0);
  v_fecha  timestamptz := coalesce(nullif(p->>'fecha', '')::timestamptz, now());
  v_total  numeric;
  it       jsonb;
  l        record;
  falta    numeric;
  tomar    numeric;
  v_prod   bigint;
  v_precio numeric;
begin
  if v_tipo <> 'contado' and v_cli is null then
    raise exception 'Para fiado, pedido o regalo hay que elegir el cliente';
  end if;
  if jsonb_array_length(coalesce(p->'items', '[]')) = 0 then
    raise exception 'La venta no tiene productos';
  end if;

  insert into ventas (fecha, cliente_id, tipo, fecha_compromiso, entregado, viaje_id, nota)
  values (v_fecha, v_cli, v_tipo, nullif(p->>'fecha_compromiso', '')::date, v_tipo <> 'pedido', v_viaje, p->>'nota')
  returning id into v_id;

  for it in select * from jsonb_array_elements(p->'items') loop
    v_prod   := (it->>'producto_id')::bigint;
    falta    := (it->>'cantidad')::numeric;
    v_precio := case when v_tipo = 'regalo' then 0 else (it->>'precio')::numeric end;

    for l in select id, costo_real, restante from v_stock_lotes
             where producto_id = v_prod and restante > 0
             order by vencimiento asc nulls last, fecha, id loop
      exit when falta <= 0;
      tomar := least(falta, l.restante);
      insert into venta_items (venta_id, producto_id, lote_id, cantidad, precio, costo)
      values (v_id, v_prod, l.id, tomar, v_precio, l.costo_real);
      falta := falta - tomar;
    end loop;

    if falta > 0 then
      raise exception 'No hay stock suficiente de %', (select nombre from productos where id = v_prod);
    end if;

    if v_cli is not null and v_tipo <> 'regalo' then
      insert into precios_cliente (cliente_id, producto_id, precio)
      values (v_cli, v_prod, v_precio)
      on conflict (cliente_id, producto_id)
      do update set precio = excluded.precio, actualizado = now();
    end if;
  end loop;

  select coalesce(sum(cantidad * precio), 0) into v_total from venta_items where venta_id = v_id;
  update ventas set total = v_total where id = v_id;

  if v_tipo = 'contado' then v_pagado := v_total; end if;
  if v_tipo = 'regalo'  then v_pagado := 0;       end if;
  if v_pagado > 0 then
    insert into pagos (fecha, cliente_id, venta_id, viaje_id, monto)
    values (v_fecha, v_cli, v_id, v_viaje, least(v_pagado, v_total));
  end if;

  return v_id;
end $$;

create or replace function registrar_baja(p_producto bigint, p_cantidad numeric, p_motivo text,
                                          p_viaje bigint default null, p_nota text default null,
                                          p_fecha timestamptz default now())
returns void
language plpgsql as $$
declare
  falta numeric := p_cantidad;
  l     record;
  tomar numeric;
begin
  for l in select id, costo_real, restante from v_stock_lotes
           where producto_id = p_producto and restante > 0
           order by vencimiento asc nulls last, fecha, id loop
    exit when falta <= 0;
    tomar := least(falta, l.restante);
    insert into bajas (fecha, producto_id, lote_id, cantidad, costo, motivo, viaje_id, nota)
    values (p_fecha, p_producto, l.id, tomar, l.costo_real, p_motivo, p_viaje, p_nota);
    falta := falta - tomar;
  end loop;

  if falta > 0 then
    raise exception 'No hay stock suficiente para dar de baja';
  end if;
end $$;

create or replace function cerrar_viaje(p_viaje bigint, p_devueltos jsonb, p_efectivo numeric, p_marcar boolean,
                                        p_fecha timestamptz default now())
returns void
language plpgsql as $$
declare
  c        record;
  dev      numeric;
  vendido  numeric;
  faltante numeric;
  esperado numeric;
begin
  for c in select * from viaje_carga where viaje_id = p_viaje loop
    select coalesce(sum((d->>'devuelto')::numeric), 0) into dev
    from jsonb_array_elements(p_devueltos) d
    where (d->>'producto_id')::bigint = c.producto_id;

    select coalesce(sum(vi.cantidad), 0) into vendido
    from venta_items vi
    join ventas v on v.id = vi.venta_id
    where v.viaje_id = p_viaje and vi.producto_id = c.producto_id;

    update viaje_carga set devuelto = dev where id = c.id;

    faltante := c.cargado - vendido - dev;
    if p_marcar and faltante > 0 then
      perform registrar_baja(c.producto_id, faltante, 'pinchada', p_viaje, 'Faltante al regresar el camión', p_fecha);
    end if;
  end loop;

  select coalesce(sum(monto), 0) into esperado from pagos where viaje_id = p_viaje;

  update viajes
  set regreso = p_fecha, efectivo_esperado = esperado, efectivo_entregado = p_efectivo
  where id = p_viaje;
end $$;

-- Busca el cliente por nombre (sin importar mayúsculas) o lo crea
create or replace function cliente_por_nombre(p_nombre text) returns bigint
language plpgsql as $$
declare v_id bigint;
begin
  if coalesce(trim(p_nombre), '') = '' then return null; end if;
  select id into v_id from clientes where lower(trim(nombre)) = lower(trim(p_nombre)) order by id limit 1;
  if v_id is null then
    insert into clientes (nombre) values (trim(p_nombre)) returning id into v_id;
  end if;
  return v_id;
end $$;

-- Una llegada con varios productos. Crea los productos que no existan.
-- p = {fecha, proveedor, lineas: [{producto_id?, nombre, marca, presentacion, sabor, unidad, precio,
--                                  cant_pagada, cant_regalo, costo_unit, flete, vencimiento}]}
create or replace function registrar_llegada(p jsonb) returns jsonb
language plpgsql as $$
declare
  l       jsonb;
  v_prod  bigint;
  v_lote  bigint;
  v_lotes jsonb := '[]';
  v_precio numeric;
begin
  for l in select * from jsonb_array_elements(p->'lineas') loop
    v_prod   := nullif(l->>'producto_id', '')::bigint;
    v_precio := coalesce(nullif(l->>'precio', '')::numeric, 0);
    if v_prod is null then
      select id into v_prod from productos
      where lower(coalesce(marca, nombre)) = lower(l->>'marca')
        and lower(coalesce(presentacion, '')) = lower(coalesce(l->>'presentacion', ''))
        and lower(coalesce(sabor, '')) = lower(coalesce(l->>'sabor', ''))
      order by id limit 1;
    end if;
    if v_prod is null then
      insert into productos (nombre, marca, presentacion, sabor, unidad, precio_general)
      values (l->>'nombre', l->>'marca', nullif(l->>'presentacion', ''), nullif(l->>'sabor', ''),
              coalesce(nullif(l->>'unidad', ''), 'paq'), v_precio)
      returning id into v_prod;
    elsif v_precio > 0 then
      update productos set precio_general = v_precio where id = v_prod and precio_general = 0;
    end if;

    insert into lotes (producto_id, fecha, proveedor, cant_pagada, cant_regalo, costo_unit, flete, vencimiento)
    values (v_prod, coalesce(nullif(p->>'dia', '')::date, current_date), nullif(p->>'proveedor', ''),
            (l->>'cant_pagada')::numeric, coalesce(nullif(l->>'cant_regalo', '')::numeric, 0),
            (l->>'costo_unit')::numeric, coalesce(nullif(l->>'flete', '')::numeric, 0),
            nullif(l->>'vencimiento', '')::date)
    returning id into v_lote;
    v_lotes := v_lotes || to_jsonb(v_lote);
  end loop;
  return jsonb_build_object('lotes', v_lotes);
end $$;

-- Punto único para subir cambios (con o sin internet). Si op_id ya se aplicó, no hace nada.
create or replace function aplicar_operacion(p_op uuid, p_tipo text, p jsonb) returns jsonb
language plpgsql as $$
declare
  r        jsonb;
  v_fecha  timestamptz := coalesce(nullif(p->>'fecha', '')::timestamptz, now());
  v_viaje  bigint;
begin
  select resultado into r from operaciones where op_id = p_op;
  if found then return coalesce(r, '{}'::jsonb) || '{"repetida": true}'::jsonb; end if;
  r := '{}'::jsonb;

  if nullif(p->>'viaje_ref', '') is not null then
    select id into v_viaje from viajes where ref = (p->>'viaje_ref')::uuid;
  end if;

  case p_tipo
    when 'venta' then
      r := jsonb_build_object('venta_id', registrar_venta(p || jsonb_build_object(
             'cliente_id', cliente_por_nombre(p->>'cliente_nombre'), 'viaje_id', v_viaje, 'fecha', v_fecha)));
    when 'llegada' then
      r := registrar_llegada(p);
    when 'pago' then
      insert into pagos (fecha, cliente_id, viaje_id, monto)
      values (v_fecha, (p->>'cliente_id')::bigint, v_viaje, (p->>'monto')::numeric);
    when 'entregar' then
      if coalesce(nullif(p->>'cobrar', '')::numeric, 0) > 0 then
        insert into pagos (fecha, cliente_id, venta_id, monto)
        values (v_fecha, (p->>'cliente_id')::bigint, (p->>'venta_id')::bigint, (p->>'cobrar')::numeric);
      end if;
      update ventas set entregado = true where id = (p->>'venta_id')::bigint;
    when 'gasto' then
      insert into gastos (fecha, categoria, monto, nota)
      values (coalesce(nullif(p->>'dia', '')::date, v_fecha::date), p->>'categoria', (p->>'monto')::numeric, nullif(p->>'nota', ''));
    when 'baja' then
      perform registrar_baja((p->>'producto_id')::bigint, (p->>'cantidad')::numeric, p->>'motivo', null, nullif(p->>'nota', ''), v_fecha);
    when 'salida' then
      insert into viajes (ref, salida) values ((p->>'viaje_ref')::uuid, v_fecha) returning id into v_viaje;
      insert into viaje_carga (viaje_id, producto_id, cargado)
      select v_viaje, (x->>'producto_id')::bigint, (x->>'cantidad')::numeric
      from jsonb_array_elements(p->'carga') x;
    when 'regreso' then
      if v_viaje is null then raise exception 'No se encontró el viaje del camión'; end if;
      perform cerrar_viaje(v_viaje, p->'devueltos', (p->>'efectivo')::numeric, (p->>'marcar')::boolean, v_fecha);
    when 'cancelar_salida' then
      delete from viajes where id = v_viaje;
    else
      raise exception 'Operación desconocida: %', p_tipo;
  end case;

  insert into operaciones (op_id, tipo, resultado) values (p_op, p_tipo, r);
  return r;
end $$;
