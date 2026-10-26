import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const app = document.getElementById('app');
const configurado = SUPABASE_URL.startsWith('https://') && !SUPABASE_ANON_KEY.startsWith('PEGA');
const sb = configurado ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// =====================================================================
// Utilidades
// =====================================================================

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = v => Number(v || 0);
const bs = v => 'Bs ' + n(v).toLocaleString('es-BO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cant = v => n(v).toLocaleString('es-BO', { maximumFractionDigits: 2 });
const UNIDADES = { paq: 'paq', cja: 'cajas', fardo: 'fardos', und: 'und' };
const unidad = u => UNIDADES[u] || u || '';

// Fecha local en formato AAAA-MM-DD
const hoy = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const sumarDias = (iso, dias) => {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
};
const diasHasta = iso => Math.round((new Date(iso + 'T12:00:00') - new Date(hoy() + 'T12:00:00')) / 86400000);
const fecha = iso => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString('es-BO', { day: 'numeric', month: 'short', year: '2-digit' });
};
const fechaHora = iso => new Date(iso).toLocaleString('es-BO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function etiquetaVence(venc) {
  if (!venc) return '<span class="etiqueta gris">sin fecha</span>';
  const d = diasHasta(venc);
  if (d < 0) return `<span class="etiqueta roja">VENCIDO ${fecha(venc)}</span>`;
  if (d <= 30) return `<span class="etiqueta roja">vence en ${d} días</span>`;
  if (d <= 60) return `<span class="etiqueta amarilla">vence en ${d} días</span>`;
  return `<span class="etiqueta verde">vence ${fecha(venc)}</span>`;
}

let temporizador;
function aviso(texto, malo = false) {
  const el = document.getElementById('aviso');
  el.textContent = texto;
  el.className = 'ver' + (malo ? ' mal' : '');
  clearTimeout(temporizador);
  temporizador = setTimeout(() => (el.className = ''), malo ? 5000 : 2500);
}

async function q(consulta) {
  const { data, error } = await consulta;
  if (error) throw error;
  return data;
}

// Supabase entrega máximo 1000 filas por consulta: esto trae todas
async function todas(armar) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const data = await q(armar().range(desde, desde + 999));
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

const leer = (clave, defecto) => { try { return localStorage.getItem(clave) ?? defecto; } catch { return defecto; } };
const guardar = (clave, valor) => { try { localStorage.setItem(clave, valor); } catch { /* sin almacenamiento */ } };

function pantalla(titulo, html, volver = '#inicio') {
  app.innerHTML = `
    <div class="barra">${volver ? `<a class="volver" href="${volver}">← Volver</a>` : ''}</div>
    <h1>${titulo}</h1>
    ${html}`;
}

const $ = sel => app.querySelector(sel);
const $$ = sel => [...app.querySelectorAll(sel)];
const datos = form => Object.fromEntries(new FormData(form));

// Botón que no se puede apretar dos veces mientras guarda
async function conEspera(boton, accion) {
  if (boton.disabled) return;
  boton.disabled = true;
  try { await accion(); }
  catch (e) { aviso(e.message || String(e), true); }
  finally { boton.disabled = false; }
}

async function viajeAbierto() {
  const filas = await q(sb.from('viajes').select('id, salida').is('regreso', null).limit(1));
  return filas[0] || null;
}

async function stockDisponible() {
  const lotes = await todas(() => sb.from('v_stock_lotes')
    .select('id, producto_id, producto, unidad, restante, costo_real, vencimiento, fecha')
    .gt('restante', 0)
    .order('vencimiento', { ascending: true, nullsFirst: false })
    .order('fecha').order('id'));
  const porProducto = {};
  for (const l of lotes) {
    const p = porProducto[l.producto_id] ??= {
      id: l.producto_id, nombre: l.producto, unidad: l.unidad, restante: 0, valor: 0,
      costoPrimero: n(l.costo_real), lotes: [],
    };
    p.restante += n(l.restante);
    p.valor += n(l.restante) * n(l.costo_real);
    p.lotes.push(l);
  }
  return { lotes, porProducto };
}

// =====================================================================
// Inicio: panel + botones
// =====================================================================

function inicioPeriodo(periodo) {
  const h = hoy();
  const dia = { hoy: h, semana: sumarDias(h, -6), mes: h.slice(0, 8) + '01' }[periodo];
  return dia ? { dia, ts: new Date(dia + 'T00:00:00').toISOString() } : null;
}

