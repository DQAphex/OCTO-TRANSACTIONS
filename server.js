const express = require("express");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env") }); // lee .env junto a server.js, sin importar desde dónde se ejecute
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { Oneclick, TransactionDetail, Options, IntegrationApiKeys, IntegrationCommerceCodes, Environment } = require("transbank-sdk");

const PORT = process.env.PORT || 4006;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Transbank Oneclick Mall ──────────────────────────────────────────────
// Por defecto usa el ambiente de integración (tarjetas de prueba, sin dinero real).
// Producción: TBK_ENV=production, TBK_COMMERCE_CODE (mall), TBK_CHILD_CODE (tienda hija), TBK_API_KEY.
const prod = process.env.TBK_ENV === "production";
const MALL_CODE = prod ? process.env.TBK_COMMERCE_CODE : IntegrationCommerceCodes.ONECLICK_MALL;
const CHILD_CODE = prod ? process.env.TBK_CHILD_CODE : IntegrationCommerceCodes.ONECLICK_MALL_CHILD1;
const opts = new Options(MALL_CODE, prod ? process.env.TBK_API_KEY : IntegrationApiKeys.WEBPAY, prod ? Environment.Production : Environment.Integration);
const inscripcion = new Oneclick.MallInscription(opts);
const mallTx = new Oneclick.MallTransaction(opts);

// Los precios viven en el servidor: el navegador solo elige el plan.
const PLANES = {
  bronce: { nombre: "Suscripción Bronce", precio: 10000 },
  plata:  { nombre: "Suscripción Plata",  precio: 50000 },
  oro:    { nombre: "Suscripción Oro",    precio: 100000 },
};

// Pedidos en memoria (se pierden al reiniciar). En producción usa una base de datos.
const pedidos = new Map();   // id -> pedido
const porToken = new Map();  // token de inscripción -> id

// Persistencia simple en disco (data/pedidos.json) para no perder las compras al reiniciar.
const DATA_FILE = path.join(__dirname, "data", "pedidos.json");
function guardar() {
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify([...pedidos.values()], null, 2)); }
  catch (e) { console.error("No se pudo guardar pedidos:", e.message); }
}
try { for (const p of JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))) pedidos.set(p.id, p); } catch { /* primera vez: no hay archivo */ }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clp = (n) => "$" + Number(n).toLocaleString("es-CL");

function rutValido(rut) {
  const c = String(rut).replace(/[^0-9kK]/g, "").toUpperCase();
  if (c.length < 8) return false;
  const cuerpo = c.slice(0, -1), dv = c.slice(-1);
  let suma = 0, m = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) { suma += Number(cuerpo[i]) * m; m = m === 7 ? 2 : m + 1; }
  const r = 11 - (suma % 11);
  return dv === (r === 11 ? "0" : r === 10 ? "K" : String(r));
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/planes", (_req, res) => res.json(PLANES));

