// Catálogo de partida, sacado de los inventarios y reportes de Rafael (2026).
// costo/precio son sugerencias: en cuanto un producto tiene lotes o precio propio, mandan esos.
// Productos nuevos que no estén aquí se agregan desde la app con "Otro producto".
export const CATALOGO = [
  {
    marca: 'Mendocina', unidad: 'paq', proveedor: 'BBO',
    sabores: ['Cola', 'Naranja', 'Piña', 'Papaya', 'Limón', 'Uva', 'Pomelo', 'Guaraná', 'Frutilla'],
    presentaciones: [
      { presentacion: '330 ml', costo: 27, precio: 30 },
      { presentacion: '1 L', costo: 28, precio: 30 },
      { presentacion: '2 L', costo: 44, precio: 54 },
      { presentacion: '3 L', costo: 60, precio: 70 },
    ],
  },
  {
    marca: 'Agua sin gas', unidad: 'paq', proveedor: 'BBO',
    presentaciones: [
      { presentacion: '600 ml', costo: 14 },
      { presentacion: '1 L', costo: 20, precio: 20 },
      { presentacion: '2 L', costo: 26, precio: 28 },
      { presentacion: '3 L', costo: 34 },
    ],
  },
  {
    marca: 'Schneider', unidad: 'cja', proveedor: 'BBO',
    presentaciones: [{ presentacion: 'Lata 473 ml', costo: 167, precio: 175 }],
  },
  {
    marca: 'Capital', unidad: 'cja', proveedor: 'BBO',
    presentaciones: [
      { presentacion: 'Lata 350 ml', costo: 120 },
      { presentacion: 'Lata 473 ml', costo: 160, precio: 168 },
    ],
  },
  {
    marca: 'Malta', unidad: 'cja', proveedor: 'BBO',
    presentaciones: [{ presentacion: 'Lata 350 ml', costo: 130, precio: 135 }],
  },
  {
    marca: 'Amstel', unidad: 'cja', proveedor: 'BBO',
    presentaciones: [
      { presentacion: 'Lata 269 ml', costo: 108 },
      { presentacion: 'Lata 473 ml', costo: 178 },
      { presentacion: 'Botella 620 ml', costo: 127, unidad: 'fardo' },
    ],
  },
  {
    marca: 'Heineken', unidad: 'cja', proveedor: 'BBO',
    presentaciones: [{ presentacion: 'Botella 330 ml', costo: 290 }],
  },
  {
    marca: 'Real', unidad: 'fardo', proveedor: 'BBO',
    presentaciones: [{ presentacion: 'Botella 620 ml', costo: 102 }],
  },
  {
    marca: 'Volt', unidad: 'cja', proveedor: 'AJE',
    presentaciones: [
      { presentacion: 'Lata 310 ml', costo: 39.48, precio: 45 },
      { presentacion: 'Lata 473 ml', costo: 56.28, precio: 65 },
    ],
  },
];

// Una fila por producto vendible: marca + presentación (+ sabor)
export function opcionesCatalogo() {
  const filas = [];
  for (const m of CATALOGO) {
    for (const p of m.presentaciones) {
      for (const sabor of m.sabores || [null]) {
        filas.push({
          marca: m.marca, presentacion: p.presentacion, sabor,
          unidad: p.unidad || m.unidad, proveedor: m.proveedor,
          costo: p.costo ?? null, precio: p.precio ?? null,
        });
      }
    }
  }
  return filas;
}

export const nombreProducto = ({ marca, sabor, presentacion }) =>
  [marca, sabor, presentacion].filter(Boolean).join(' ');

export const clave = o => [o.marca, o.presentacion, o.sabor].map(x => (x || '').trim().toLowerCase()).join('|');
