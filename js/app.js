import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { icono } from './iconos.js';
import { opcionesCatalogo, nombreProducto, clave } from './catalogo.js';
import { iniciarCola, leerCola, operar, sincronizar, descartar, reintentar } from './cola.js';

// supabase-js va dentro de la app (js/vendor) para que cargue sin internet
const { createClient } = window.supabase;
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

// Cada pantalla toma el color de su sección (ver [data-seccion] en estilos.css)
function pantalla(ico, titulo, html, volver = '#inicio') {
  app.dataset.seccion = ico;
  app.innerHTML = `
    ${volver ? `<a class="volver" href="${volver}">${icono('volver')} Volver</a>` : ''}
    <h1>${ico ? `<span class="burbuja">${icono(ico)}</span>` : ''}${titulo}</h1>
    ${html}`;
}

const CARGANDO = '<div class="cargando" aria-label="Cargando"><div class="bloque bajo"></div><div class="bloque alto"></div><div class="bloque"></div><div class="bloque"></div></div>';

// Los montos del panel suben contando hasta su valor
function animarNumeros() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of $$('[data-monto]')) {
    const final = n(el.dataset.monto);
    const inicioT = performance.now();
    const paso = t => {
      const p = Math.min(1, (t - inicioT) / 700);
      el.textContent = bs(final * (1 - Math.pow(1 - p, 3)));
      if (p < 1 && el.isConnected) requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  }
}

