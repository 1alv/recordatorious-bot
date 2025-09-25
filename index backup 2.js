// index.js — Recordatorious (MVP Free) — versión “fina” (sin <br/>)

// Requisitos: .env con BOT_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY
require("dotenv").config();
const { Bot } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

// --- Variables de entorno ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Falta configurar BOT_TOKEN, SUPABASE_URL o SUPABASE_ANON_KEY en .env");
  process.exit(1);
}

// --- Clientes ---
const bot = new Bot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- Utilidades de normalización y envío largo ---
const toPlainSpaces = (s) =>
  (s || "")
    // espacios no estándar → espacio normal
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    // colapsar espacios múltiples
    .replace(/\s+/g, " ")
    .trim();

const chunkText = (text, size = 3800) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
};

const replySmart = async (ctx, text, extra) => {
  const parts = chunkText(text);
  for (const p of parts) await ctx.reply(p, extra);
};

// --- Expresiones y helpers de parsing ---
const DASH = "[-–—]"; // acepta -, – y —
const SAVE_RE  = new RegExp(`^#\\s*(.+?)\\s*${DASH}\\s*(.+)$`, "i"); // #clave -/–/— valor
const QUERY_RE = new RegExp("^\\?\\s*(.+)$");                         // ?clave
const DEL_RE   = new RegExp("^-\\s*(.+)$");                           // -clave

const normalizeKey = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // sin acentos
    .replace(/\s+/g, " ")
    .trim();

// --- Mensaje de bienvenida (/start) en HTML, usando \n ---
const welcomeMsgHtml =
`👋 ¡Hola! Espero que estés fenomenal.
Soy <b>Reco</b>, tu maestro de llaves para recordar cualquier dato simple.

Puede ser cumpleaños de amigos, clave de tu casa, dónde has aparcado, algún teléfono de interés, la talla de pie de tus hijos, e incluso un texto largo de un mensaje que quieras guardar o tus propias notas personales… ¡todo lo que se te ocurra!

Solo tienes que hacerlo así 👇

<b>Guarda un dato con:</b>
#nombre - valor

<b>Consúltalo con:</b>
?nombre

<b>Bórralo con:</b>
-nombre

<b>Listar todo lo tuyo:</b>
?*

<b>Ejemplos:</b>
• #tel papá - 612345678
• #tel mamá - 612345679
• #candado bici - 1234
• #clave tarjeta - 4321
• #cita médico - 12/10 10:00h
• #toma vitaminas - 08:00h cada día
• #matrícula coche - 1234ABC
• #talla zapato Juan - 42
• #wifi casa - PepeWifi / clave123

También puedes pegar <b>varias líneas</b> en un mismo mensaje (una por recordatorio) y los guardo todos.

¡Adelante, prueba y me dices 🙂!`;

bot.command("start", async (ctx) => {
  await ctx.reply(welcomeMsgHtml, { parse_mode: "HTML", disable_web_page_preview: true });
});

// --- Handler principal de texto ---
bot.on("message:text", async (ctx) => {
  // Pre-limpieza: espacios raros -> normales
  const incoming = toPlainSpaces(ctx.message.text || "");
  // Multilínea: cada línea se trata como operación independiente
  const lines = incoming.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const outputs = [];

  for (const line of lines) {
    // 1) LISTAR TODO (?* o ?* <página>)
    if (/^\?\*\s*\d*$/.test(line)) {
      const m = line.match(/^\?\*\s*(\d+)?$/);
      const page = Math.max(1, parseInt(m?.[1] || "1", 10));
      const pageSize = 50;

      const { data, error, count } = await supabase
        .from("records")
        .select("key_text,value", { count: "exact" })
        .eq("user_id", ctx.from.id)
        .order("created_at", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      if (error) {
        outputs.push(`⚠️ Error listando: ${error.message}`);
      } else if (!data || data.length === 0) {
        outputs.push(page === 1 ? "📭 No tienes registros aún." : `📭 Página ${page} vacía.`);
      } else {
        const total = count ?? data.length;
        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        const header = `🗂️ Tus registros (página ${page}/${maxPage}, total ${total})`;
        const body = data.map(r => `• ${r.key_text} → ${r.value}`).join("\n");
        outputs.push(`${header}\n${body}\n\n➡️ Usa \`?* ${page + 1}\` para la siguiente página.`);
      }
      continue;
    }

    // 2) GUARDAR (#clave -/–/— valor)
    let m = line.match(SAVE_RE);
    if (m) {
      const rawKey = toPlainSpaces(m[1]);
      const value  = toPlainSpaces(m[2]);
      const keyNorm = normalizeKey(rawKey);

      const { error } = await supabase
        .from("records")
        .upsert(
          { user_id: ctx.from.id, key_norm: keyNorm, key_text: rawKey, value },
          { onConflict: "user_id,key_norm" }
        );

      outputs.push(error
        ? `⚠️ Error guardando "${rawKey}": ${error.message}`
        : `✅ Guardado: "${rawKey}" → "${value}"`);
      continue;
    }

    // 3) CONSULTAR (?clave, también por prefijo)
    if (QUERY_RE.test(line)) {
      const q = toPlainSpaces(line.replace(/^\?\s*/, ""));
      const keyNorm = normalizeKey(q);

      const { data, error } = await supabase
        .from("records")
        .select("key_text,value")
        .eq("user_id", ctx.from.id)
        .ilike("key_norm", `%${keyNorm}%`)
        .limit(50);

      if (error) outputs.push(`⚠️ Error consultando "${q}": ${error.message}`);
      else if (!data || data.length === 0) outputs.push(`⚠️ No encontré "${q}"`);
      else if (data.length === 1) outputs.push(`🔍 "${data[0].key_text}": ${data[0].value}`);
      else outputs.push("🔎 Coincidencias:\n" + data.map(r => `• ${r.key_text} → ${r.value}`).join("\n"));
      continue;
    }

    // 4) BORRAR (-clave)
    m = line.match(DEL_RE);
    if (m) {
      const rawKey = toPlainSpaces(m[1]);
      const keyNorm = normalizeKey(rawKey);

      const { data, error } = await supabase
        .from("records")
        .delete()
        .eq("user_id", ctx.from.id)
        .eq("key_norm", keyNorm)
        .select("key_text")
        .maybeSingle();

      outputs.push(error
        ? `⚠️ Error borrando "${rawKey}": ${error.message}`
        : data ? `🗑️ Borrado: "${data.key_text}"`
              : `⚠️ No había nada con "${rawKey}"`);
      continue;
    }

    // 5) Formato no reconocido
    outputs.push(
      "⚠️ Formato no reconocido. Usa:\n" +
      "#clave - valor  (también vale – o —)\n" +
      "Consultar: ?clave  |  Listar todo: ?*\n" +
      "Borrar: -clave"
    );
  }

  // Responder (si pega varias líneas, lo agregamos y partimos si es largo)
  await replySmart(ctx, outputs.join("\n"));
});

// --- Arranque ---
bot.start({
  onStart: () => console.log("✅ Recordatorious bot is running…")
});