async function inicio() {
  const periodo = leer('periodo', 'mes');
  const desde = inicioPeriodo(periodo);
  const filtrar = (consulta, campo, valor) => (desde ? consulta.gte(campo, valor) : consulta);

  const [items, bajas, gastos, lotes, pagos, stock, saldos, pedidos, viaje] = await Promise.all([
    todas(() => filtrar(sb.from('venta_items').select('cantidad, precio, costo, ventas!inner(fecha, tipo)'), 'ventas.fecha', desde?.ts)),
    todas(() => filtrar(sb.from('bajas').select('cantidad, costo'), 'fecha', desde?.ts)),
    todas(() => filtrar(sb.from('gastos').select('monto'), 'fecha', desde?.dia)),
    todas(() => filtrar(sb.from('lotes').select('cant_pagada, costo_unit, flete'), 'fecha', desde?.dia)),
    todas(() => filtrar(sb.from('pagos').select('monto'), 'fecha', desde?.ts)),
    stockDisponible(),
    todas(() => sb.from('v_saldos').select('saldo, compromiso').gt('saldo', 0.009)),
    q(sb.from('ventas').select('id').eq('tipo', 'pedido').eq('entregado', false)),
    viajeAbierto(),
  ]);

  let vendido = 0, costoVendido = 0, regalos = 0;
  for (const it of items) {
    if (it.ventas.tipo === 'regalo') regalos += n(it.cantidad) * n(it.costo);
    else { vendido += n(it.cantidad) * n(it.precio); costoVendido += n(it.cantidad) * n(it.costo); }
  }
  const perdidas = bajas.reduce((s, b) => s + n(b.cantidad) * n(b.costo), 0);
  const totalGastos = gastos.reduce((s, g) => s + n(g.monto), 0);
  const invertido = lotes.reduce((s, l) => s + n(l.cant_pagada) * n(l.costo_unit) + n(l.flete), 0);
  const cobrado = pagos.reduce((s, p) => s + n(p.monto), 0);
  const bruta = vendido - costoVendido;
  const neta = bruta - regalos - perdidas - totalGastos;

  const meDeben = saldos.reduce((s, c) => s + n(c.saldo), 0);
  const atrasados = saldos.filter(c => c.compromiso && c.compromiso < hoy()).length;
  const valorStock = Object.values(stock.porProducto).reduce((s, p) => s + p.valor, 0);
  const porVencer = stock.lotes.filter(l => l.vencimiento && diasHasta(l.vencimiento) <= 30);
  const valorPorVencer = porVencer.reduce((s, l) => s + n(l.restante) * n(l.costo_real), 0);

  const nombres = { hoy: 'Hoy', semana: '7 días', mes: 'Este mes', todo: 'Todo' };
  const alertas = [
    viaje && `<a class="alerta verde" href="#camion">🚚 El camión está en ruta desde ${fechaHora(viaje.salida)}. Toca aquí al regresar.</a>`,
    porVencer.length && `<a class="alerta roja" href="#stock">⚠️ ${porVencer.length} lote(s) vencen en 30 días o menos (${bs(valorPorVencer)}). ¡Véndelos primero!</a>`,
    atrasados && `<a class="alerta roja" href="#cobrar">💸 ${atrasados} cliente(s) pasaron su fecha de pago.</a>`,
    pedidos.length && `<a class="alerta amarilla" href="#pedidos">📋 ${pedidos.length} pedido(s) por entregar.</a>`,
  ].filter(Boolean).join('');

  app.innerHTML = `
    <h1>Mi Almacén</h1>
    <div class="menu">
      <a class="ancho" href="#vender"><span>🛒</span> VENDER</a>
      <a href="#llego"><span>📦</span>Llegó mercadería</a>
      <a href="#cobrar"><span>💵</span>Cobrar</a>
      <a href="#camion"><span>🚚</span>Camión</a>
      <a href="#gasto"><span>🧾</span>Gasto</a>
    </div>
    ${alertas}
    <div class="chips">
      ${Object.entries(nombres).map(([k, v]) => `<button class="chip ${k === periodo ? 'activo' : ''}" data-periodo="${k}">${v}</button>`).join('')}
    </div>
    <div class="cifras">
      <div class="cifra"><small>Vendido</small><b>${bs(vendido)}</b></div>
      <div class="cifra"><small>Ganancia real</small><b class="${neta >= 0 ? 'positivo' : 'negativo'}">${bs(neta)}</b></div>
      <div class="cifra"><small>Me deben (hoy)</small><b>${bs(meDeben)}</b></div>
      <div class="cifra"><small>Mercadería en stock</small><b>${bs(valorStock)}</b></div>
    </div>
    <div class="tarjeta">
      <ul class="lineas">
        <li><span>Vendido</span><b>${bs(vendido)}</b></li>
        <li><span>− Costo de lo vendido</span><b>${bs(costoVendido)}</b></li>
        <li class="total"><span>= Ganancia de las ventas</span><b>${bs(bruta)}</b></li>
        <li><span>− Regalos a clientes</span><b>${bs(regalos)}</b></li>
        <li><span>− Pinchadas / vencidas</span><b>${bs(perdidas)}</b></li>
        <li><span>− Gastos</span><b>${bs(totalGastos)}</b></li>
        <li class="total"><span>= Ganancia real</span><b class="${neta >= 0 ? 'positivo' : 'negativo'}">${bs(neta)}</b></li>
      </ul>
    </div>
    <div class="tarjeta">
      <ul class="lineas">
        <li><span>Invertido en mercadería</span><b>${bs(invertido)}</b></li>
        <li><span>Plata que entró (cobros)</span><b>${bs(cobrado)}</b></li>
      </ul>
    </div>
    <div class="menu">
      <a href="#stock"><span>📊</span>Stock y vencimientos</a>
      <a href="#historial"><span>📒</span>Ventas</a>
      <a href="#pedidos"><span>📋</span>Pedidos</a>
      <a href="#clientes"><span>👥</span>Clientes</a>
      <a href="#productos"><span>🥤</span>Productos</a>
      <a href="#baja"><span>🗑️</span>Pinchadas / bajas</a>
    </div>
    <button class="btn" id="salir" style="width:100%">Cerrar sesión</button>`;

  $$('[data-periodo]').forEach(b => b.onclick = () => { guardar('periodo', b.dataset.periodo); inicio(); });
  $('#salir').onclick = async () => { await sb.auth.signOut(); login(); };
}

// =====================================================================
// Llegó mercadería (nuevo lote)
// =====================================================================

async function llego() {
  const [productos, ultimos] = await Promise.all([
    q(sb.from('productos').select('*').eq('activo', true).order('nombre')),
    q(sb.from('v_stock_lotes').select('*').order('id', { ascending: false }).limit(10)),
  ]);
  const buscar = nombre => productos.find(p => p.nombre.trim().toLowerCase() === nombre.trim().toLowerCase());

  pantalla('📦 Llegó mercadería', `
    <form id="f" class="tarjeta" autocomplete="off">
      <label>Producto
        <input name="producto" list="lista-prod" required placeholder="Ej: Mendocina Cola 3 L">
      </label>
      <datalist id="lista-prod">${productos.map(p => `<option value="${esc(p.nombre)}">`).join('')}</datalist>
      <div id="nuevo" hidden>
        <p class="nota">Producto nuevo. Completa:</p>
        <div class="fila2">
          <label>Unidad
            <select name="unidad">
              <option value="paq">Paquete</option><option value="cja">Caja</option>
              <option value="fardo">Fardo</option><option value="und">Unidad</option>
            </select>
          </label>
          <label>Precio de venta general
            <input name="precio_general" type="number" step="any" min="0" inputmode="decimal">
          </label>
        </div>
      </div>
      <div class="fila2">
        <label>Cantidad pagada <input name="cant_pagada" type="number" step="any" min="0" inputmode="decimal" required></label>
        <label>De regalo (bonificación) <input name="cant_regalo" type="number" step="any" min="0" inputmode="decimal" value="0"></label>
      </div>
      <div class="fila2">
        <label>Costo por unidad (Bs) <input name="costo_unit" type="number" step="any" min="0" inputmode="decimal" required></label>
        <label>Flete y otros (Bs) <input name="flete" type="number" step="any" min="0" inputmode="decimal" value="0"></label>
      </div>
      <label>Fecha de vencimiento <input name="vencimiento" type="date"></label>
      <div class="fila2">
        <label>Proveedor <input name="proveedor" value="${esc(leer('proveedor', 'BBO'))}"></label>
        <label>Fecha de llegada <input name="fecha" type="date" value="${hoy()}" required></label>
      </div>
      <label>Nota <input name="nota" placeholder="opcional"></label>
      <div id="calculo" class="resumen"></div>
      <button class="btn primario grande">Guardar lote</button>
    </form>
    <h3>Últimos lotes</h3>
    <div class="tarjeta">${ultimos.length ? ultimos.map(l => `
      <div class="item">
        <div class="info"><b>${esc(l.producto)}</b>
          <small>${fecha(l.fecha)} · ${cant(n(l.cant_pagada) + n(l.cant_regalo))} ${unidad(l.unidad)}${n(l.cant_regalo) ? ` (${cant(l.cant_regalo)} de regalo)` : ''} · quedan ${cant(l.restante)}</small>
          ${etiquetaVence(l.vencimiento)}
        </div>
        <div class="monto">${bs(l.costo_real)}<small class="nota">/u</small></div>
      </div>`).join('') : '<p class="nota">Todavía no hay lotes.</p>'}
    </div>`);

  const form = $('#f');
  const calcular = () => {
    const d = datos(form);
    $('#nuevo').hidden = !d.producto || !!buscar(d.producto);
    const total = n(d.cant_pagada) + n(d.cant_regalo);
    if (!total || !d.costo_unit) { $('#calculo').innerHTML = ''; return; }
    const pagado = n(d.cant_pagada) * n(d.costo_unit) + n(d.flete);
    $('#calculo').innerHTML = `
      <ul class="lineas">
        <li><span>Entran al almacén</span><b>${cant(total)}</b></li>
        <li><span>Total pagado</span><b>${bs(pagado)}</b></li>
        <li class="total"><span>Costo real por unidad</span><b>${bs(pagado / total)}</b></li>
      </ul>`;
  };
  form.oninput = calcular;

  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button'), async () => {
      const d = datos(form);
      let producto = buscar(d.producto);
      if (!producto) {
        producto = await q(sb.from('productos').insert({
          nombre: d.producto.trim(), unidad: d.unidad, precio_general: n(d.precio_general),
        }).select().single());
      }
      await q(sb.from('lotes').insert({
        producto_id: producto.id,
        fecha: d.fecha,
        proveedor: d.proveedor.trim() || null,
        cant_pagada: n(d.cant_pagada),
        cant_regalo: n(d.cant_regalo),
        costo_unit: n(d.costo_unit),
        flete: n(d.flete),
        vencimiento: d.vencimiento || null,
        nota: d.nota.trim() || null,
      }));
      guardar('proveedor', d.proveedor.trim());
      aviso('Lote guardado ✔');
      llego();
    });
  };
}