function saludo() {
  const h = new Date().getHours();
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
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

// =====================================================================
// Sin internet: cola de cambios, aviso de estado y datos locales
// =====================================================================

const sinInternet = () => !navigator.onLine;

// Lo que se guardó: avisa si quedó en el aparato
const avisoGuardado = (r, texto) =>
  aviso(r.subido ? texto : `${texto}. Sin internet: queda guardado y se sube solo.`);

function necesitaInternet() {
  if (sinInternet()) throw new Error('Para esto necesitas internet. Inténtalo cuando vuelva la señal.');
}

function dibujarEstado(cola = leerCola()) {
  const el = document.getElementById('estado');
  const conError = cola.filter(o => o.error).length;
  const esperando = cola.length - conError;
  let texto = '';
  if (conError) texto = `${icono('alerta')} ${conError} cambio(s) no se pudieron subir · <a href="#pendientes">Ver</a>`;
  else if (sinInternet()) texto = `Sin internet${esperando ? ` · ${esperando} cambio(s) guardados en el aparato` : ' · puedes seguir trabajando'}`;
  else if (esperando) texto = `Subiendo ${esperando} cambio(s)…`;
  el.innerHTML = texto;
  el.hidden = !texto;
  el.className = conError ? 'error' : sinInternet() ? 'offline' : 'subiendo';
}
window.addEventListener('online', () => dibujarEstado());
window.addEventListener('offline', () => dibujarEstado());

// Cambios de la cola que todavía no llegaron a Supabase (para no mostrar datos atrasados)
const enCola = tipo => leerCola().filter(o => o.tipo === tipo);

// Deuda de un cliente: lo que dice Supabase + fiados, pedidos y cobros que siguen en la cola
function saldoCliente(c, saldoServidor = 0) {
  let saldo = n(saldoServidor);
  const nombre = c.nombre.trim().toLowerCase();
  for (const { tipo, datos: d } of leerCola()) {
    if (tipo === 'venta' && (d.tipo === 'fiado' || d.tipo === 'pedido') && (d.cliente_nombre || '').trim().toLowerCase() === nombre) {
      const total = d.items.reduce((t, i) => t + n(i.cantidad) * n(i.precio), 0);
      saldo += total - Math.min(n(d.pagado), total);
    }
    if (tipo === 'pago' && c.id && d.cliente_id === c.id) saldo -= n(d.monto);
    if (tipo === 'entregar' && c.id && d.cliente_id === c.id) saldo -= n(d.cobrar);
  }
  return saldo;
}

async function viajeAbierto() {
  const cerrado = ref => leerCola().some(o => (o.tipo === 'regreso' || o.tipo === 'cancelar_salida') && o.datos.viaje_ref === ref);
  const filas = await q(sb.from('viajes').select('id, ref, salida').is('regreso', null).limit(1)).catch(() => []);
  if (filas[0] && !cerrado(filas[0].ref)) return filas[0];
  const salida = enCola('salida').filter(o => !cerrado(o.datos.viaje_ref)).at(-1);
  return salida ? { ref: salida.datos.viaje_ref, salida: salida.datos.fecha, local: true, carga: salida.datos.carga } : null;
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

  // Descontar/sumar lo que está en la cola y todavía no se subió
  const cambio = {};
  const mover = (id, c) => { if (id) cambio[id] = (cambio[id] || 0) + n(c); };
  for (const op of leerCola()) {
    if (op.tipo === 'venta') op.datos.items.forEach(i => mover(i.producto_id, -i.cantidad));
    if (op.tipo === 'baja') mover(op.datos.producto_id, -op.datos.cantidad);
    if (op.tipo === 'llegada') op.datos.lineas.forEach(l => mover(l.producto_id, n(l.cant_pagada) + n(l.cant_regalo)));
  }
  for (const [id, c] of Object.entries(cambio)) {
    const p = porProducto[id];
    if (p) {
      p.restante += c;
      p.valor += c * p.costoPrimero;
      if (p.restante <= 1e-9) delete porProducto[id];
    } else if (c > 0) {
      const l = enCola('llegada').flatMap(o => o.datos.lineas).find(x => x.producto_id == id);
      porProducto[id] = { id: +id, nombre: l.nombre, unidad: l.unidad, restante: c, valor: c * n(l.costo_unit), costoPrimero: n(l.costo_unit), lotes: [] };
    }
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

function inicioDatos(periodo) {
  const desde = inicioPeriodo(periodo);
  const filtrar = (consulta, campo, valor) => (desde ? consulta.gte(campo, valor) : consulta);
  return Promise.all([
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
}

async function inicio() {
  const periodo = leer('periodo', 'mes');
  const [items, bajas, gastos, lotes, pagos, stock, saldos, pedidos, viaje] = await inicioDatos(periodo);
  const enEspera = leerCola().length;

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
    enEspera && `<a class="alerta amarilla" href="#pendientes">${icono('alerta')}<span>${enEspera} cambio(s) todavía no se subieron: los números de abajo aún no los incluyen.</span></a>`,
    viaje && `<a class="alerta verde" href="#camion">${icono('camion')}<span>El camión está en ruta desde ${fechaHora(viaje.salida)}. Toca aquí al regresar.</span></a>`,
    porVencer.length && `<a class="alerta roja" href="#stock">${icono('alerta')}<span>${porVencer.length} lote(s) vencen en 30 días o menos (${bs(valorPorVencer)}). ¡Véndelos primero!</span></a>`,
    atrasados && `<a class="alerta roja" href="#cobrar">${icono('cobrar')}<span>${atrasados} cliente(s) pasaron su fecha de pago.</span></a>`,
    pedidos.length && `<a class="alerta amarilla" href="#pedidos">${icono('pedidos')}<span>${pedidos.length} pedido(s) por entregar.</span></a>`,
  ].filter(Boolean).join('');

  const boton = (seccion, ruta, texto) =>
    `<a href="#${ruta}" data-seccion="${seccion}"><span class="burbuja">${icono(seccion)}</span>${texto}</a>`;
  const hoyLargo = new Date().toLocaleDateString('es-BO', { weekday: 'long', day: 'numeric', month: 'long' });

  app.dataset.seccion = 'vender';
  app.innerHTML = `
    <section class="portada">
      <small>${saludo()} · ${hoyLargo}</small>
      <h1>Mi Almacén</h1>
      <a class="vender" href="#vender">${icono('vender')} VENDER</a>
    </section>
    <div class="menu">
      ${boton('llego', 'llego', 'Llegó mercadería')}
      ${boton('cobrar', 'cobrar', 'Cobrar')}
      ${boton('camion', 'camion', 'Camión')}
      ${boton('gasto', 'gasto', 'Gasto')}
    </div>
    ${alertas}
    <div class="chips">
      ${Object.entries(nombres).map(([k, v]) => `<button class="chip ${k === periodo ? 'activo' : ''}" data-periodo="${k}">${v}</button>`).join('')}
    </div>
    <div class="cifras">
      <div class="cifra" data-seccion="ventas"><small>Vendido</small><b data-monto="${vendido}">${bs(vendido)}</b></div>
      <div class="cifra" data-seccion="vender"><small>Ganancia real</small><b data-monto="${neta}" class="${neta >= 0 ? 'positivo' : 'negativo'}">${bs(neta)}</b></div>
      <div class="cifra" data-seccion="cobrar"><small>Me deben (hoy)</small><b data-monto="${meDeben}">${bs(meDeben)}</b></div>
      <div class="cifra" data-seccion="stock"><small>Mercadería en stock</small><b data-monto="${valorStock}">${bs(valorStock)}</b></div>
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
    <h3>Más opciones</h3>
    <div class="menu">
      ${boton('stock', 'stock', 'Stock y vencimientos')}
      ${boton('ventas', 'historial', 'Ventas')}
      ${boton('pedidos', 'pedidos', 'Pedidos')}
      ${boton('clientes', 'clientes', 'Clientes')}
      ${boton('productos', 'productos', 'Productos')}
      ${boton('baja', 'baja', 'Pinchadas / bajas')}
    </div>
    ${botonInstalar()}
    <button class="btn" id="salir" style="width:100%">${icono('salir')} Cerrar sesión</button>`;

  animarNumeros();
  $$('[data-periodo]').forEach(b => b.onclick = () => { guardar('periodo', b.dataset.periodo); inicio(); });
  activarInstalar();
  $('#salir').onclick = async () => {
    const pendientes = leerCola().length;
    if (pendientes && !confirm(`Hay ${pendientes} cambio(s) que todavía no se subieron. Si cierras sesión se pierden. ¿Cerrar igual?`)) return;
    if (!pendientes && !confirm('¿Cerrar sesión? Para volver a entrar necesitarás internet.')) return;
    leerCola().forEach(o => descartar(o.id));
    navigator.serviceWorker?.controller?.postMessage('borrar-datos');
    await sb.auth.signOut();
    login();
  };
}

// ---------- Instalar como app (celular y PC) ----------

let pedidoInstalar = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  pedidoInstalar = e;
  if (!location.hash || location.hash === '#inicio') inicio().catch(() => {});
});
const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const esIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function botonInstalar() {
  if (instalada()) return '';
  if (pedidoInstalar) return `<button class="btn primario" id="instalar" style="width:100%;margin-bottom:10px">${icono('llego')} Instalar en este aparato</button>`;
  if (esIphone()) return `<p class="tarjeta nota">Para instalarla en el iPhone: toca <b>Compartir</b> y luego <b>"Agregar a inicio"</b>.</p>`;
  return '';
}

function activarInstalar() {
  const b = $('#instalar');
  if (!b) return;
  b.onclick = async () => {
    pedidoInstalar.prompt();
    const { outcome } = await pedidoInstalar.userChoice;
    pedidoInstalar = null;
    if (outcome === 'accepted') aviso('App instalada');
    b.remove();
  };
}

// =====================================================================
// Llegó mercadería: varios productos en una sola llegada
// =====================================================================

const cargarLlego = () => Promise.all([
  q(sb.from('productos').select('*')),
  q(sb.from('lotes').select('producto_id, costo_unit').order('id', { ascending: false }).limit(500)),
  q(sb.from('v_stock_lotes').select('*').order('id', { ascending: false }).limit(10)),
]);

async function llego() {
  const [productos, ultimosLotes, recientes] = await cargarLlego();

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
    const dia = $('#fecha').value || hoy();

    // Repartir el flete según el valor de cada producto (el último se lleva el redondeo).
    // Los productos nuevos los crea Supabase al subir la llegada.
    let repartido = 0;
    const filas = lineas.map((l, i) => {
      const parte = i === lineas.length - 1
        ? Math.round((flete - repartido) * 100) / 100
        : Math.round(flete * (valor ? (l.cant_pagada * l.costo_unit) / valor : 1 / lineas.length) * 100) / 100;
      repartido += parte;
      return {
        producto_id: l.producto_id ?? null, nombre: nombreProducto(l), marca: l.marca,
        presentacion: l.presentacion || '', sabor: l.sabor || '', unidad: l.unidad, precio: n(l.precio),
        cant_pagada: l.cant_pagada, cant_regalo: l.cant_regalo, costo_unit: l.costo_unit,
        flete: parte, vencimiento: l.vencimiento,
      };
    });
    const r = await operar('llegada', { dia, proveedor, lineas: filas }, `Llegada de ${lineas.length} producto(s)`);
    guardar('proveedor', proveedor);
    avisoGuardado(r, `Llegada guardada: ${lineas.length} producto(s)`);
    llego();
  }

  dibujarLlegada();
}

// =====================================================================
// Vender
// =====================================================================

const cargarVender = () => Promise.all([
  opcionesConStock(),
  q(sb.from('clientes').select('id, nombre').eq('activo', true).order('nombre')),
  q(sb.from('ventas').select('cliente_id').not('cliente_id', 'is', null).order('id', { ascending: false }).limit(300)),
  viajeAbierto(),
  todas(() => sb.from('precios_cliente').select('cliente_id, producto_id, precio')),
  todas(() => sb.from('v_saldos').select('cliente_id, saldo')),
]);

async function vender() {
  const [{ opciones }, clientes, recientes, viaje, todosLosPrecios, saldos] = await cargarVender();
  // Clientes creados sin internet todavía no están en Supabase: se suman por nombre
  for (const op of enCola('venta')) {
    const nombre = op.datos.cliente_nombre;
    if (nombre && !clientes.some(c => c.nombre.trim().toLowerCase() === nombre.trim().toLowerCase())) clientes.push({ id: null, nombre });
  }
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
      for (const f of todosLosPrecios.filter(f => f.cliente_id === c.id)) preciosCliente[f.producto_id] = n(f.precio);
      // Precios dados sin internet a este cliente (todavía en la cola)
      for (const op of enCola('venta').filter(o => (o.datos.cliente_nombre || '').trim().toLowerCase() === c.nombre.trim().toLowerCase())) {
        if (op.datos.tipo !== 'regalo') op.datos.items.forEach(i => (preciosCliente[i.producto_id] = n(i.precio)));
      }
      const debe = saldoCliente(c, saldos.find(s => s.cliente_id === c.id)?.saldo);
      $('#nota-cliente').innerHTML = debe > 0.009 ? `<span class="negativo">Debe ${bs(debe)}</span>` : 'No tiene deudas.';
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
    const total = items.reduce((s, i) => s + i.cantidad * i.precio, 0);
    // El cliente va por nombre: si es nuevo, Supabase lo crea al subir la venta
    const r = await operar('venta', {
      tipo,
      cliente_nombre: nombre || null,
      fecha_compromiso: $('#compromiso')?.value || null,
      viaje_ref: viaje && $('#desde-camion')?.checked ? viaje.ref : null,
      pagado: n($('#pagado')?.value),
      nota: $('#nota').value.trim() || null,
      items: items.map(({ producto_id, cantidad, precio }) => ({ producto_id, cantidad, precio })),
    }, `${TIPOS[tipo]} a ${nombre || 'cliente de paso'}: ${bs(tipo === 'regalo' ? 0 : total)}`);
    avisoGuardado(r, tipo === 'regalo' ? 'Regalo guardado' : `Venta guardada: ${bs(total)}`);
    vender();
  });

  dibujarCarrito();
  if (!opciones.length) $('#sel').innerHTML = '<p class="nota">No hay stock. Registra lo que llega en "Llegó mercadería".</p>';
}