// Paso 2: datos personales → crea el pedido
app.post("/api/pedido", (req, res) => {
  const b = req.body || {};
  const plan = PLANES[b.plan];
  const t = (v) => String(v || "").trim();
  const errores = [];
  if (!plan) errores.push("Suscripción no válida.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t(b.email))) errores.push("Correo electrónico no válido.");
  if (!t(b.nombre)) errores.push("Falta el nombre.");
  if (!t(b.apellido)) errores.push("Falta el apellido.");
  if (!rutValido(t(b.rut))) errores.push("RUT no válido.");
  if (!/^\d{9}$/.test(t(b.telefono))) errores.push("Teléfono no válido (9 dígitos).");
  const nac = new Date(t(b.nacimiento));
  if (!t(b.nacimiento) || isNaN(nac) || nac > new Date()) errores.push("Fecha de nacimiento no válida.");
  if (errores.length) return res.status(400).json({ error: errores.join(" ") });

  const id = crypto.randomUUID();
  const rut = t(b.rut).replace(/[^0-9kK]/g, "").toUpperCase();
  pedidos.set(id, {
    id, plan: b.plan, estado: "pendiente",
    userName: rut, // identifica al cliente en Oneclick (máx. 40 caracteres)
    cliente: { email: t(b.email), nombre: t(b.nombre), apellido: t(b.apellido), rut, telefono: "+56" + t(b.telefono), genero: t(b.genero), nacimiento: t(b.nacimiento) },
  });
  guardar();
  res.json({ id });
});

app.get("/api/pedido/:id", (req, res) => {
  const p = pedidos.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Pedido no encontrado." });
  res.json({ plan: PLANES[p.plan], nombre: p.cliente.nombre, estado: p.estado });
});

// Paso 3: iniciar la inscripción de la tarjeta en Webpay Oneclick
app.post("/api/pagar", async (req, res) => {
  try {
    const p = pedidos.get(req.body?.id);
    if (!p || p.estado === "pagado") return res.status(400).json({ error: "Pedido no válido." });
    const r = await inscripcion.start(p.userName, p.cliente.email, `${BASE_URL}/retorno`);
    p.token = r.token;
    porToken.set(r.token, p.id);
    res.json({ url: r.url_webpay, token: r.token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo iniciar el pago." });
  }
});

const pagina = (res, titulo, cuerpo, ok) => res.send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title><link rel="stylesheet" href="/estilos.css"><header class="topbar"><img src="/logo.svg" alt=""><span class="brand">Octomation</span></header><main class="wrap"><section class="step"><div class="step-head"><span class="num ${ok ? "" : "bad"}">${ok ? "✓" : "!"}</span><h1>${titulo}</h1></div><div class="step-body">${cuerpo}<p><a href="/">Volver al inicio</a></p></div></section></main></html>`);

// Transbank vuelve aquí: se confirma la tarjeta y se hace el cobro
app.all("/retorno", async (req, res) => {
  const token = req.body?.TBK_TOKEN || req.query?.TBK_TOKEN;
  const p = pedidos.get(porToken.get(token));
  if (!p) return pagina(res, "Pago no completado", "<p>No encontramos tu pedido. Vuelve a intentarlo.</p>", false);
  if (p.estado === "pagado") return exito(res, p);
  try {
    const f = await inscripcion.finish(token);
    if (f.response_code !== 0) return pagina(res, "Tarjeta no inscrita", "<p>La inscripción fue cancelada o rechazada. No se realizó ningún cargo.</p>", false);
    const plan = PLANES[p.plan];
    const buyOrder = ("B" + Date.now()).slice(0, 26);
    const a = await mallTx.authorize(p.userName, f.tbk_user, buyOrder, [
      new TransactionDetail(plan.precio, CHILD_CODE, ("C" + Date.now()).slice(0, 26), 1),
    ]);
    const d = a.details[0];
    if (d.status !== "AUTHORIZED" || d.response_code !== 0) {
      return pagina(res, "Pago rechazado", "<p>El banco rechazó el cobro. Puedes intentar con otra tarjeta.</p>", false);
    }
    p.estado = "pagado";
    p.tbkUser = f.tbk_user; // permite cobros futuros (renovaciones) sin volver a pedir la tarjeta
    p.pago = { orden: d.buy_order, monto: d.amount, autorizacion: d.authorization_code, tarjeta: a.card_detail?.card_number || f.card_number, fecha: a.transaction_date };
    guardar();
    enviarBoleta(p).then((r) => { if (r !== "sin-smtp") console.log(`[boleta] enviada a ${p.cliente.email}`); }).catch((e) => console.error("Boleta:", e.message));
    exito(res, p);
  } catch (e) {
    console.error(e);
    pagina(res, "Error al confirmar", "<p>No pudimos confirmar el pago. Si ves un cargo, contáctanos con tu comprobante.</p>", false);
  }
});

function exito(res, p) {
  const plan = PLANES[p.plan];
  pagina(res, "Pago aprobado", `<p>Gracias, <b>${esc(p.cliente.nombre)}</b>. Tu <b>${esc(plan.nombre)}</b> quedó activa.</p>
    <dl class="resumen"><dt>Monto</dt><dd>${clp(p.pago.monto)}</dd><dt>Orden</dt><dd>${esc(p.pago.orden)}</dd><dt>Autorización</dt><dd>${esc(p.pago.autorizacion)}</dd><dt>Tarjeta</dt><dd>•••• ${esc(String(p.pago.tarjeta).slice(-4))}</dd></dl>
    <p>Enviamos la boleta a <b>${esc(p.cliente.email)}</b>.</p>`, true);
}

// ── Boleta ───────────────────────────────────────────────────────────────
// Transbank NO emite boletas. Aquí se envía por correo un comprobante; para una boleta
// electrónica válida ante el SII conecta un proveedor (Bsale, Haulmer/OpenFactura, etc.)
// dentro de emitirBoletaSII() y adjunta su folio/PDF al correo.
async function emitirBoletaSII(_pedido) { return null; /* { folio, urlPdf } */ }

function crearTransporte() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST.trim(), port, secure: port === 465,
    auth: { user: process.env.SMTP_USER.trim(), pass: process.env.SMTP_PASS.replace(/\s+/g, "") }, // Google muestra la clave con espacios
  });
}

async function enviarBoleta(p) {
  const plan = PLANES[p.plan];
  const sii = await emitirBoletaSII(p);
  const transporte = crearTransporte();
  if (!transporte) { console.log(`[boleta] SMTP no configurado (revisa el archivo .env); no se envió a ${p.cliente.email}`); return "sin-smtp"; }
  await transporte.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER, to: p.cliente.email,
    subject: `Boleta · ${plan.nombre}`,
    html: `<h2>Gracias por tu compra, ${esc(p.cliente.nombre)}</h2>
      <p>${esc(plan.nombre)}: <b>${clp(p.pago.monto)}</b></p>
      <p>Orden ${esc(p.pago.orden)} · Autorización ${esc(p.pago.autorizacion)}</p>
      <p>Cliente: ${esc(p.cliente.nombre)} ${esc(p.cliente.apellido)} · RUT ${esc(p.cliente.rut)}</p>
      ${sii ? `<p>Boleta N° ${esc(sii.folio)}: <a href="${esc(sii.urlPdf)}">descargar</a></p>` : ""}`,
  });
}

// ── Panel de administración (protegido con usuario y contraseña) ─────────
function admin(req, res, next) {
  const u = process.env.ADMIN_USER, pw = process.env.ADMIN_PASSWORD;
  if (!u || !pw) return res.status(503).send("Define ADMIN_USER y ADMIN_PASSWORD en el .env para usar el panel.");
  const [user = "", ...rest] = Buffer.from((req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString().split(":");
  const igual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  if (igual(user, u) && igual(rest.join(":"), pw)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Octomation admin"').status(401).send("Autenticación requerida");
}
// Nunca se expone tbkUser (permite cobros futuros).
const vista = (p) => ({ id: p.id, plan: PLANES[p.plan].nombre, precio: PLANES[p.plan].precio, cliente: p.cliente, pago: p.pago });
app.get("/admin", admin, (_q, r) => r.sendFile(path.join(__dirname, "admin", "admin.html")));
app.get("/api/admin/suscripciones", admin, (_q, r) => r.json(
  [...pedidos.values()].filter((p) => p.estado === "pagado" && p.pago).map(vista)
    .sort((a, b) => String(b.pago.fecha).localeCompare(String(a.pago.fecha)))
));

// Elimina la compra del registro y la tarjeta inscrita en Oneclick (no devuelve el dinero).
app.delete("/api/admin/suscripciones/:id", admin, async (q, r) => {
  const p = pedidos.get(q.params.id);
  if (!p || p.estado !== "pagado") return r.status(404).json({ error: "No encontrada" });
  let tarjeta = true;
  if (p.tbkUser) {
    try { await inscripcion.delete(p.tbkUser, p.userName); }
    catch (e) { tarjeta = false; console.error("No se pudo borrar la inscripción en Transbank:", e.message); }
  }
  pedidos.delete(p.id);
  if (p.token) porToken.delete(p.token);
  guardar();
  r.json({ ok: true, tarjeta });
});

app.listen(PORT, () => {
  console.log(`Listo en ${BASE_URL}`);
  const t = crearTransporte();
  if (!t) return console.log("Correo: NO configurado. Copia .env.example como .env y completa SMTP_HOST, SMTP_USER y SMTP_PASS.");
  t.verify().then(() => console.log(`Correo: conexión OK con ${process.env.SMTP_HOST}`)).catch((e) => console.log("Correo: error de conexión →", e.message));
});