// =====================================================================
// Vender
// =====================================================================

async function vender() {
  const [productos, clientes, stock, viaje] = await Promise.all([
    q(sb.from('productos').select('*').eq('activo', true).order('nombre')),
    q(sb.from('clientes').select('id, nombre').eq('activo', true).order('nombre')),
    stockDisponible(),
    viajeAbierto(),
  ]);
  const conStock = productos.filter(p => stock.porProducto[p.id]);
  const buscarCliente = nombre => clientes.find(c => c.nombre.trim().toLowerCase() === nombre.trim().toLowerCase());

  let items = [];
  let tipo = 'contado';
  let preciosCliente = {};

  pantalla('🛒 Vender', `
    <div class="tarjeta">
      <label>Cliente
        <input id="cliente" list="lista-cli" placeholder="Escribe el nombre (vacío = cliente de paso)" autocomplete="off">
      </label>
      <datalist id="lista-cli">${clientes.map(c => `<option value="${esc(c.nombre)}">`).join('')}</datalist>
      <p class="nota" id="nota-cliente"></p>
    </div>
    <form id="agregar" class="tarjeta" autocomplete="off">
      <label>Producto
        <select name="producto_id" required>
          <option value="">— elegir —</option>
          ${conStock.map(p => `<option value="${p.id}">${esc(p.nombre)} (quedan ${cant(stock.porProducto[p.id].restante)})</option>`).join('')}
        </select>
      </label>
      <div class="fila2">
        <label>Cantidad <input name="cantidad" type="number" step="any" min="0" inputmode="decimal" required></label>
        <label>Precio por unidad <input name="precio" type="number" step="any" min="0" inputmode="decimal" required></label>
      </div>
      <p class="nota" id="nota-precio"></p>
      <button class="btn grande">+ Agregar</button>
    </form>
    <div class="tarjeta" id="carrito"></div>
    <div class="tarjeta">
      <b>¿Cómo paga?</b>
      <div class="tipos">
        <button data-tipo="contado" class="activo">💵 Contado</button>
        <button data-tipo="fiado">📝 Fiado</button>
        <button data-tipo="pedido">📋 Pedido (entrega después)</button>
        <button data-tipo="regalo">🎁 Regalo</button>
      </div>
      <div id="extra"></div>
      ${viaje ? '<label class="check"><input type="checkbox" id="desde-camion" checked> Venta desde el camión</label>' : ''}
      <label>Nota <input id="nota" placeholder="opcional"></label>
      <button class="btn primario grande" id="guardar">Guardar venta</button>
    </div>`);

  const form = $('#agregar');
  const selProducto = form.producto_id;

  const precioSugerido = () => {
    const p = productos.find(x => x.id == selProducto.value);
    if (!p) { $('#nota-precio').textContent = ''; return; }
    const especial = preciosCliente[p.id];
    form.precio.value = especial ?? p.precio_general ?? '';
    const costo = stock.porProducto[p.id].costoPrimero;
    $('#nota-precio').innerHTML = (especial != null ? 'Precio que le diste a este cliente la última vez.' : 'Precio general.')
      + ` Costo: ${bs(costo)}.`;
  };

  $('#cliente').oninput = async () => {
    const c = buscarCliente($('#cliente').value);
    preciosCliente = {};
    if (c) {
      const filas = await q(sb.from('precios_cliente').select('producto_id, precio').eq('cliente_id', c.id));
      for (const f of filas) preciosCliente[f.producto_id] = n(f.precio);
      const [saldo] = await q(sb.from('v_saldos').select('saldo').eq('cliente_id', c.id));
      $('#nota-cliente').innerHTML = n(saldo?.saldo) > 0 ? `<span class="negativo">Debe ${bs(saldo.saldo)}</span>` : 'No tiene deudas.';
    } else {
      $('#nota-cliente').textContent = $('#cliente').value.trim() ? 'Cliente nuevo: se guardará al vender.' : '';
    }
    precioSugerido();
  };
  selProducto.onchange = precioSugerido;

  const yaEnCarrito = id => items.filter(i => i.producto_id == id).reduce((s, i) => s + i.cantidad, 0);

  const dibujarCarrito = () => {
    const total = items.reduce((s, i) => s + i.cantidad * i.precio, 0);
    const ganancia = items.reduce((s, i) => s + i.cantidad * (i.precio - i.costo), 0);
    $('#carrito').innerHTML = items.length ? `
      ${items.map((i, k) => `
        <div class="item">
          <div class="info"><b>${esc(i.nombre)}</b>
            <small>${cant(i.cantidad)} × ${bs(i.precio)}${i.precio < i.costo ? ' · <span class="negativo">¡por debajo del costo!</span>' : ''}</small>
          </div>
          <div class="monto">${bs(i.cantidad * i.precio)}</div>
          <button class="chico peligro" data-quitar="${k}" aria-label="Quitar">✕</button>
        </div>`).join('')}
      <ul class="lineas">
        <li class="total"><span>Total</span><b>${bs(tipo === 'regalo' ? 0 : total)}</b></li>
        ${tipo === 'regalo' ? '' : `<li><span>Ganancia de esta venta</span><b class="${ganancia >= 0 ? 'positivo' : 'negativo'}">${bs(ganancia)}</b></li>`}
      </ul>` : '<p class="nota">Agrega productos arriba.</p>';
    $$('[data-quitar]').forEach(b => b.onclick = () => { items.splice(+b.dataset.quitar, 1); dibujarCarrito(); });
  };

  form.onsubmit = e => {
    e.preventDefault();
    const d = datos(form);
    const p = productos.find(x => x.id == d.producto_id);
    const disponible = stock.porProducto[p.id].restante - yaEnCarrito(p.id);
    const cantidad = n(d.cantidad);
    if (cantidad <= 0) return aviso('Pon una cantidad', true);
    if (cantidad > disponible + 1e-9) return aviso(`Solo quedan ${cant(disponible)} de ${p.nombre}`, true);
    const precio = n(d.precio);
    const costo = stock.porProducto[p.id].costoPrimero;
    if (tipo !== 'regalo' && precio < costo &&
        !confirm(`Estás vendiendo a ${bs(precio)} y te costó ${bs(costo)}. Vas a perder plata. ¿Seguro?`)) return;
    items.push({ producto_id: p.id, nombre: p.nombre, cantidad, precio, costo });
    form.reset();
    $('#nota-precio').textContent = '';
    dibujarCarrito();
  };

  const dibujarExtra = () => {
    $$('[data-tipo]').forEach(b => b.classList.toggle('activo', b.dataset.tipo === tipo));
    $('#extra').innerHTML = {
      contado: '',
      fiado: `<div class="fila2">
          <label>Paga ahora (a cuenta) <input id="pagado" type="number" step="any" min="0" inputmode="decimal" value="0"></label>
          <label>¿Cuándo paga el resto? <input id="compromiso" type="date" value="${sumarDias(hoy(), 7)}"></label>
        </div>`,
      pedido: `<div class="fila2">
          <label>Paga ahora (adelanto) <input id="pagado" type="number" step="any" min="0" inputmode="decimal" value="0"></label>
          <label>¿Cuándo se entrega? <input id="compromiso" type="date" value="${sumarDias(hoy(), 1)}"></label>
        </div>
        <p class="nota">La mercadería queda apartada para este cliente.</p>`,
      regalo: '<p class="nota">Se descuenta del stock y se cuenta como gasto de regalo (a precio de costo).</p>',
    }[tipo];
    dibujarCarrito();
  };
  $$('[data-tipo]').forEach(b => b.onclick = () => { tipo = b.dataset.tipo; dibujarExtra(); });
  dibujarExtra();

  $('#guardar').onclick = () => conEspera($('#guardar'), async () => {
    if (!items.length) throw new Error('Agrega al menos un producto');
    const nombre = $('#cliente').value.trim();
    if (tipo !== 'contado' && !nombre) throw new Error('Para fiado, pedido o regalo escribe el nombre del cliente');
    let cliente = nombre ? buscarCliente(nombre) : null;
    if (nombre && !cliente) cliente = await q(sb.from('clientes').insert({ nombre }).select().single());
    const total = items.reduce((s, i) => s + i.cantidad * i.precio, 0);
    await q(sb.rpc('registrar_venta', {
      p: {
        cliente_id: cliente?.id ?? null,
        tipo,
        fecha_compromiso: $('#compromiso')?.value || null,
        viaje_id: viaje && $('#desde-camion')?.checked ? viaje.id : null,
        pagado: n($('#pagado')?.value),
        nota: $('#nota').value.trim() || null,
        items: items.map(({ producto_id, cantidad, precio }) => ({ producto_id, cantidad, precio })),
      },
    }));
    aviso(tipo === 'regalo' ? 'Regalo guardado ✔' : `Venta guardada: ${bs(total)} ✔`);
    vender();
  });

  dibujarCarrito();
}