// =====================================================================
// Cobrar
// =====================================================================

const cargarCobrar = () => Promise.all([
  todas(() => sb.from('v_saldos').select('*')),
  viajeAbierto(),
]);

async function cobrar() {
  const [todosLosSaldos, viaje] = await cargarCobrar();
  const saldos = todosLosSaldos
    .map(c => ({ ...c, saldo: saldoCliente({ id: c.cliente_id, nombre: c.nombre }, c.saldo) }))
    .filter(c => c.saldo > 0.009)
    .sort((a, b) => b.saldo - a.saldo);
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
      const nombre = form.closest('.tarjeta').querySelector('b').textContent;
      const r = await operar('pago', {
        cliente_id: +form.dataset.cliente,
        monto,
        viaje_ref: viaje && $('#desde-camion')?.checked ? viaje.ref : null,
      }, `Cobro a ${nombre}: ${bs(monto)}`);
      avisoGuardado(r, `Cobro de ${bs(monto)} guardado`);
      cobrar();
    });
  });
}

// =====================================================================
// Camión: salida y regreso
// =====================================================================

async function camion() {
  const viaje = await viajeAbierto();
  return viaje ? camionEnRuta(viaje) : camionSalida();
}

const cargarCamionSalida = () => Promise.all([
  opcionesConStock(),
  q(sb.from('viajes').select('*').not('regreso', 'is', null).order('id', { ascending: false }).limit(5)).catch(() => []),
]);

