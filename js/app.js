import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { icono } from './iconos.js';
import { opcionesCatalogo, nombreProducto, clave } from './catalogo.js';

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

const leer = (k, defecto) => { try { return localStorage.getItem(k) ?? defecto; } catch { return defecto; } };
const guardar = (k, valor) => { try { localStorage.setItem(k, valor); } catch { /* sin almacenamiento */ } };

function pantalla(ico, titulo, html, volver = '#inicio') {
  app.innerHTML = `
    ${volver ? `<a class="volver" href="${volver}">${icono('volver')} Volver</a>` : ''}
    <h1>${ico ? icono(ico) : ''}${titulo}</h1>
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

// Productos que hay en stock, listos para el selector
async function opcionesConStock() {
  const [productos, stock] = await Promise.all([
    q(sb.from('productos').select('*').eq('activo', true)),
    stockDisponible(),
  ]);
  const opciones = productos.filter(p => stock.porProducto[p.id]).map(p => ({
    producto_id: p.id,
    marca: p.marca || p.nombre,
    presentacion: p.presentacion || '',
    sabor: p.sabor || '',
    unidad: p.unidad,
    precio: n(p.precio_general) || null,
    stock: stock.porProducto[p.id].restante,
    costo: stock.porProducto[p.id].costoPrimero,
    nombre: p.nombre,
  }));
  return { opciones, stock, productos };
}

// =====================================================================
// Selector por toques: Marca → Presentación → Sabor
// =====================================================================

function selector(cont, opciones, { alElegir, conStock = false, otro = null }) {
  let marca = null;
  let pres = null;
  let elegida = null;

  const unicas = lista => [...new Set(lista)];
  const suma = lista => lista.reduce((s, o) => s + n(o.stock), 0);
  const ordenar = (a, b) => a.localeCompare(b, 'es', { numeric: true });
  const chip = (accion, valor, texto, extra = '') =>
    `<button type="button" class="opcion" data-accion="${accion}" data-valor="${esc(valor)}">${esc(texto)}${extra ? `<small>${extra}</small>` : ''}</button>`;
  const stockDe = lista => conStock ? `quedan ${cant(suma(lista))}` : '';

  function dibujar() {
    const deMarca = opciones.filter(o => o.marca === marca);
    const dePres = deMarca.filter(o => o.presentacion === pres);
    let migas = '';
    let titulo;
    let botones;

    if (marca) migas += `<button type="button" class="miga" data-accion="ir-todas">Marcas</button><span>›</span><button type="button" class="miga" data-accion="ir-marca">${esc(marca)}</button>`;
    if (pres !== null && pres !== '') migas += `<span>›</span><button type="button" class="miga" data-accion="ir-pres">${esc(pres)}</button>`;

    if (elegida) {
      titulo = 'Producto elegido';
      botones = `<div class="elegido">${icono('ok')} ${esc(nombreProducto(elegida))}
        <button type="button" class="chico" data-accion="ir-sabor">Cambiar</button></div>`;
    } else if (!marca) {
      titulo = 'Marca';
      botones = unicas(opciones.map(o => o.marca)).sort(ordenar)
        .map(m => chip('marca', m, m, stockDe(opciones.filter(o => o.marca === m)))).join('')
        + (otro ? `<button type="button" class="opcion otro" data-accion="otro">${icono('mas')} Otro producto</button>` : '');
    } else if (pres === null) {
      titulo = 'Presentación';
      botones = unicas(deMarca.map(o => o.presentacion)).sort(ordenar)
        .map(p => chip('pres', p, p, stockDe(deMarca.filter(o => o.presentacion === p)))).join('');
    } else {
      titulo = 'Sabor';
      botones = dePres.map((o, i) => chip('sabor', i, o.sabor || 'Único', conStock ? `quedan ${cant(o.stock)}` : '')).join('');
    }

    cont.innerHTML = `
      ${migas ? `<div class="migas">${migas}</div>` : ''}
      <p class="paso">${titulo}</p>
      <div class="opciones">${botones || '<p class="nota">No hay productos.</p>'}</div>`;
  }

  function avanzar() {
    elegida = null;
    if (marca && pres === null) {
      const ps = unicas(opciones.filter(o => o.marca === marca).map(o => o.presentacion));
      if (ps.length === 1) pres = ps[0];
    }
    if (marca && pres !== null) {
      const dePres = opciones.filter(o => o.marca === marca && o.presentacion === pres);
      if (dePres.length === 1) return elegir(dePres[0]);
    }
    dibujar();
  }

  function elegir(o) {
    elegida = o;
    dibujar();
    alElegir(o);
  }

  cont.onclick = e => {
    const b = e.target.closest('[data-accion]');
    if (!b) return;
    const { accion, valor } = b.dataset;
    if (accion === 'marca') { marca = valor; pres = null; avanzar(); }
    else if (accion === 'pres') { pres = valor; avanzar(); }
    else if (accion === 'sabor') elegir(opciones.filter(o => o.marca === marca && o.presentacion === pres)[+valor]);
    else if (accion === 'ir-todas') { marca = null; pres = null; elegida = null; dibujar(); alElegir(null); }
    else if (accion === 'ir-marca') { pres = null; elegida = null; dibujar(); alElegir(null); }
    else if (accion === 'ir-pres' || accion === 'ir-sabor') { elegida = null; dibujar(); alElegir(null); }
    else if (accion === 'otro') otro();
  };

  dibujar();
  return {
    // Después de agregar un producto, volver a los sabores de la misma presentación
    reiniciar() {
      elegida = null;
      const quedan = opciones.filter(o => o.marca === marca && o.presentacion === pres);
      if (quedan.length <= 1) { marca = null; pres = null; }
      dibujar();
    },
    actualizar(nuevas) { opciones = nuevas; },
  };
}

// Cantidad con botones grandes de − y +
const campoCantidad = (rotulo, nombre = 'cantidad', valor = '') => `
  <div class="campo">
    <span class="rotulo">${rotulo}</span>
    <div class="stepper">
      <button type="button" data-paso="-1" aria-label="Menos">${icono('menos')}</button>
      <input name="${nombre}" type="number" step="any" min="0" inputmode="decimal" value="${valor}" aria-label="${rotulo}">
      <button type="button" data-paso="1" aria-label="Más">${icono('mas')}</button>
    </div>
    <div class="rapidos">${[5, 10, 20, 50].map(v => `<button type="button" class="chico" data-suma="${v}">+${v}</button>`).join('')}</div>
  </div>`;

function activarCantidad(cont, alCambiar = () => {}) {
  cont.addEventListener('click', e => {
    const b = e.target.closest('[data-paso],[data-suma]');
    if (!b) return;
    const input = b.closest('.campo').querySelector('input');
    const nuevo = Math.max(0, n(input.value) + n(b.dataset.paso ?? b.dataset.suma));
    input.value = nuevo;
    alCambiar();
  });
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
    viaje && `<a class="alerta verde" href="#camion">${icono('camion')}<span>El camión está en ruta desde ${fechaHora(viaje.salida)}. Toca aquí al regresar.</span></a>`,
    porVencer.length && `<a class="alerta roja" href="#stock">${icono('alerta')}<span>${porVencer.length} lote(s) vencen en 30 días o menos (${bs(valorPorVencer)}). ¡Véndelos primero!</span></a>`,
    atrasados && `<a class="alerta roja" href="#cobrar">${icono('cobrar')}<span>${atrasados} cliente(s) pasaron su fecha de pago.</span></a>`,
    pedidos.length && `<a class="alerta amarilla" href="#pedidos">${icono('pedidos')}<span>${pedidos.length} pedido(s) por entregar.</span></a>`,
  ].filter(Boolean).join('');

  app.innerHTML = `
    <h1>Mi Almacén</h1>
    <div class="menu">
      <a class="ancho" href="#vender">${icono('vender')} VENDER</a>
      <a href="#llego">${icono('llego')}Llegó mercadería</a>
      <a href="#cobrar">${icono('cobrar')}Cobrar</a>
      <a href="#camion">${icono('camion')}Camión</a>
      <a href="#gasto">${icono('gasto')}Gasto</a>
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
      <a href="#stock">${icono('stock')}Stock y vencimientos</a>
      <a href="#historial">${icono('ventas')}Ventas</a>
      <a href="#pedidos">${icono('pedidos')}Pedidos</a>
      <a href="#clientes">${icono('clientes')}Clientes</a>
      <a href="#productos">${icono('productos')}Productos</a>
      <a href="#baja">${icono('baja')}Pinchadas / bajas</a>
    </div>
    <button class="btn" id="salir" style="width:100%">${icono('salir')} Cerrar sesión</button>`;

  $$('[data-periodo]').forEach(b => b.onclick = () => { guardar('periodo', b.dataset.periodo); inicio(); });
  $('#salir').onclick = async () => { await sb.auth.signOut(); login(); };
}

// =====================================================================
// Llegó mercadería: varios productos en una sola llegada
// =====================================================================

async function llego() {
  const [productos, ultimosLotes, recientes] = await Promise.all([
    q(sb.from('productos').select('*')),
    q(sb.from('lotes').select('producto_id, costo_unit').order('id', { ascending: false }).limit(500)),
    q(sb.from('v_stock_lotes').select('*').order('id', { ascending: false }).limit(10)),
  ]);

  // Último costo pagado por producto
  const ultimoCosto = {};
  for (const l of ultimosLotes) ultimoCosto[l.producto_id] ??= n(l.costo_unit);

  // Catálogo + productos ya registrados (los registrados mandan)
  const porClave = new Map(opcionesCatalogo().map(o => [clave(o), { ...o, sabor: o.sabor || '' }]));
  for (const p of productos.filter(p => p.activo)) {
    const o = { marca: p.marca || p.nombre, presentacion: p.presentacion || '', sabor: p.sabor || '' };
    const k = clave(o);
    const base = porClave.get(k) || {};
    porClave.set(k, {
      ...base, ...o, producto_id: p.id, unidad: p.unidad,
      precio: n(p.precio_general) || base.precio || null,
      costo: ultimoCosto[p.id] ?? base.costo ?? null,
    });
  }
  let opciones = [...porClave.values()];

  const lineas = [];
  let actual = null;
  let sel;

  pantalla('llego', 'Llegó mercadería', `
    <div class="tarjeta" id="sel"></div>
    <div id="nuevo"></div>
    <form id="linea" class="tarjeta" hidden autocomplete="off">
      <p class="paso" id="linea-nombre"></p>
      ${campoCantidad('Cantidad pagada', 'cant_pagada')}
      ${campoCantidad('De regalo (bonificación de la empresa)', 'cant_regalo', 0)}
      <div class="fila2">
        <label>Costo por unidad (Bs) <input name="costo_unit" type="number" step="any" min="0" inputmode="decimal" required></label>
        <label>Vence el <input name="vencimiento" type="date"></label>
      </div>
      <label id="campo-precio">Precio de venta general (Bs) <input name="precio" type="number" step="any" min="0" inputmode="decimal"></label>
      <button class="btn primario grande">${icono('mas')} Agregar a esta llegada</button>
    </form>
    <div class="tarjeta" id="llegada"></div>
    <h3>Últimos lotes</h3>
    <div class="tarjeta">${recientes.length ? recientes.map(l => `
      <div class="item">
        <div class="info"><b>${esc(l.producto)}</b>
          <small>${fecha(l.fecha)} · ${cant(n(l.cant_pagada) + n(l.cant_regalo))} ${unidad(l.unidad)}${n(l.cant_regalo) ? ` (${cant(l.cant_regalo)} de regalo)` : ''} · quedan ${cant(l.restante)}</small>
          ${etiquetaVence(l.vencimiento)}
        </div>
        <div class="monto">${bs(l.costo_real)}<small class="nota">/u</small></div>
      </div>`).join('') : '<p class="nota">Todavía no hay lotes.</p>'}
    </div>`);

  const form = $('#linea');
  activarCantidad(form);

  const elegir = o => {
    actual = o;
    form.hidden = !o;
    if (!o) return;
    $('#linea-nombre').textContent = `${nombreProducto(o)} · ${unidad(o.unidad)}`;
    form.cant_pagada.value = '';
    form.cant_regalo.value = 0;
    form.costo_unit.value = o.costo ?? '';
    form.vencimiento.value = lineas.at(-1)?.vencimiento || '';
    form.precio.value = o.precio ?? '';
    $('#campo-precio').hidden = !!o.producto_id && !!o.precio;
    form.cant_pagada.focus();
  };

  const otro = () => {
    $('#nuevo').innerHTML = `
      <form class="tarjeta" id="form-nuevo" autocomplete="off">
        <p class="paso">Producto nuevo</p>
        <div class="fila2">
          <label>Marca <input name="marca" required placeholder="Ej: Coca-Cola"></label>
          <label>Presentación <input name="presentacion" required placeholder="Ej: 2 L, Lata 473 ml"></label>
        </div>
        <div class="fila2">
          <label>Sabor (opcional) <input name="sabor" placeholder="Ej: Naranja"></label>
          <label>Se cuenta por
            <select name="unidad"><option value="paq">Paquete</option><option value="cja">Caja</option>
              <option value="fardo">Fardo</option><option value="und">Unidad</option></select></label>
        </div>
        <button class="btn primario grande">Usar este producto</button>
      </form>`;
    const f = $('#form-nuevo');
    f.marca.focus();
    f.onsubmit = e => {
      e.preventDefault();
      const d = datos(f);
      const o = { marca: d.marca.trim(), presentacion: d.presentacion.trim(), sabor: d.sabor.trim(), unidad: d.unidad, costo: null, precio: null };
      const existente = opciones.find(x => clave(x) === clave(o));
      $('#nuevo').innerHTML = '';
      if (!existente) { opciones.push(o); sel.actualizar(opciones); }
      elegir(existente || o);
      form.scrollIntoView({ behavior: 'smooth' });
    };
  };

  sel = selector($('#sel'), opciones, { alElegir: elegir, otro });

  const dibujarLlegada = () => {
    const valor = lineas.reduce((s, l) => s + l.cant_pagada * l.costo_unit, 0);
    $('#llegada').innerHTML = lineas.length ? `
      <p class="paso">Esta llegada (${lineas.length} producto${lineas.length > 1 ? 's' : ''})</p>
      ${lineas.map((l, i) => `
        <div class="item">
          <div class="info"><b>${esc(nombreProducto(l))}</b>
            <small>${cant(l.cant_pagada)}${l.cant_regalo ? ` + ${cant(l.cant_regalo)} de regalo` : ''} × ${bs(l.costo_unit)}${l.vencimiento ? ' · vence ' + fecha(l.vencimiento) : ''}</small></div>
          <div class="monto">${bs(l.cant_pagada * l.costo_unit)}</div>
          <button class="chico peligro" data-quitar="${i}" aria-label="Quitar">${icono('cerrar')}</button>
        </div>`).join('')}
      <div class="fila2">
        <label>Proveedor <input id="proveedor" value="${esc(leer('proveedor', lineas[0].proveedor || 'BBO'))}"></label>
        <label>Fecha de llegada <input id="fecha" type="date" value="${hoy()}"></label>
      </div>
      <label>Flete y gastos de toda la llegada (Bs) <input id="flete" type="number" step="any" min="0" inputmode="decimal" value="0"></label>
      <p class="nota">El flete se reparte solo entre los productos, según lo que costó cada uno.</p>
      <ul class="lineas"><li class="total"><span>Total pagado</span><b id="total-llegada">${bs(valor)}</b></li></ul>
      <button class="btn primario grande" id="guardar">${icono('ok')} Guardar llegada</button>`
      : '<p class="nota">Elige un producto arriba, pon cuánto llegó y agrégalo. Puedes agregar varios antes de guardar.</p>';

    $$('[data-quitar]').forEach(b => b.onclick = () => { lineas.splice(+b.dataset.quitar, 1); dibujarLlegada(); });
    if (!lineas.length) return;
    $('#flete').oninput = () => ($('#total-llegada').textContent = bs(valor + n($('#flete').value)));
    $('#guardar').onclick = () => conEspera($('#guardar'), guardarLlegada);
  };

  form.onsubmit = e => {
    e.preventDefault();
    const d = datos(form);
    if (n(d.cant_pagada) + n(d.cant_regalo) <= 0) return aviso('Pon la cantidad que llegó', true);
    lineas.push({
      ...actual,
      cant_pagada: n(d.cant_pagada),
      cant_regalo: n(d.cant_regalo),
      costo_unit: n(d.costo_unit),
      vencimiento: d.vencimiento || null,
      precio: n(d.precio) || actual.precio || 0,
    });
    form.hidden = true;
    sel.reiniciar();
    dibujarLlegada();
    aviso(`${nombreProducto(actual)} agregado`);
    actual = null;
  };

  async function guardarLlegada() {
    // Leer todo antes de guardar: si cambia la pantalla a mitad de camino, igual se guarda bien
    const flete = n($('#flete').value);
    const valor = lineas.reduce((s, l) => s + l.cant_pagada * l.costo_unit, 0);
    const proveedor = $('#proveedor').value.trim();
    const fechaLlegada = $('#fecha').value || hoy();

    // Crear los productos que todavía no existen
    for (const l of lineas) {
      if (l.producto_id) continue;
      const ya = productos.find(p => clave({ marca: p.marca || p.nombre, presentacion: p.presentacion || '', sabor: p.sabor || '' }) === clave(l));
      if (ya) { l.producto_id = ya.id; continue; }
      const nuevo = await q(sb.from('productos').insert({
        nombre: nombreProducto(l), marca: l.marca, presentacion: l.presentacion || null, sabor: l.sabor || null,
        unidad: l.unidad, precio_general: n(l.precio),
      }).select().single());
      productos.push(nuevo);
      l.producto_id = nuevo.id;
    }

    // Repartir el flete según el valor de cada producto (el último se lleva el redondeo)
    let repartido = 0;
    const filas = lineas.map((l, i) => {
      const parte = i === lineas.length - 1
        ? Math.round((flete - repartido) * 100) / 100
        : Math.round(flete * (valor ? (l.cant_pagada * l.costo_unit) / valor : 1 / lineas.length) * 100) / 100;
      repartido += parte;
      return {
        producto_id: l.producto_id, fecha: fechaLlegada, proveedor: proveedor || null,
        cant_pagada: l.cant_pagada, cant_regalo: l.cant_regalo, costo_unit: l.costo_unit,
        flete: parte, vencimiento: l.vencimiento,
      };
    });
    await q(sb.from('lotes').insert(filas));

    // Si se puso precio a un producto que no tenía, guardarlo
    for (const l of lineas) {
      const p = productos.find(x => x.id === l.producto_id);
      if (p && !n(p.precio_general) && n(l.precio)) {
        await q(sb.from('productos').update({ precio_general: n(l.precio) }).eq('id', p.id));
      }
    }
    guardar('proveedor', proveedor);
    aviso(`Llegada guardada: ${lineas.length} producto(s)`);
    llego();
  }

  dibujarLlegada();
}

// =====================================================================
// Vender
// =====================================================================

async function vender() {
  const [{ opciones }, clientes, recientes, viaje] = await Promise.all([
    opcionesConStock(),
    q(sb.from('clientes').select('id, nombre').eq('activo', true).order('nombre')),
    q(sb.from('ventas').select('cliente_id').not('cliente_id', 'is', null).order('id', { ascending: false }).limit(300)),
    viajeAbierto(),
  ]);
  const buscarCliente = nombre => clientes.find(c => c.nombre.trim().toLowerCase() === nombre.trim().toLowerCase());

  // Clientes que más compran últimamente, para tocarlos sin escribir
  const veces = {};
  for (const v of recientes) veces[v.cliente_id] = (veces[v.cliente_id] || 0) + 1;
  const frecuentes = clientes.filter(c => veces[c.id]).sort((a, b) => veces[b.id] - veces[a.id]).slice(0, 8);

  let items = [];
  let tipo = 'contado';
  let preciosCliente = {};
  let actual = null;
  let sel;

  pantalla('vender', 'Vender', `
    <div class="tarjeta">
      <label>Cliente
        <input id="cliente" list="lista-cli" placeholder="Nombre (vacío = cliente de paso)" autocomplete="off">
      </label>
      <datalist id="lista-cli">${clientes.map(c => `<option value="${esc(c.nombre)}">`).join('')}</datalist>
      ${frecuentes.length ? `<div class="opciones compacto">${frecuentes.map(c => `<button type="button" class="opcion" data-cliente="${esc(c.nombre)}">${esc(c.nombre)}</button>`).join('')}</div>` : ''}
      <p class="nota" id="nota-cliente"></p>
    </div>
    <div class="tarjeta" id="sel"></div>
    <form id="agregar" class="tarjeta" hidden autocomplete="off">
      <p class="paso" id="prod-nombre"></p>
      ${campoCantidad('Cantidad')}
      <label>Precio por unidad (Bs) <input name="precio" type="number" step="any" min="0" inputmode="decimal" required></label>
      <p class="nota" id="nota-precio"></p>
      <button class="btn primario grande">${icono('mas')} Agregar</button>
    </form>
    <div class="tarjeta" id="carrito"></div>
    <div class="tarjeta">
      <p class="paso">¿Cómo paga?</p>
      <div class="tipos">
        <button data-tipo="contado" class="activo">${icono('cobrar')} Contado</button>
        <button data-tipo="fiado">${icono('fiado')} Fiado</button>
        <button data-tipo="pedido">${icono('calendario')} Pedido</button>
        <button data-tipo="regalo">${icono('regalo')} Regalo</button>
      </div>
      <div id="extra"></div>
      ${viaje ? '<label class="check"><input type="checkbox" id="desde-camion" checked> Venta desde el camión</label>' : ''}
      <label>Nota <input id="nota" placeholder="opcional"></label>
      <button class="btn primario grande" id="guardar">${icono('ok')} Guardar venta</button>
    </div>`);

  const form = $('#agregar');
  activarCantidad(form);
  const yaEnCarrito = id => items.filter(i => i.producto_id === id).reduce((s, i) => s + i.cantidad, 0);

  const sugerirPrecio = () => {
    if (!actual) return;
    const especial = preciosCliente[actual.producto_id];
    form.precio.value = especial ?? actual.precio ?? '';
    $('#nota-precio').innerHTML = (especial != null ? 'Precio que le diste a este cliente la última vez.'
      : actual.precio ? 'Precio general.' : 'Este producto no tiene precio general: escríbelo.') + ` Costo: ${bs(actual.costo)}.`;
  };

  const elegir = o => {
    actual = o;
    form.hidden = !o;
    if (!o) return;
    $('#prod-nombre').textContent = `${nombreProducto(o)} · quedan ${cant(o.stock - yaEnCarrito(o.producto_id))} ${unidad(o.unidad)}`;
    form.cantidad.value = '';
    sugerirPrecio();
  };
  sel = selector($('#sel'), opciones, { alElegir: elegir, conStock: true });

  const elegirCliente = async () => {
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
    sugerirPrecio();
  };
  $('#cliente').oninput = elegirCliente;
  $$('[data-cliente]').forEach(b => b.onclick = () => { $('#cliente').value = b.dataset.cliente; elegirCliente(); });

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
          <button class="chico peligro" data-quitar="${k}" aria-label="Quitar">${icono('cerrar')}</button>
        </div>`).join('')}
      <ul class="lineas">
        <li class="total"><span>Total</span><b>${bs(tipo === 'regalo' ? 0 : total)}</b></li>
        ${tipo === 'regalo' ? '' : `<li><span>Ganancia de esta venta</span><b class="${ganancia >= 0 ? 'positivo' : 'negativo'}">${bs(ganancia)}</b></li>`}
      </ul>` : '<p class="nota">Elige los productos arriba.</p>';
    $$('[data-quitar]').forEach(b => b.onclick = () => { items.splice(+b.dataset.quitar, 1); dibujarCarrito(); });
  };

  form.onsubmit = e => {
    e.preventDefault();
    const disponible = actual.stock - yaEnCarrito(actual.producto_id);
    const cantidad = n(form.cantidad.value);
    const precio = n(form.precio.value);
    if (cantidad <= 0) return aviso('Pon una cantidad', true);
    if (cantidad > disponible + 1e-9) return aviso(`Solo quedan ${cant(disponible)} de ${nombreProducto(actual)}`, true);
    if (tipo !== 'regalo' && precio < actual.costo &&
        !confirm(`Estás vendiendo a ${bs(precio)} y te costó ${bs(actual.costo)}. Vas a perder plata. ¿Seguro?`)) return;
    items.push({ producto_id: actual.producto_id, nombre: nombreProducto(actual), cantidad, precio, costo: actual.costo });
    form.hidden = true;
    actual = null;
    sel.reiniciar();
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
    // Leer todo antes de guardar: si cambia la pantalla a mitad de camino, igual se guarda bien
    const venta = {
      tipo,
      fecha_compromiso: $('#compromiso')?.value || null,
      viaje_id: viaje && $('#desde-camion')?.checked ? viaje.id : null,
      pagado: n($('#pagado')?.value),
      nota: $('#nota').value.trim() || null,
      items: items.map(({ producto_id, cantidad, precio }) => ({ producto_id, cantidad, precio })),
    };
    let cliente = nombre ? buscarCliente(nombre) : null;
    if (nombre && !cliente) cliente = await q(sb.from('clientes').insert({ nombre }).select().single());
    const total = items.reduce((s, i) => s + i.cantidad * i.precio, 0);
    await q(sb.rpc('registrar_venta', { p: { ...venta, cliente_id: cliente?.id ?? null } }));
    aviso(tipo === 'regalo' ? 'Regalo guardado' : `Venta guardada: ${bs(total)}`);
    vender();
  });

  dibujarCarrito();
  if (!opciones.length) $('#sel').innerHTML = '<p class="nota">No hay stock. Registra lo que llega en "Llegó mercadería".</p>';
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

  pantalla('cobrar', 'Cobrar', `
    <div class="cifras"><div class="cifra"><small>Me deben en total</small><b>${bs(total)}</b></div>
      <div class="cifra"><small>Clientes que deben</small><b>${saldos.length}</b></div></div>
    ${saldos.length > 5 ? `<label class="buscador">${icono('buscar')}<input id="buscar" placeholder="Buscar cliente"></label>` : ''}
    ${saldos.map(c => {
      const atrasado = c.compromiso && c.compromiso < hoy();
      const tel = (c.telefono || '').replace(/\D/g, '');
      const wa = tel ? `https://wa.me/${tel.length === 8 ? '591' + tel : tel}?text=${encodeURIComponent(
        `Hola ${c.nombre}, te recuerdo tu saldo pendiente de ${bs(c.saldo)}. Gracias.`)}` : '';
      return `
      <div class="tarjeta" data-nombre="${esc(c.nombre.toLowerCase())}">
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
        <div class="rapidos"><button type="button" class="chico" data-todo="${c.saldo}">Pagó todo</button>
          ${wa ? `<a class="btn chico" href="${wa}" target="_blank" rel="noopener">${icono('mensaje')} Recordar por WhatsApp</a>` : ''}</div>
      </div>`;
    }).join('') || '<p class="tarjeta">Nadie te debe.</p>'}
    ${viaje ? '<label class="check"><input type="checkbox" id="desde-camion" checked> Cobros hechos en la ruta del camión</label>' : ''}`);

  if ($('#buscar')) $('#buscar').oninput = () => {
    const t = $('#buscar').value.trim().toLowerCase();
    $$('[data-nombre]').forEach(el => (el.hidden = !el.dataset.nombre.includes(t)));
  };
  $$('[data-todo]').forEach(b => b.onclick = () => {
    b.closest('.tarjeta').querySelector('input[name=monto]').value = n(b.dataset.todo).toFixed(2);
  });
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
      aviso(`Cobro de ${bs(monto)} guardado`);
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
  const [{ opciones }, anteriores] = await Promise.all([
    opcionesConStock(),
    q(sb.from('viajes').select('*').not('regreso', 'is', null).order('id', { ascending: false }).limit(5)),
  ]);
  const carga = [];
  let actual = null;
  let sel;

  pantalla('camion', 'Cargar camión', `
    <p class="nota">Anota lo que sube al camión. Al volver cuentas lo que regresó y la app te dice qué falta.</p>
    <div class="tarjeta" id="sel"></div>
    <form id="agregar" class="tarjeta" hidden autocomplete="off">
      <p class="paso" id="prod-nombre"></p>
      ${campoCantidad('Cantidad que sube')}
      <button class="btn primario grande">${icono('mas')} Subir al camión</button>
    </form>
    <div class="tarjeta" id="carga"></div>
    <h3>Viajes anteriores</h3>
    <div class="tarjeta">${anteriores.length ? anteriores.map(v => {
      const dif = n(v.efectivo_entregado) - n(v.efectivo_esperado);
      return `<div class="item"><div class="info"><b>${fechaHora(v.salida)}</b>
        <small>Debía traer ${bs(v.efectivo_esperado)} · trajo ${bs(v.efectivo_entregado)}</small></div>
        <div class="monto ${Math.abs(dif) < 0.01 ? 'positivo' : 'negativo'}">${Math.abs(dif) < 0.01 ? 'Cuadra' : bs(dif)}</div></div>`;
    }).join('') : '<p class="nota">Sin viajes todavía.</p>'}</div>`);

  const form = $('#agregar');
  activarCantidad(form);
  const cargado = id => carga.filter(c => c.producto_id === id).reduce((s, c) => s + c.cantidad, 0);

  sel = selector($('#sel'), opciones, {
    conStock: true,
    alElegir: o => {
      actual = o;
      form.hidden = !o;
      if (!o) return;
      $('#prod-nombre').textContent = `${nombreProducto(o)} · hay ${cant(o.stock - cargado(o.producto_id))} ${unidad(o.unidad)}`;
      form.cantidad.value = '';
    },
  });

  const dibujarCarga = () => {
    $('#carga').innerHTML = carga.length ? `
      <p class="paso">Sube al camión</p>
      ${carga.map((c, i) => `<div class="item"><div class="info"><b>${esc(c.nombre)}</b></div>
        <div class="monto">${cant(c.cantidad)}</div>
        <button class="chico peligro" data-quitar="${i}" aria-label="Quitar">${icono('cerrar')}</button></div>`).join('')}
      <button class="btn primario grande" id="salir-camion">${icono('camion')} Salió el camión</button>`
      : '<p class="nota">Elige los productos que suben al camión.</p>';
    $$('[data-quitar]').forEach(b => b.onclick = () => { carga.splice(+b.dataset.quitar, 1); dibujarCarga(); });
    if (carga.length) $('#salir-camion').onclick = () => conEspera($('#salir-camion'), async () => {
      const viaje = await q(sb.from('viajes').insert({}).select().single());
      const filas = {};
      for (const c of carga) filas[c.producto_id] = (filas[c.producto_id] || 0) + c.cantidad;
      try {
        await q(sb.from('viaje_carga').insert(Object.entries(filas).map(([id, c]) => ({ viaje_id: viaje.id, producto_id: +id, cargado: c }))));
      } catch (err) {
        await sb.from('viajes').delete().eq('id', viaje.id);
        throw err;
      }
      aviso('Camión en ruta');
      camion();
    });
  };

  form.onsubmit = e => {
    e.preventDefault();
    const cantidad = n(form.cantidad.value);
    const hay = actual.stock - cargado(actual.producto_id);
    if (cantidad <= 0) return aviso('Pon una cantidad', true);
    if (cantidad > hay + 1e-9) return aviso(`Solo hay ${cant(hay)}`, true);
    carga.push({ producto_id: actual.producto_id, nombre: nombreProducto(actual), cantidad });
    form.hidden = true;
    actual = null;
    sel.reiniciar();
    dibujarCarga();
  };
  dibujarCarga();
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

  pantalla('camion', 'Camión en ruta', `
    <p class="nota">Salió: ${fechaHora(viaje.salida)} · Las ventas marcadas "desde el camión" se van sumando aquí.</p>
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
      <button class="btn primario grande">${icono('ok')} Regresó el camión</button>
    </form>
    ${vendidos.length ? '' : `<button class="btn peligro" id="cancelar" style="width:100%">${icono('cerrar')} Cancelar esta salida</button>`}`);

  const revisar = () => {
    const faltan = $$('[data-producto]').map(i => ({
      nombre: carga.find(c => c.producto_id == i.dataset.producto).productos.nombre,
      falta: n(i.dataset.debe) - n(i.value),
    })).filter(x => x.falta > 0);
    $('#faltantes').innerHTML = faltan.length
      ? '<b class="negativo">Falta:</b> ' + faltan.map(x => `${esc(x.nombre)}: ${cant(x.falta)}`).join(' · ')
      : '';
    const dif = n($('#efectivo').value) - esperado;
    $('#dif-plata').innerHTML = Math.abs(dif) < 0.01 ? '<span class="positivo">La plata cuadra</span>'
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
      aviso('Viaje cerrado');
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

  pantalla('gasto', 'Gasto', `
    <form id="f" class="tarjeta">
      <p class="paso">¿En qué se gastó?</p>
      <div class="tipos">${CATEGORIAS.map((c, i) => `<button type="button" data-cat="${esc(c)}" class="${i === 0 ? 'activo' : ''}">${esc(c)}</button>`).join('')}</div>
      <div class="fila2">
        <label>Monto (Bs) <input name="monto" type="number" step="any" min="0" inputmode="decimal" required></label>
        <label>Fecha <input name="fecha" type="date" value="${hoy()}" required></label>
      </div>
      <label>Detalle <input name="nota" placeholder="opcional"></label>
      <button class="btn primario grande">${icono('ok')} Guardar gasto</button>
    </form>
    <h3>Gastos de este mes · ${bs(total)}</h3>
    <div class="tarjeta">${gastos.map(g => `
      <div class="item"><div class="info"><b>${esc(g.categoria)}</b><small>${fecha(g.fecha)}${g.nota ? ' · ' + esc(g.nota) : ''}</small></div>
        <div class="monto">${bs(g.monto)}</div>
        <button class="chico peligro" data-borrar="${g.id}" aria-label="Borrar">${icono('cerrar')}</button></div>`).join('') || '<p class="nota">Sin gastos este mes.</p>'}
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
      aviso('Gasto guardado');
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
  const lista = Object.values(porProducto).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
  const total = lista.reduce((s, p) => s + p.valor, 0);

  pantalla('stock', 'Stock y vencimientos', `
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
            <button class="chico peligro" data-borrar="${l.id}" aria-label="Borrar lote">${icono('cerrar')}</button></div>`).join('')}
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

