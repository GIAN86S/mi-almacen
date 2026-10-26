// Cola de cambios: todo lo que se guarda pasa por aquí.
// Con internet se sube al instante; sin internet queda en el aparato y se sube solo cuando vuelve la señal.
// Cada cambio lleva un código único: si se sube dos veces, Supabase ignora la segunda.

const CLAVE = 'cola-cambios';
let sb = null;
let avisar = () => {};
let enCurso = null;

export const leerCola = () => {
  try { return JSON.parse(localStorage.getItem(CLAVE)) || []; } catch { return []; }
};
const escribir = cola => {
  try { localStorage.setItem(CLAVE, JSON.stringify(cola)); }
  catch { throw new Error('El aparato no tiene espacio para guardar. Libera espacio e intenta de nuevo.'); }
  avisar(cola);
};

// Sin señal, o Supabase no respondió: se reintenta después. Error 4xx: el dato tiene un problema real.
const esFallaDeRed = (error, status) => !navigator.onLine || !status || status >= 500 || /fetch|network|Failed/i.test(error?.message || '');

async function subir(op) {
  const { data, error, status } = await sb.rpc('aplicar_operacion', { p_op: op.id, p_tipo: op.tipo, p: op.datos });
  if (!error) return { ok: true, data };
  return { ok: false, red: esFallaDeRed(error, status), mensaje: error.message };
}

// Sube en orden lo pendiente. Si se corta la red, para y reintenta más tarde.
export function sincronizar() {
  if (enCurso) return enCurso;
  enCurso = (async () => {
    const intentadas = new Set();
    for (;;) {
      // Se vuelve a leer en cada vuelta: así entra lo que se guardó mientras se subía lo anterior
      const op = leerCola().find(o => !o.error && !intentadas.has(o.id));
      if (!op) break;
      intentadas.add(op.id);
      const r = await subir(op).catch(e => ({ ok: false, red: true, mensaje: e.message }));
      if (r.red) break;
      const cola = leerCola();
      const i = cola.findIndex(o => o.id === op.id);
      if (i < 0) continue;
      if (r.ok) cola.splice(i, 1);
      else cola[i].error = r.mensaje;
      escribir(cola);
    }
  })().finally(() => { enCurso = null; });
  return enCurso;
}

// Guarda un cambio. Devuelve {subido: true} si ya llegó a Supabase, {subido: false} si quedó en el aparato.
// Si Supabase lo rechaza en el momento (ej. sin stock), lo quita de la cola y lanza el error.
export async function operar(tipo, datos, descripcion) {
  const op = {
    id: crypto.randomUUID(),
    tipo,
    descripcion,
    datos: { fecha: new Date().toISOString(), ...datos },
  };
  escribir([...leerCola(), op]);
  await sincronizar();
  const quedo = leerCola().find(o => o.id === op.id);
  if (!quedo) return { subido: true };
  if (quedo.error) {
    descartar(op.id);
    throw new Error(quedo.error);
  }
  return { subido: false };
}

export function descartar(id) {
  escribir(leerCola().filter(o => o.id !== id));
}

export function reintentar(id) {
  escribir(leerCola().map(o => (o.id === id ? { ...o, error: undefined } : o)));
  return sincronizar();
}

export function iniciarCola(cliente, alCambiar) {
  sb = cliente;
  avisar = alCambiar;
  window.addEventListener('online', () => sincronizar());
  setInterval(() => { if (navigator.onLine && leerCola().some(o => !o.error)) sincronizar(); }, 20000);
  avisar(leerCola());
  sincronizar();
}