async function camionSalida() {
  const [{ opciones }, anteriores] = await cargarCamionSalida();
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
      const filas = {};
      for (const c of carga) (filas[c.producto_id] ??= { producto_id: c.producto_id, nombre: c.nombre, cantidad: 0 }).cantidad += c.cantidad;
      // El viaje lleva un código creado aquí, así se puede vender en ruta aunque no haya internet
      const r = await operar('salida', { viaje_ref: crypto.randomUUID(), carga: Object.values(filas) },
        `Salida del camión (${Object.keys(filas).length} producto(s))`);
      avisoGuardado(r, 'Camión en ruta');
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

async function camionEnRuta(viaje) {
  // Lo que ya está en Supabase (si el viaje se subió) + lo de este viaje que sigue en la cola
  let carga;
  let vendidos = [];
  let pagos = [];
  if (viaje.local) {
    carga = viaje.carga.map(c => ({ producto_id: c.producto_id, nombre: c.nombre, cargado: n(c.cantidad) }));
  } else {
    let filas;
    [filas, vendidos, pagos] = await Promise.all([
      q(sb.from('viaje_carga').select('producto_id, cargado, productos(nombre)').eq('viaje_id', viaje.id)),
      todas(() => sb.from('venta_items').select('producto_id, cantidad, ventas!inner(viaje_id)').eq('ventas.viaje_id', viaje.id)),
      q(sb.from('pagos').select('monto').eq('viaje_id', viaje.id)),
    ]);
    carga = filas.map(c => ({ producto_id: c.producto_id, nombre: c.productos.nombre, cargado: n(c.cargado) }));
  }
  const vendido = {};
  for (const v of vendidos) vendido[v.producto_id] = (vendido[v.producto_id] || 0) + n(v.cantidad);
  let esperado = pagos.reduce((s, p) => s + n(p.monto), 0);
  let hayVentas = vendidos.length > 0;
  for (const { tipo, datos: d } of leerCola()) {
    if (d.viaje_ref !== viaje.ref) continue;
    if (tipo === 'venta') {
      hayVentas = true;
      d.items.forEach(i => (vendido[i.producto_id] = (vendido[i.producto_id] || 0) + n(i.cantidad)));
      const total = d.items.reduce((t, i) => t + n(i.cantidad) * n(i.precio), 0);
      esperado += d.tipo === 'contado' ? total : d.tipo === 'regalo' ? 0 : Math.min(n(d.pagado), total);
    }
    if (tipo === 'pago') esperado += n(d.monto);
  }

  pantalla('camion', 'Camión en ruta', `
    <p class="nota">Salió: ${fechaHora(viaje.salida)} · Las ventas marcadas "desde el camión" se van sumando aquí.</p>
    <form id="f" class="tarjeta">
      <table>
        <thead><tr><th>Producto</th><th class="n">Cargó</th><th class="n">Vendió</th><th class="n">Volvió</th></tr></thead>
        <tbody>${carga.map(c => {
          const debe = Math.max(0, c.cargado - (vendido[c.producto_id] || 0));
          return `<tr>
            <td>${esc(c.nombre)}</td>
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
    ${hayVentas ? '' : `<button class="btn peligro" id="cancelar" style="width:100%">${icono('cerrar')} Cancelar esta salida</button>`}`);

  const revisar = () => {
    const faltan = $$('[data-producto]').map(i => ({
      nombre: carga.find(c => c.producto_id == i.dataset.producto).nombre,
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
      const r = await operar('regreso', {
        viaje_ref: viaje.ref,
        devueltos: $$('[data-producto]').map(i => ({ producto_id: +i.dataset.producto, devuelto: n(i.value) })),
        efectivo: n($('#efectivo').value),
        marcar: $('#marcar').checked,
      }, 'Regreso del camión');
      avisoGuardado(r, 'Viaje cerrado');
      location.hash = '#inicio';
    });
  };
  const cancelar = $('#cancelar');
  if (cancelar) cancelar.onclick = () => conEspera(cancelar, async () => {
    if (!confirm('¿Cancelar esta salida del camión?')) return;
    // Si la salida todavía no se subió, basta con quitarla de la cola
    const salida = enCola('salida').find(o => o.datos.viaje_ref === viaje.ref);
    if (salida) { descartar(salida.id); aviso('Salida cancelada'); }
    else avisoGuardado(await operar('cancelar_salida', { viaje_ref: viaje.ref }, 'Cancelar salida del camión'), 'Salida cancelada');
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
      const r = await operar('gasto', { categoria, monto: n(d.monto), dia: d.fecha, nota: d.nota.trim() || null },
        `Gasto ${categoria}: ${bs(d.monto)}`);
      avisoGuardado(r, 'Gasto guardado');
      gasto();
    });
  };
  $$('[data-borrar]').forEach(b => b.onclick = () => conEspera(b, async () => {
    necesitaInternet();
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
    necesitaInternet();
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
      const r = await operar('baja', { producto_id: actual.producto_id, cantidad, motivo, nota: form.nota.value.trim() || null },
        `Baja (${MOTIVOS[motivo]}): ${cant(cantidad)} ${nombreProducto(actual)}`);
      avisoGuardado(r, 'Baja registrada');
      baja();
    });
  };
  $$('[data-borrar]').forEach(b => b.onclick = () => conEspera(b, async () => {
    necesitaInternet();
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
    necesitaInternet();
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
  const entregadosEnCola = new Set(enCola('entregar').map(o => o.datos.venta_id));

  pantalla('pedidos', 'Pedidos por entregar', lista.filter(v => !entregadosEnCola.has(v.id)).map(v => {
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
    const r = await operar('entregar', {
      venta_id: +b.dataset.entregar,
      cliente_id: b.dataset.cliente ? +b.dataset.cliente : null,
      cobrar: n(b.dataset.cobrar),
    }, 'Entrega de pedido');
    avisoGuardado(r, 'Pedido entregado');
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
      necesitaInternet();
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
      necesitaInternet();
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
      necesitaInternet();
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
  app.dataset.seccion = 'vender';
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
      if (sinInternet()) throw new Error('Para entrar la primera vez necesitas internet.');
      const { error } = await sb.auth.signInWithPassword(datos(form));
      if (error) throw new Error('Correo o contraseña incorrectos');
      precargar();
      navegar();
    });
  };
}

// =====================================================================
// Cambios pendientes de subir
// =====================================================================

async function pendientes() {
  const cola = leerCola();
  pantalla('alerta', 'Cambios por subir', `
    <p class="nota">${sinInternet() ? 'Sin internet: se subirán solos cuando vuelva la señal.' : 'Con internet se suben solos en unos segundos.'}</p>
    ${cola.map(o => `
      <div class="tarjeta">
        <div class="item"><div class="info"><b>${esc(o.descripcion || o.tipo)}</b>
          <small>${fechaHora(o.datos.fecha)}</small>
          ${o.error ? `<small class="negativo">No se pudo subir: ${esc(o.error)}</small>` : '<span class="etiqueta amarilla">esperando internet</span>'}</div></div>
        ${o.error ? `<div class="fila2">
          <button data-reintentar="${o.id}">Reintentar</button>
          <button class="peligro" data-descartar="${o.id}">Descartar</button></div>` : ''}
      </div>`).join('') || '<p class="tarjeta">Todo está subido.</p>'}
    ${cola.some(o => !o.error) && !sinInternet() ? '<button class="btn primario grande" id="subir">Subir ahora</button>' : ''}`);

  $$('[data-reintentar]').forEach(b => b.onclick = () => conEspera(b, async () => { await reintentar(b.dataset.reintentar); pendientes(); }));
  $$('[data-descartar]').forEach(b => b.onclick = () => {
    if (!confirm('¿Descartar este cambio? No se va a guardar.')) return;
    descartar(b.dataset.descartar);
    pendientes();
  });
  if ($('#subir')) $('#subir').onclick = () => conEspera($('#subir'), async () => { await sincronizar(); pendientes(); });
}

// =====================================================================
// Arranque
// =====================================================================

// Con internet, se abren en segundo plano los datos de las pantallas principales
// para que queden guardados y la app funcione si después se corta la señal.
async function precargar() {
  if (sinInternet()) return;
  await Promise.allSettled([cargarVender(), cargarCobrar(), cargarCamionSalida(), cargarLlego(), inicioDatos(leer('periodo', 'mes'))]);
}

const rutas = { inicio, llego, vender, cobrar, camion, gasto, stock, baja, historial, pedidos, productos, clientes, pendientes };

async function navegar() {
  let { data: { session } } = await sb.auth.getSession().catch(() => ({ data: {} }));
  // Sin internet el token puede estar vencido y no se puede renovar: se sigue con los datos guardados
  if (!session && sinInternet() && Object.keys(localStorage).some(k => k.startsWith('sb-') && k.endsWith('-auth-token'))) session = true;
  if (!session) return login();
  const [ruta, param] = location.hash.slice(1).split('/');
  app.innerHTML = CARGANDO;
  try {
    await (rutas[ruta] || inicio)(param);
  } catch (e) {
    const texto = sinInternet()
      ? 'No hay internet y esta pantalla todavía no se había abierto con internet en este aparato. Ábrela una vez con señal y después funcionará sin internet.'
      : esc(e.message || e);
    pantalla('alerta', sinInternet() ? 'Sin internet' : 'Algo salió mal', `<p class="tarjeta">${texto}</p>`);
  }
  window.scrollTo(0, 0);
}

function arrancar() {
  if (!configurado) {
    app.innerHTML = `<div class="tarjeta"><h1>Falta configurar</h1>
      <p>Abre <b>js/config.js</b> y pega la URL y la anon key de tu proyecto de Supabase.</p></div>`;
    return;
  }
  iniciarCola(sb, cola => {
    dibujarEstado(cola);
    // Cuando termina de subir, refrescar la pantalla para mostrar los datos al día
    if (!cola.length && location.hash === '#pendientes') pendientes();
  });
  window.addEventListener('hashchange', navegar);
  window.addEventListener('online', () => precargar());
  navegar().then(() => setTimeout(precargar, 1500));
}

arrancar();