const MOTIVOS = { pinchada: 'Pinchada / rota', vencida: 'Vencida', otro: 'Otro' };

async function baja() {
  const [{ opciones }, recientes] = await Promise.all([
    opcionesConStock(),
    q(sb.from('bajas').select('*, productos(nombre)').order('id', { ascending: false }).limit(15)),
  ]);
  let actual = null;
  let motivo = 'pinchada';

  pantalla('baja', 'Pinchadas / bajas', `
    <p class="nota">Opcional: los faltantes del camión se cuentan solos al regresar.</p>
    <div class="tarjeta" id="sel"></div>
    <form id="f" class="tarjeta" hidden autocomplete="off">
      <p class="paso" id="prod-nombre"></p>
      ${campoCantidad('Cantidad')}
      <p class="paso">Motivo</p>
      <div class="tipos">${Object.entries(MOTIVOS).map(([k, v]) => `<button type="button" data-motivo="${k}" class="${k === motivo ? 'activo' : ''}">${v}</button>`).join('')}</div>
      <label>Nota <input name="nota" placeholder="opcional"></label>
      <button class="btn primario grande">${icono('baja')} Dar de baja</button>
    </form>
    <h3>Últimas bajas</h3>
    <div class="tarjeta">${recientes.map(b => `
      <div class="item"><div class="info"><b>${esc(b.productos.nombre)}</b>
        <small>${fechaHora(b.fecha)} · ${esc(MOTIVOS[b.motivo] || b.motivo)} · ${cant(b.cantidad)}${b.nota ? ' · ' + esc(b.nota) : ''}</small></div>
        <div class="monto negativo">${bs(n(b.cantidad) * n(b.costo))}</div>
        <button class="chico peligro" data-borrar="${b.id}" aria-label="Deshacer">${icono('cerrar')}</button></div>`).join('') || '<p class="nota">Sin bajas.</p>'}
    </div>`);

  const form = $('#f');
  activarCantidad(form);
  selector($('#sel'), opciones, {
    conStock: true,
    alElegir: o => {
      actual = o;
      form.hidden = !o;
      if (o) $('#prod-nombre').textContent = `${nombreProducto(o)} · hay ${cant(o.stock)} ${unidad(o.unidad)}`;
    },
  });
  $$('[data-motivo]').forEach(b => b.onclick = () => {
    motivo = b.dataset.motivo;
    $$('[data-motivo]').forEach(x => x.classList.toggle('activo', x === b));
  });
  form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button.primario'), async () => {
      const cantidad = n(form.cantidad.value);
      if (cantidad <= 0) throw new Error('Pon una cantidad');
      await q(sb.rpc('registrar_baja', { p_producto: actual.producto_id, p_cantidad: cantidad, p_motivo: motivo, p_nota: form.nota.value.trim() || null }));
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

  pantalla('ventas', 'Ventas', `
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

  pantalla('pedidos', 'Pedidos por entregar', lista.map(v => {
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
    aviso('Pedido entregado');
    pedidos();
  }));
}

// =====================================================================
// Productos
// =====================================================================

const OPCIONES_UNIDAD = { paq: 'Paquete', cja: 'Caja', fardo: 'Fardo', und: 'Unidad' };

async function productos(id) {
  const lista = await q(sb.from('productos').select('*').order('activo', { ascending: false }).order('nombre'));
  const editando = id ? lista.find(p => p.id == id) : null;

  pantalla('productos', 'Productos', `
    ${editando ? `
    <form id="f" class="tarjeta">
      <p class="paso">Editar ${esc(editando.nombre)}</p>
      <div class="fila2">
        <label>Marca <input name="marca" required value="${esc(editando.marca || editando.nombre)}"></label>
        <label>Presentación <input name="presentacion" value="${esc(editando.presentacion)}"></label>
      </div>
      <div class="fila2">
        <label>Sabor <input name="sabor" value="${esc(editando.sabor)}"></label>
        <label>Se cuenta por <select name="unidad">${Object.entries(OPCIONES_UNIDAD)
          .map(([k, v]) => `<option value="${k}" ${editando.unidad === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <label>Precio de venta general (Bs) <input name="precio_general" type="number" step="any" min="0" inputmode="decimal" value="${editando.precio_general ?? ''}"></label>
      <label class="check"><input type="checkbox" name="activo" ${editando.activo ? 'checked' : ''}> Activo (se puede vender)</label>
      <button class="btn primario grande">${icono('ok')} Guardar cambios</button>
      <a class="btn" href="#productos" style="width:100%;margin-top:8px">Cancelar</a>
    </form>` : '<p class="nota">Los productos se crean solos al registrar una llegada. Toca uno para cambiar su precio general.</p>'}
    <div class="tarjeta">${lista.map(p => `
      <a class="item" href="#productos/${p.id}" style="text-decoration:none;color:inherit">
        <div class="info"><b>${esc(p.nombre)}</b><small>${unidad(p.unidad)}${p.activo ? '' : ' · inactivo'}</small></div>
        <div class="monto">${n(p.precio_general) ? bs(p.precio_general) : '<span class="nota">sin precio</span>'}</div>
        ${icono('editar', 'suave')}</a>`).join('') || '<p class="nota">Sin productos todavía.</p>'}
    </div>`, editando ? '#productos' : '#inicio');

  const form = $('#f');
  if (form) form.onsubmit = e => {
    e.preventDefault();
    conEspera(form.querySelector('button'), async () => {
      const d = datos(form);
      const fila = { marca: d.marca.trim(), presentacion: d.presentacion.trim() || null, sabor: d.sabor.trim() || null };
      await q(sb.from('productos').update({
        ...fila, nombre: nombreProducto(fila), unidad: d.unidad, precio_general: n(d.precio_general), activo: !!d.activo,
      }).eq('id', editando.id));
      aviso('Guardado');
      location.hash = '#productos';
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

  pantalla('clientes', 'Clientes', `
    <form id="f" class="tarjeta">
      <p class="paso">Nuevo cliente</p>
      <label>Nombre <input name="nombre" required></label>
      <div class="fila2">
        <label>Teléfono <input name="telefono" type="tel" inputmode="tel"></label>
        <label>Ya me debía (Bs) <input name="deuda_inicial" type="number" step="any" min="0" inputmode="decimal" value="0"></label>
      </div>
      <button class="btn primario grande">${icono('mas')} Agregar cliente</button>
    </form>
    <label class="buscador">${icono('buscar')}<input id="buscar" placeholder="Buscar cliente"></label>
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
      aviso('Cliente guardado');
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

  pantalla('clientes', esc(c.nombre), `
    <div class="cifras"><div class="cifra"><small>Debe</small><b class="${debe > 0 ? 'negativo' : ''}">${bs(debe)}</b></div>
      <div class="cifra"><small>Paga hasta</small><b>${saldo[0]?.compromiso ? fecha(saldo[0].compromiso) : '—'}</b></div></div>
    <form id="f" class="tarjeta">
      <label>Nombre <input name="nombre" required value="${esc(c.nombre)}"></label>
      <div class="fila2">
        <label>Teléfono <input name="telefono" type="tel" value="${esc(c.telefono)}"></label>
        <label>Deuda anterior (Bs) <input name="deuda_inicial" type="number" step="any" min="0" value="${c.deuda_inicial}"></label>
      </div>
      <label>Notas <input name="notas" value="${esc(c.notas)}"></label>
      <button class="btn primario grande">${icono('ok')} Guardar</button>
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
      aviso('Guardado');
      cliente(id);
    });
  };
}

// =====================================================================
// Entrada y navegación
// =====================================================================

function login() {
  app.innerHTML = `
    <div class="login">
      <div class="logo">${icono('llego')}</div>
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
    pantalla('alerta', 'Algo salió mal', `<p class="tarjeta error">${esc(e.message || e)}</p><p class="nota">Revisa tu conexión a internet y vuelve a intentar.</p>`);
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