// =====================================================================
// Cobrar
// =====================================================================

async function cobrar() {
  const [saldos, viaje] = await Promise.all([
    todas(() => sb.from('v_saldos').select('*').gt('saldo', 0.009).order('saldo', { ascending: false })),
    viajeAbierto(),
  ]);
  const total = saldos.reduce((s, c) => s + n(c.saldo), 0);

  pantalla('💵 Cobrar', `
    <div class="cifras"><div class="cifra"><small>Me deben en total</small><b>${bs(total)}</b></div>
      <div class="cifra"><small>Clientes que deben</small><b>${saldos.length}</b></div></div>
    ${saldos.map(c => {
      const atrasado = c.compromiso && c.compromiso < hoy();
      const tel = (c.telefono || '').replace(/\D/g, '');
      const wa = tel ? `https://wa.me/${tel.length === 8 ? '591' + tel : tel}?text=${encodeURIComponent(
        `Hola ${c.nombre}, te recuerdo tu saldo pendiente de ${bs(c.saldo)}. Gracias.`)}` : '';
      return `
      <div class="tarjeta">
        <div class="item">
          <div class="info"><b>${esc(c.nombre)}</b>
            <small>${c.compromiso ? (atrasado ? `<span class="negativo">Debía pagar el ${fecha(c.compromiso)}</span>` : `Paga hasta el ${fecha(c.compromiso)}`) : ''}</small>
          </div>
          <div class="monto ${atrasado ? 'negativo' : ''}">${bs(c.saldo)}</div>
        </div>
        <form class="fila2" data-cliente="${c.cliente_id}" data-saldo="${c.saldo}">
          <input name="monto" type="number" step="any" min="0" inputmode="decimal" placeholder="¿Cuánto pagó?" required>
          <button class="primario">Cobrar</button>
        </form>
        ${wa ? `<p class="nota"><a href="${wa}" target="_blank" rel="noopener">Recordarle por WhatsApp</a></p>` : ''}
      </div>`;
    }).join('') || '<p class="tarjeta">Nadie te debe. 🎉</p>'}
    ${viaje ? '<label class="check"><input type="checkbox" id="desde-camion" checked> Cobros hechos en la ruta del camión</label>' : ''}`);

  $$('form[data-cliente]').forEach(form => form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button'), async () => {
      const monto = n(form.monto.value);
      const saldo = n(form.dataset.saldo);
      if (monto <= 0) throw new Error('Pon el monto');
      if (monto > saldo + 0.001 && !confirm(`Debe ${bs(saldo)} y estás cobrando ${bs(monto)}. ¿Seguro?`)) return;
      await q(sb.from('pagos').insert({
        cliente_id: +form.dataset.cliente,
        monto,
        viaje_id: viaje && $('#desde-camion')?.checked ? viaje.id : null,
      }));
      aviso(`Cobro de ${bs(monto)} guardado ✔`);
      cobrar();
    });
  });
}

// =====================================================================
// Camión: salida y regreso
// =====================================================================

