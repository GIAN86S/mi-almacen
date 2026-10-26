-- =====================================================================
--  ALMACÉN DE BEBIDAS — esquema para Supabase
--  Pegar completo en: Supabase → SQL Editor → New query → Run
-- =====================================================================

-- ---------- Tablas ----------

create table productos (
  id             bigint generated always as identity primary key,
  owner          uuid not null default auth.uid(),
  nombre         text not null,                       -- "Mendocina Cola 3 L"
  unidad         text not null default 'paq',         -- paq, cja, fardo, und
  precio_general numeric(10,2) not null default 0,    -- precio de lista
  activo         boolean not null default true,
  creado         timestamptz not null default now()
);

create table clientes (
  id             bigint generated always as identity primary key,
  owner          uuid not null default auth.uid(),
  nombre         text not null,
  telefono       text,
  notas          text,
  deuda_inicial  numeric(12,2) not null default 0,    -- lo que ya debía antes de usar la app
  activo         boolean not null default true,
  creado         timestamptz not null default now()
);

-- Último precio cobrado a cada cliente por producto (se actualiza solo al vender)
create table precios_cliente (
  owner        uuid not null default auth.uid(),
  cliente_id   bigint not null references clientes on delete cascade,
  producto_id  bigint not null references productos on delete cascade,
  precio       numeric(10,2) not null,
  actualizado  timestamptz not null default now(),
  primary key (cliente_id, producto_id)
);

-- Cada llegada de mercadería es un lote con su costo y su vencimiento
create table lotes (
  id           bigint generated always as identity primary key,
  owner        uuid not null default auth.uid(),
  producto_id  bigint not null references productos,
  fecha        date not null default current_date,
  proveedor    text,
  cant_pagada  numeric(10,2) not null check (cant_pagada >= 0),
  cant_regalo  numeric(10,2) not null default 0 check (cant_regalo >= 0),  -- bonificación de la empresa
  costo_unit   numeric(10,2) not null check (costo_unit >= 0),             -- precio pagado por unidad
  flete        numeric(12,2) not null default 0 check (flete >= 0),        -- transporte y otros del lote
  vencimiento  date,
  nota         text,
  -- costo real por unidad: lo pagado + flete, repartido entre todo lo que llegó (incluye regalos)
  costo_real   numeric(12,4) generated always as
                 ((cant_pagada * costo_unit + flete) / nullif(cant_pagada + cant_regalo, 0)) stored,
  check (cant_pagada + cant_regalo > 0)
);

create table viajes (
  id                  bigint generated always as identity primary key,
  owner               uuid not null default auth.uid(),
  salida              timestamptz not null default now(),
  regreso             timestamptz,
  efectivo_esperado   numeric(12,2),
  efectivo_entregado  numeric(12,2),
  nota                text
);
-- Solo un camión en ruta a la vez
create unique index un_viaje_abierto on viajes (owner) where regreso is null;

create table viaje_carga (
  id           bigint generated always as identity primary key,
  owner        uuid not null default auth.uid(),
  viaje_id     bigint not null references viajes on delete cascade,
  producto_id  bigint not null references productos,
  cargado      numeric(10,2) not null check (cargado > 0),
  devuelto     numeric(10,2)
);

-- tipo: contado | fiado (se lleva hoy, paga después) | pedido (se entrega después) | regalo
create table ventas (
  id                bigint generated always as identity primary key,
  owner             uuid not null default auth.uid(),
  fecha             timestamptz not null default now(),
  cliente_id        bigint references clientes,
  tipo              text not null check (tipo in ('contado','fiado','pedido','regalo')),
  total             numeric(12,2) not null default 0,
  fecha_compromiso  date,          -- fiado: cuándo paga · pedido: cuándo se entrega
  entregado         boolean not null default true,
  viaje_id          bigint references viajes on delete set null,
  nota              text
);

-- Una fila por cada lote del que salió la mercadería
create table venta_items (
  id           bigint generated always as identity primary key,
  owner        uuid not null default auth.uid(),
  venta_id     bigint not null references ventas on delete cascade,
  producto_id  bigint not null references productos,
  lote_id      bigint not null references lotes,
  cantidad     numeric(10,2) not null check (cantidad > 0),
  precio       numeric(10,2) not null,     -- precio de venta por unidad
  costo        numeric(12,4) not null      -- costo real del lote por unidad
);

create table pagos (
  id          bigint generated always as identity primary key,
  owner       uuid not null default auth.uid(),
  fecha       timestamptz not null default now(),
  cliente_id  bigint references clientes on delete cascade,
  venta_id    bigint references ventas on delete cascade,   -- null = cobro de deuda
  viaje_id    bigint references viajes on delete set null,
  monto       numeric(12,2) not null check (monto > 0),
  nota        text
);

-- Pinchadas, vencidas, rotas: salen del stock como pérdida
create table bajas (
  id           bigint generated always as identity primary key,
  owner        uuid not null default auth.uid(),
  fecha        timestamptz not null default now(),
  producto_id  bigint not null references productos,
  lote_id      bigint not null references lotes,
  cantidad     numeric(10,2) not null check (cantidad > 0),
  costo        numeric(12,4) not null,
  motivo       text not null check (motivo in ('pinchada','vencida','otro')),
  viaje_id     bigint references viajes on delete set null,
  nota         text
);

