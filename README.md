# Mi Almacén

App web para controlar el almacén de bebidas desde el celular: lotes que llegan, ventas, fiados, pedidos, regalos, camión, gastos y ganancia real.

- **Página:** HTML + JavaScript sin compilar (se publica tal cual en GitHub Pages).
- **Datos:** Supabase (Postgres). Toda la lógica de stock y deudas está en `supabase/esquema.sql`.

## Puesta en marcha

### 1. Supabase
1. Crear un proyecto en <https://supabase.com>.
2. **SQL Editor → New query**, pegar todo `supabase/esquema.sql` y **Run**.
3. **Authentication → Users → Add user → Create new user**: correo y contraseña de Rafael (marcar *Auto confirm user*).
4. **Authentication → Sign In / Providers → Email**: desactivar **Allow new users to sign up**, para que nadie más pueda crear cuenta.
5. **Project Settings → API**: copiar **Project URL** y **anon public key**.

### 2. Configurar
Pegar esos dos valores en `js/config.js`.

### 3. Publicar en GitHub Pages
1. Subir la carpeta `almacen-app` a un repositorio.
2. **Settings → Pages → Deploy from a branch**, rama `main`, carpeta `/ (root)`.
3. Abrir la dirección en el celular de Rafael → menú del navegador → **Agregar a pantalla de inicio**.

## Cómo se usa

| Botón | Qué hace |
|---|---|
| 📦 Llegó mercadería | Registra un lote: cantidad pagada, **de regalo**, costo, flete y vencimiento. Calcula el costo real por unidad. |
| 🛒 Vender | Sugiere **el precio de ese cliente** (o el general). Sale primero el lote que vence antes. Avisa si se vende bajo costo. Contado, **fiado** (con fecha de pago), **pedido** (se entrega después, queda apartado) o **regalo**. |
| 💵 Cobrar | Lista quién debe y desde cuándo. Los cobros pagan primero la deuda más vieja. Recordatorio por WhatsApp. |
| 🚚 Camión | Salida: lo que se carga. Regreso: lo que volvió; lo que falta se cuenta como pinchado y se cuadra la plata. |
| 🧾 Gasto | Flete, combustible, sueldos, alquiler, depósito… |

**Ganancia real** = ventas − costo de lo vendido − regalos − pinchadas/vencidas − gastos.

Para empezar: cargar los productos y el stock que hay hoy con "Llegó mercadería" (proveedor: "Inventario inicial"), y en Clientes poner lo que cada uno ya debía en "Ya me debía".