async function camion() {
  const viaje = await viajeAbierto();
  return viaje ? camionEnRuta(viaje.id) : camionSalida();
}

async function camionSalida() {
  const [stock, anteriores] = await Promise.all([
    stockDisponible(),
    q(sb.from('viajes').select('*').not('regreso', 'is', null).order('id', { ascending: false }).limit(5)),
  ]);
  const productos = Object.values(stock.porProducto).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const opciones = productos.map(p => `<option value="${p.id}">${esc(p.nombre)} (hay ${cant(p.restante)})</option>`).join('');
  const fila = () => `
    <div class="fila2 carga">
      <select name="producto"><option value="">— producto —</option>${opciones}</select>
      <input name="cantidad" type="number" step="any" min="0" inputmode="decimal" placeholder="Cantidad">
    </div>`;

  pantalla('🚚 Cargar camión', `
    <form id="f" class="tarjeta">
      <p class="nota">Anota lo que sube al camión. Al volver, cuentas lo que regresó y la app te dice qué falta.</p>
      <div id="filas">${fila()}${fila()}${fila()}</div>
      <button type="button" class="btn" id="mas" style="width:100%;margin-top:10px">+ Otro producto</button>
      <button class="btn primario grande">Salió el camión</button>
    </form>
    <h3>Viajes anteriores</h3>
    <div class="tarjeta">${anteriores.length ? anteriores.map(v => {
      const dif = n(v.efectivo_entregado) - n(v.efectivo_esperado);
      return `<div class="item"><div class="info"><b>${fechaHora(v.salida)}</b>
        <small>Debía traer ${bs(v.efectivo_esperado)} · trajo ${bs(v.efectivo_entregado)}</small></div>
        <div class="monto ${Math.abs(dif) < 0.01 ? 'positivo' : 'negativo'}">${Math.abs(dif) < 0.01 ? 'Cuadra' : bs(dif)}</div></div>`;
    }).join('') : '<p class="nota">Sin viajes todavía.</p>'}</div>`);

  $('#mas').onclick = () => $('#filas').insertAdjacentHTML('beforeend', fila());
  const form = $('#f');
  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button.primario'), async () => {
      const carga = {};
      for (const div of $$('.carga')) {
        const id = div.querySelector('select').value;
        const c = n(div.querySelector('input').value);
        if (id && c > 0) carga[id] = (carga[id] || 0) + c;
      }
      const filas = Object.entries(carga);
      if (!filas.length) throw new Error('Anota al menos un producto');
      for (const [id, c] of filas) {
        if (c > stock.porProducto[id].restante + 1e-9) throw new Error(`No hay tanto ${stock.porProducto[id].nombre} (hay ${cant(stock.porProducto[id].restante)})`);
      }
      const viaje = await q(sb.from('viajes').insert({}).select().single());
      try {
        await q(sb.from('viaje_carga').insert(filas.map(([id, c]) => ({ viaje_id: viaje.id, producto_id: +id, cargado: c }))));
      } catch (err) {
        await sb.from('viajes').delete().eq('id', viaje.id);
        throw err;
      }
      aviso('Camión en ruta 🚚');
      camion();
    });
  };
}