create table gastos (
  id         bigint generated always as identity primary key,
  owner      uuid not null default auth.uid(),
  fecha      date not null default current_date,
  categoria  text not null,
  monto      numeric(12,2) not null check (monto > 0),
  nota       text
);

create index on lotes (producto_id);
create index on venta_items (lote_id);
create index on venta_items (venta_id);
create index on bajas (lote_id);
create index on ventas (fecha);
create index on ventas (cliente_id);
create index on pagos (cliente_id);
create index on pagos (venta_id);

-- ---------- Seguridad: cada fila solo la ve su dueño ----------

do $$
declare t text;
begin
  foreach t in array array['productos','clientes','precios_cliente','lotes','viajes','viaje_carga',
                           'ventas','venta_items','pagos','bajas','gastos'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy solo_dueno on %I for all to authenticated
                    using (owner = auth.uid()) with check (owner = auth.uid())', t);
  end loop;
end $$;

-- ---------- Vistas ----------

-- Cuánto queda de cada lote
create view v_stock_lotes with (security_invoker = true) as
select l.*,
       p.nombre as producto,
       p.unidad,
       l.cant_pagada + l.cant_regalo
         - coalesce((select sum(vi.cantidad) from venta_items vi where vi.lote_id = l.id), 0)
         - coalesce((select sum(b.cantidad)  from bajas b       where b.lote_id  = l.id), 0) as restante
from lotes l
join productos p on p.id = l.producto_id;

-- Deudas pendientes: los cobros sueltos pagan primero la deuda más antigua
create view v_deudas with (security_invoker = true) as
with deudas as (
  select c.id as cliente_id, null::bigint as venta_id, '-infinity'::timestamptz as fecha,
         null::date as compromiso, c.deuda_inicial as monto
  from clientes c
  where c.deuda_inicial > 0
  union all
  select v.cliente_id, v.id, v.fecha, v.fecha_compromiso,
         v.total - coalesce((select sum(p.monto) from pagos p where p.venta_id = v.id), 0)
  from ventas v
  where v.tipo <> 'regalo' and v.cliente_id is not null
),
acumulado as (
  select d.*, sum(d.monto) over (partition by d.cliente_id order by d.fecha, d.venta_id
                                 rows unbounded preceding) as acum
  from deudas d
  where d.monto > 0
),
cobros as (
  select cliente_id, sum(monto) as cobrado
  from pagos
  where venta_id is null
  group by cliente_id
)
select a.cliente_id, a.venta_id, a.fecha, a.compromiso,
       least(a.monto, a.acum - coalesce(c.cobrado, 0)) as pendiente
from acumulado a
left join cobros c using (cliente_id)
where a.acum - coalesce(c.cobrado, 0) > 0;

create view v_saldos with (security_invoker = true) as
select c.id as cliente_id, c.nombre, c.telefono,
       coalesce(sum(d.pendiente), 0) as saldo,
       min(d.compromiso) as compromiso
from clientes c
left join v_deudas d on d.cliente_id = c.id
group by c.id;

-- ---------- Funciones ----------

-- Registra una venta y descuenta del lote que vence primero.
-- p = {cliente_id, tipo, fecha_compromiso, viaje_id, pagado, nota,
--      items: [{producto_id, cantidad, precio}]}
create or replace function registrar_venta(p jsonb) returns bigint
language plpgsql as $$
declare
  v_id     bigint;
  v_tipo   text    := p->>'tipo';
  v_cli    bigint  := nullif(p->>'cliente_id', '')::bigint;
  v_viaje  bigint  := nullif(p->>'viaje_id', '')::bigint;
  v_pagado numeric := coalesce(nullif(p->>'pagado', '')::numeric, 0);
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

  insert into ventas (cliente_id, tipo, fecha_compromiso, entregado, viaje_id, nota)
  values (v_cli, v_tipo, nullif(p->>'fecha_compromiso', '')::date, v_tipo <> 'pedido', v_viaje, p->>'nota')
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
    insert into pagos (cliente_id, venta_id, viaje_id, monto)
    values (v_cli, v_id, v_viaje, least(v_pagado, v_total));
  end if;

  return v_id;
end $$;

-- Da de baja mercadería (pinchada, vencida…) empezando por el lote que vence primero
create or replace function registrar_baja(p_producto bigint, p_cantidad numeric, p_motivo text,
                                          p_viaje bigint default null, p_nota text default null)
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
    insert into bajas (producto_id, lote_id, cantidad, costo, motivo, viaje_id, nota)
    values (p_producto, l.id, tomar, l.costo_real, p_motivo, p_viaje, p_nota);
    falta := falta - tomar;
  end loop;

  if falta > 0 then
    raise exception 'No hay stock suficiente para dar de baja';
  end if;
end $$;

-- Cierra el viaje del camión: guarda lo devuelto, marca faltantes como pinchados y cuadra la plata.
-- p_devueltos = [{producto_id, devuelto}]
create or replace function cerrar_viaje(p_viaje bigint, p_devueltos jsonb, p_efectivo numeric, p_marcar boolean)
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
      perform registrar_baja(c.producto_id, faltante, 'pinchada', p_viaje, 'Faltante al regresar el camión');
    end if;
  end loop;

  select coalesce(sum(monto), 0) into esperado from pagos where viaje_id = p_viaje;

  update viajes
  set regreso = now(), efectivo_esperado = esperado, efectivo_entregado = p_efectivo
  where id = p_viaje;
end $$;