async function camionEnRuta(viajeId) {
  const [viaje, carga, vendidos, pagos] = await Promise.all([
    q(sb.from('viajes').select('*').eq('id', viajeId).single()),
    q(sb.from('viaje_carga').select('*, productos(nombre, unidad)').eq('viaje_id', viajeId)),
    todas(() => sb.from('venta_items').select('producto_id, cantidad, ventas!inner(viaje_id)').eq('ventas.viaje_id', viajeId)),
    q(sb.from('pagos').select('monto').eq('viaje_id', viajeId)),
  ]);
  const vendido = {};
  for (const v of vendidos) vendido[v.producto_id] = (vendido[v.producto_id] || 0) + n(v.cantidad);
  const esperado = pagos.reduce((s, p) => s + n(p.monto), 0);

  pantalla('🚚 Camión en ruta', `
    <p class="nota">Salió: ${fechaHora(viaje.salida)}. Las ventas marcadas "desde el camión" se van sumando aquí.</p>
    <form id="f" class="tarjeta">
      <table>
        <thead><tr><th>Producto</th><th class="n">Cargó</th><th class="n">Vendió</th><th class="n">Volvió</th></tr></thead>
        <tbody>${carga.map(c => {
          const debe = Math.max(0, n(c.cargado) - (vendido[c.producto_id] || 0));
          return `<tr>
            <td>${esc(c.productos.nombre)}</td>
            <td class="n">${cant(c.cargado)}</td>
            <td class="n">${cant(vendido[c.producto_id] || 0)}</td>
            <td class="n"><input type="number" step="any" min="0" inputmode="decimal" data-producto="${c.producto_id}" data-debe="${debe}" value="${debe}"></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      <div id="faltantes" class="resumen"></div>
      <label class="check"><input type="checkbox" id="marcar" checked> Lo que falta, contarlo como pinchado/roto</label>
      <ul class="lineas" style="margin-top:12px">
        <li><span>Plata que debe traer (ventas y cobros de la ruta)</span><b>${bs(esperado)}</b></li>
      </ul>
      <label>¿Cuánta plata trajo? <input id="efectivo" type="number" step="any" min="0" inputmode="decimal" value="${esperado.toFixed(2)}"></label>
      <p class="nota" id="dif-plata"></p>
      <button class="btn primario grande">Regresó el camión</button>
    </form>
    ${vendidos.length ? '' : '<button class="btn peligro" id="cancelar" style="width:100%">Cancelar esta salida</button>'}`);

  const revisar = () => {
    const faltan = $$('[data-producto]').map(i => ({
      nombre: carga.find(c => c.producto_id == i.dataset.producto).productos.nombre,
      falta: n(i.dataset.debe) - n(i.value),
    })).filter(x => x.falta > 0);
    $('#faltantes').innerHTML = faltan.length
      ? '<b class="negativo">Falta:</b> ' + faltan.map(x => `${esc(x.nombre)}: ${cant(x.falta)}`).join(' · ')
      : '';
    const dif = n($('#efectivo').value) - esperado;
    $('#dif-plata').innerHTML = Math.abs(dif) < 0.01 ? '<span class="positivo">La plata cuadra ✔</span>'
      : `<span class="negativo">${dif < 0 ? 'Faltan' : 'Sobran'} ${bs(Math.abs(dif))}</span>`;
  };
  $('#f').oninput = revisar;
  revisar();

  $('#f').onsubmit = e => {
    e.preventDefault();
    conEspera($('#f button.primario'), async () => {
      await q(sb.rpc('cerrar_viaje', {
        p_viaje: viajeId,
        p_devueltos: $$('[data-producto]').map(i => ({ producto_id: +i.dataset.producto, devuelto: n(i.value) })),
        p_efectivo: n($('#efectivo').value),
        p_marcar: $('#marcar').checked,
      }));
      aviso('Viaje cerrado ✔');
      location.hash = '#inicio';
    });
  };
  const cancelar = $('#cancelar');
  if (cancelar) cancelar.onclick = () => conEspera(cancelar, async () => {
    if (!confirm('¿Cancelar esta salida del camión?')) return;
    await q(sb.from('viajes').delete().eq('id', viajeId));
    camion();
  });
}

// =====================================================================
// Gastos
// =====================================================================

const CATEGORIAS = ['Flete / transporte', 'Combustible', 'Sueldos', 'Alquiler', 'Depósito', 'Otros'];

async function gasto() {
  const desde = hoy().slice(0, 8) + '01';
  const gastos = await q(sb.from('gastos').select('*').gte('fecha', desde).order('fecha', { ascending: false }).order('id', { ascending: false }));
  const total = gastos.reduce((s, g) => s + n(g.monto), 0);

  pantalla('🧾 Gasto', `
    <form id="f" class="tarjeta">
      <b>¿En qué se gastó?</b>
      <div class="tipos">${CATEGORIAS.map((c, i) => `<button type="button" data-cat="${esc(c)}" class="${i === 0 ? 'activo' : ''}">${esc(c)}</button>`).join('')}</div>
      <div class="fila2">
        <label>Monto (Bs) <input name="monto" type="number" step="any" min="0" inputmode="decimal" required></label>
        <label>Fecha <input name="fecha" type="date" value="${hoy()}" required></label>
      </div>
      <label>Detalle <input name="nota" placeholder="opcional"></label>
      <button class="btn primario grande">Guardar gasto</button>
    </form>
    <h3>Gastos de este mes · ${bs(total)}</h3>
    <div class="tarjeta">${gastos.map(g => `
      <div class="item"><div class="info"><b>${esc(g.categoria)}</b><small>${fecha(g.fecha)}${g.nota ? ' · ' + esc(g.nota) : ''}</small></div>
        <div class="monto">${bs(g.monto)}</div>
        <button class="chico peligro" data-borrar="${g.id}" aria-label="Borrar">✕</button></div>`).join('') || '<p class="nota">Sin gastos este mes.</p>'}
    </div>`);

  let categoria = CATEGORIAS[0];
  $$('[data-cat]').forEach(b => b.onclick = () => {
    categoria = b.dataset.cat;
    $$('[data-cat]').forEach(x => x.classList.toggle('activo', x === b));
  });
  const form = $('#f');
  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button.primario'), async () => {
      const d = datos(form);
      await q(sb.from('gastos').insert({ categoria, monto: n(d.monto), fecha: d.fecha, nota: d.nota.trim() || null }));
      aviso('Gasto guardado ✔');
      gasto();
    });
  };
  $$('[data-borrar]').forEach(b => b.onclick = () => conEspera(b, async () => {
    if (!confirm('¿Borrar este gasto?')) return;
    await q(sb.from('gastos').delete().eq('id', b.dataset.borrar));
    gasto();
  }));
}

// =====================================================================
// Stock y vencimientos
// =====================================================================

async function stock() {
  const { porProducto } = await stockDisponible();
  const lista = Object.values(porProducto).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const total = lista.reduce((s, p) => s + p.valor, 0);

  pantalla('📊 Stock y vencimientos', `
    <div class="cifras"><div class="cifra"><small>Valor del stock (a costo)</small><b>${bs(total)}</b></div>
      <div class="cifra"><small>Productos con stock</small><b>${lista.length}</b></div></div>
    <p class="nota">Cada venta sale primero del lote que vence antes.</p>
    ${lista.map(p => `
      <div class="tarjeta">
        <div class="item"><div class="info"><b>${esc(p.nombre)}</b><small>${cant(p.restante)} ${unidad(p.unidad)}</small></div>
          <div class="monto">${bs(p.valor)}</div></div>
        ${p.lotes.map(l => `
          <div class="item"><div class="info"><small>Lote del ${fecha(l.fecha)} · quedan ${cant(l.restante)} · costo ${bs(l.costo_real)}</small>
            ${etiquetaVence(l.vencimiento)}</div>
            <button class="chico peligro" data-borrar="${l.id}" aria-label="Borrar lote">✕</button></div>`).join('')}
      </div>`).join('') || '<p class="tarjeta">No hay stock. Registra lo que llega en "Llegó mercadería".</p>'}`);

  $$('[data-borrar]').forEach(b => b.onclick = () => conEspera(b, async () => {
    if (!confirm('¿Borrar este lote? Solo se puede si todavía no se vendió nada de él.')) return;
    const { error } = await sb.from('lotes').delete().eq('id', b.dataset.borrar);
    if (error) throw new Error('No se puede borrar: ya tiene ventas o bajas. Usa "Pinchadas / bajas".');
    aviso('Lote borrado');
    stock();
  }));
}

// =====================================================================
// Bajas: pinchadas, vencidas
// =====================================================================

async function baja() {
  const [st, recientes] = await Promise.all([
    stockDisponible(),
    q(sb.from('bajas').select('*, productos(nombre)').order('id', { ascending: false }).limit(15)),
  ]);
  const productos = Object.values(st.porProducto).sort((a, b) => a.nombre.localeCompare(b.nombre));

  pantalla('🗑️ Pinchadas / bajas', `
    <form id="f" class="tarjeta">
      <p class="nota">Opcional: los faltantes del camión se cuentan solos al regresar.</p>
      <label>Producto
        <select name="producto" required><option value="">— elegir —</option>
          ${productos.map(p => `<option value="${p.id}">${esc(p.nombre)} (hay ${cant(p.restante)})</option>`).join('')}
        </select></label>
      <div class="fila2">
        <label>Cantidad <input name="cantidad" type="number" step="any" min="0" inputmode="decimal" required></label>
        <label>Motivo
          <select name="motivo"><option value="pinchada">Pinchada / rota</option><option value="vencida">Vencida</option><option value="otro">Otro</option></select></label>
      </div>
      <label>Nota <input name="nota" placeholder="opcional"></label>
      <button class="btn primario grande">Dar de baja</button>
    </form>
    <h3>Últimas bajas</h3>
    <div class="tarjeta">${recientes.map(b => `
      <div class="item"><div class="info"><b>${esc(b.productos.nombre)}</b>
        <small>${fechaHora(b.fecha)} · ${esc(b.motivo)} · ${cant(b.cantidad)}${b.nota ? ' · ' + esc(b.nota) : ''}</small></div>
        <div class="monto negativo">${bs(n(b.cantidad) * n(b.costo))}</div>
        <button class="chico peligro" data-borrar="${b.id}" aria-label="Deshacer">✕</button></div>`).join('') || '<p class="nota">Sin bajas.</p>'}
    </div>`);

  const form = $('#f');
  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button'), async () => {
      const d = datos(form);
      await q(sb.rpc('registrar_baja', { p_producto: +d.producto, p_cantidad: n(d.cantidad), p_motivo: d.motivo, p_nota: d.nota.trim() || null }));
      aviso('Baja registrada');
      baja();
    });
  };
  $$('[data-borrar]').forEach(b => b.onclick = () => conEspera(b, async () => {
    if (!confirm('¿Deshacer esta baja? La mercadería vuelve al stock.')) return;
    await q(sb.from('bajas').delete().eq('id', b.dataset.borrar));
    baja();
  }));
}

// =====================================================================
// Historial de ventas
// =====================================================================

const TIPOS = { contado: 'Contado', fiado: 'Fiado', pedido: 'Pedido', regalo: 'Regalo' };

function tarjetaVenta(v, acciones = '') {
  const lineas = {};
  for (const it of v.venta_items) {
    const k = it.productos.nombre + '|' + it.precio;
    lineas[k] ??= { nombre: it.productos.nombre, precio: n(it.precio), cantidad: 0 };
    lineas[k].cantidad += n(it.cantidad);
  }
  return `
    <div class="tarjeta">
      <div class="item"><div class="info"><b>${esc(v.clientes?.nombre || 'Cliente de paso')}</b>
        <small>${fechaHora(v.fecha)} · <span class="etiqueta ${v.tipo === 'contado' ? 'verde' : v.tipo === 'regalo' ? 'gris' : 'amarilla'}">${TIPOS[v.tipo]}</span>
        ${v.fecha_compromiso ? ` · ${v.tipo === 'pedido' ? 'entrega' : 'paga'} ${fecha(v.fecha_compromiso)}` : ''}</small></div>
        <div class="monto">${bs(v.total)}</div></div>
      <small class="nota">${Object.values(lineas).map(l => `${cant(l.cantidad)} ${esc(l.nombre)} a ${bs(l.precio)}`).join(' · ')}${v.nota ? ' · ' + esc(v.nota) : ''}</small>
      ${acciones}
    </div>`;
}

async function historial() {
  const dias = +leer('dias-historial', '7');
  const desde = new Date(sumarDias(hoy(), -(dias - 1)) + 'T00:00:00').toISOString();
  const ventas = await todas(() => sb.from('ventas')
    .select('id, fecha, tipo, total, fecha_compromiso, nota, clientes(nombre), venta_items(cantidad, precio, productos(nombre))')
    .gte('fecha', desde).order('fecha', { ascending: false }));

  pantalla('📒 Ventas', `
    <div class="chips">${[1, 7, 30].map(d => `<button class="chip ${d === dias ? 'activo' : ''}" data-dias="${d}">${d === 1 ? 'Hoy' : d + ' días'}</button>`).join('')}</div>
    ${ventas.map(v => tarjetaVenta(v, `<button class="chico peligro" data-anular="${v.id}" style="margin-top:8px">Anular venta</button>`)).join('')
      || '<p class="tarjeta">Sin ventas en este periodo.</p>'}`);

  $$('[data-dias]').forEach(b => b.onclick = () => { guardar('dias-historial', b.dataset.dias); historial(); });
  $$('[data-anular]').forEach(b => b.onclick = () => conEspera(b, async () => {
    if (!confirm('¿Anular esta venta? La mercadería vuelve al stock y se borra lo pagado en ella.')) return;
    await q(sb.from('ventas').delete().eq('id', b.dataset.anular));
    aviso('Venta anulada');
    historial();
  }));
}

// =====================================================================
// Pedidos por entregar
// =====================================================================

async function pedidos() {
  const lista = await q(sb.from('ventas')
    .select('id, fecha, tipo, total, fecha_compromiso, nota, cliente_id, clientes(nombre), venta_items(cantidad, precio, productos(nombre)), pagos(monto)')
    .eq('tipo', 'pedido').eq('entregado', false).order('fecha_compromiso'));

  pantalla('📋 Pedidos por entregar', lista.map(v => {
    const pagado = v.pagos.reduce((s, p) => s + n(p.monto), 0);
    const falta = n(v.total) - pagado;
    return tarjetaVenta(v, `
      <p class="nota">Adelantó ${bs(pagado)} · falta ${bs(falta)}</p>
      <div class="fila2">
        ${falta > 0.009 ? `<button class="primario" data-entregar="${v.id}" data-cobrar="${falta}" data-cliente="${v.cliente_id}">Entregado y pagó todo</button>` : ''}
        <button data-entregar="${v.id}">${falta > 0.009 ? 'Entregado (sigue debiendo)' : 'Entregado'}</button>
      </div>`);
  }).join('') || '<p class="tarjeta">No hay pedidos pendientes.</p>');

  $$('[data-entregar]').forEach(b => b.onclick = () => conEspera(b, async () => {
    if (b.dataset.cobrar) {
      await q(sb.from('pagos').insert({ cliente_id: +b.dataset.cliente, venta_id: +b.dataset.entregar, monto: n(b.dataset.cobrar) }));
    }
    await q(sb.from('ventas').update({ entregado: true }).eq('id', b.dataset.entregar));
    aviso('Pedido entregado ✔');
    pedidos();
  }));
}

// =====================================================================
// Productos
// =====================================================================

async function productos(id) {
  const lista = await q(sb.from('productos').select('*').order('activo', { ascending: false }).order('nombre'));
  const editando = id ? lista.find(p => p.id == id) : null;

  pantalla('🥤 Productos', `
    <form id="f" class="tarjeta">
      <b>${editando ? 'Editar producto' : 'Nuevo producto'}</b>
      <label>Nombre <input name="nombre" required value="${esc(editando?.nombre)}" placeholder="Ej: Schneider lata 473 ml"></label>
      <div class="fila2">
        <label>Unidad <select name="unidad">${Object.entries({ paq: 'Paquete', cja: 'Caja', fardo: 'Fardo', und: 'Unidad' })
          .map(([k, v]) => `<option value="${k}" ${editando?.unidad === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Precio general (Bs) <input name="precio_general" type="number" step="any" min="0" inputmode="decimal" value="${editando?.precio_general ?? ''}"></label>
      </div>
      ${editando ? `<label class="check"><input type="checkbox" name="activo" ${editando.activo ? 'checked' : ''}> Activo (se puede vender)</label>` : ''}
      <button class="btn primario grande">${editando ? 'Guardar cambios' : 'Agregar producto'}</button>
      ${editando ? '<a class="btn" href="#productos" style="width:100%;margin-top:8px">Cancelar</a>' : ''}
    </form>
    <div class="tarjeta">${lista.map(p => `
      <a class="item" href="#productos/${p.id}" style="text-decoration:none;color:inherit">
        <div class="info"><b>${esc(p.nombre)}</b><small>${unidad(p.unidad)}${p.activo ? '' : ' · inactivo'}</small></div>
        <div class="monto">${bs(p.precio_general)}</div></a>`).join('') || '<p class="nota">Sin productos.</p>'}
    </div>`, editando ? '#productos' : '#inicio');

  const form = $('#f');
  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button'), async () => {
      const d = datos(form);
      const fila = { nombre: d.nombre.trim(), unidad: d.unidad, precio_general: n(d.precio_general) };
      if (editando) await q(sb.from('productos').update({ ...fila, activo: !!d.activo }).eq('id', editando.id));
      else await q(sb.from('productos').insert(fila));
      aviso('Guardado ✔');
      location.hash = '#productos';
      if (!editando) productos();
    });
  };
}

// =====================================================================
// Clientes
// =====================================================================

async function clientes(id) {
  if (id) return cliente(id);
  const [lista, saldos] = await Promise.all([
    q(sb.from('clientes').select('*').order('nombre')),
    todas(() => sb.from('v_saldos').select('cliente_id, saldo')),
  ]);
  const saldo = Object.fromEntries(saldos.map(s => [s.cliente_id, n(s.saldo)]));

  pantalla('👥 Clientes', `
    <form id="f" class="tarjeta">
      <b>Nuevo cliente</b>
      <label>Nombre <input name="nombre" required></label>
      <div class="fila2">
        <label>Teléfono <input name="telefono" type="tel" inputmode="tel"></label>
        <label>Ya me debía (Bs) <input name="deuda_inicial" type="number" step="any" min="0" inputmode="decimal" value="0"></label>
      </div>
      <button class="btn primario grande">Agregar cliente</button>
    </form>
    <input id="buscar" placeholder="🔍 Buscar cliente">
    <div class="tarjeta" id="lista">${lista.map(c => `
      <a class="item" href="#clientes/${c.id}" data-nombre="${esc(c.nombre.toLowerCase())}" style="text-decoration:none;color:inherit">
        <div class="info"><b>${esc(c.nombre)}</b><small>${esc(c.telefono || '')}</small></div>
        <div class="monto ${saldo[c.id] > 0 ? 'negativo' : ''}">${saldo[c.id] > 0 ? bs(saldo[c.id]) : '—'}</div></a>`).join('') || '<p class="nota">Sin clientes.</p>'}
    </div>`);

  $('#buscar').oninput = () => {
    const t = $('#buscar').value.trim().toLowerCase();
    $$('#lista [data-nombre]').forEach(a => a.hidden = !a.dataset.nombre.includes(t));
  };
  const form = $('#f');
  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button'), async () => {
      const d = datos(form);
      await q(sb.from('clientes').insert({ nombre: d.nombre.trim(), telefono: d.telefono.trim() || null, deuda_inicial: n(d.deuda_inicial) }));
      aviso('Cliente guardado ✔');
      clientes();
    });
  };
}

async function cliente(id) {
  const [c, saldo, precios, ventas] = await Promise.all([
    q(sb.from('clientes').select('*').eq('id', id).single()),
    q(sb.from('v_saldos').select('saldo, compromiso').eq('cliente_id', id)),
    q(sb.from('precios_cliente').select('producto_id, precio, actualizado, productos(nombre, precio_general)').eq('cliente_id', id)),
    q(sb.from('ventas').select('id, fecha, tipo, total, fecha_compromiso, nota, clientes(nombre), venta_items(cantidad, precio, productos(nombre))')
      .eq('cliente_id', id).order('fecha', { ascending: false }).limit(15)),
  ]);
  const debe = n(saldo[0]?.saldo);

  pantalla(esc(c.nombre), `
    <div class="cifras"><div class="cifra"><small>Debe</small><b class="${debe > 0 ? 'negativo' : ''}">${bs(debe)}</b></div>
      <div class="cifra"><small>Paga hasta</small><b>${saldo[0]?.compromiso ? fecha(saldo[0].compromiso) : '—'}</b></div></div>
    <form id="f" class="tarjeta">
      <label>Nombre <input name="nombre" required value="${esc(c.nombre)}"></label>
      <div class="fila2">
        <label>Teléfono <input name="telefono" type="tel" value="${esc(c.telefono)}"></label>
        <label>Deuda anterior (Bs) <input name="deuda_inicial" type="number" step="any" min="0" value="${c.deuda_inicial}"></label>
      </div>
      <label>Notas <input name="notas" value="${esc(c.notas)}"></label>
      <button class="btn primario grande">Guardar</button>
    </form>
    <h3>Sus precios</h3>
    <div class="tarjeta">${precios.map(p => `
      <div class="item"><div class="info"><b>${esc(p.productos.nombre)}</b><small>General: ${bs(p.productos.precio_general)}</small></div>
        <div class="monto">${bs(p.precio)}</div></div>`).join('') || '<p class="nota">Se guardan solos cuando le vendes.</p>'}</div>
    <h3>Últimas ventas</h3>
    ${ventas.map(v => tarjetaVenta(v)).join('') || '<p class="tarjeta">Sin ventas.</p>'}`, '#clientes');

  const form = $('#f');
  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button'), async () => {
      const d = datos(form);
      await q(sb.from('clientes').update({
        nombre: d.nombre.trim(), telefono: d.telefono.trim() || null, deuda_inicial: n(d.deuda_inicial), notas: d.notas.trim() || null,
      }).eq('id', id));
      aviso('Guardado ✔');
      cliente(id);
    });
  };
}

// =====================================================================
// Más pantallas y arranque
// =====================================================================

function login() {
  app.innerHTML = `
    <div class="login">
      <h1>Mi Almacén</h1>
      <form id="f" class="tarjeta">
        <label>Correo <input name="email" type="email" autocomplete="username" required></label>
        <label>Contraseña <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primario grande">Entrar</button>
      </form>
    </div>`;
  const form = $('#f');
  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button'), async () => {
      const { error } = await sb.auth.signInWithPassword(datos(form));
      if (error) throw new Error('Correo o contraseña incorrectos');
      navegar();
    });
  };
}

const rutas = { inicio, llego, vender, cobrar, camion, gasto, stock, baja, historial, pedidos, productos, clientes };

async function navegar() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return login();
  const [ruta, param] = location.hash.slice(1).split('/');
  app.innerHTML = '<p class="cargando">Cargando…</p>';
  try {
    await (rutas[ruta] || inicio)(param);
  } catch (e) {
    pantalla('Algo salió mal', `<p class="tarjeta error">${esc(e.message || e)}</p><p class="nota">Revisa tu conexión a internet y vuelve a intentar.</p>`);
  }
  window.scrollTo(0, 0);
}

function arrancar() {
  if (!configurado) {
    app.innerHTML = `<div class="tarjeta"><h1>Falta configurar</h1>
      <p>Abre <b>js/config.js</b> y pega la URL y la anon key de tu proyecto de Supabase.</p></div>`;
    return;
  }
  navegar();
}

if (configurado) window.addEventListener('hashchange', navegar);
arrancar();
