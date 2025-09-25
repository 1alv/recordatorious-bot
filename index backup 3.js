// index.js — Recordatorious (MVP Free + feedback/UX/metrics)
// Requisitos en .env: BOT_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY

require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

// --- Env ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Falta configurar BOT_TOKEN, SUPABASE_URL o SUPABASE_ANON_KEY en .env");
  process.exit(1);
}

// Si quieres, luego metemos OWNER_CHAT_ID en .env; por ahora 0 para que no reenvíe si no está:
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID || 0);

// --- Clientes ---
const bot = new Bot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- Utilidades ---
const toPlainSpaces = (s) =>
  (s || "")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
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

// Parsing
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

// --- Mensaje bienvenida (/start) en HTML ---
const welcomeMsgHtml =
`👋 ¡Hola! Espero que estés fenomenal.
Soy <b>Reco</b>, tu micro-asistente personal en el chat para recordar cualquier dato simple.

Puede ser cumpleaños de amigos, clave de tu casa, dónde has aparcado, algún teléfono de interés, la talla de pie de tus hijos, e incluso un texto largo que quieras guardar o notas personales… ¡lo que se te ocurra!

Solo tienes que hacerlo así 👇

<b>Guarda un dato con:</b>
#nombre - valor

<b>Consúltalo con:</b>
?nombre

<b>Bórralo con:</b>
-nombre

<b>Editar </b>:
?+nombre - valor

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

¿Ideas o fallos? Escribe /feedback seguido de tu mensaje. ¡Muchas Gracias 🙂!

Ahora ánimate y guarda algún recordatorio, seguro tienes cosas de las que mejor tener a mano para cuando las necesites recordar`;

// --- /start con deep-link (mide origen con ?start=ig, ?start=qr, etc.) ---
bot.command("start", async (ctx) => {
  const payload = (ctx.match || "").trim(); // origen opcional
  if (payload) {
    await supabase.from("events").insert({
      user_id: ctx.from.id,
      type: "start",
      meta: { source: payload }
    });
  } else {
    await supabase.from("events").insert({
      user_id: ctx.from.id,
      type: "start",
      meta: null
    });
  }
  await ctx.reply(welcomeMsgHtml, { parse_mode: "HTML", disable_web_page_preview: true });
});

// --- /whoami: te dice tu chat_id (una vez lo veas, puedes quitar este comando si quieres) ---
bot.command("whoami", (ctx) => ctx.reply(`Tu chat_id es: ${ctx.from.id}`));

// --- /feedback: guarda en DB y opcionalmente reenvía al OWNER_CHAT_ID ---
bot.command("feedback", async (ctx) => {
  const raw = (ctx.message.text || "").replace(/^\/feedback\s*/i, "").trim();
  if (!raw) {
    return ctx.reply("✍️ Cuéntame qué mejorar. Ejemplo:\n/feedback Estaría bien exportar todo a TXT");
  }
  await supabase.from("feedback").insert({ user_id: ctx.from.id, text: raw });
  if (OWNER_CHAT_ID) {
    try {
      await ctx.api.sendMessage(
        OWNER_CHAT_ID,
        `📝 Feedback de ${ctx.from.id} (@${ctx.from.username || "—"}):\n${raw}`
      );
    } catch {}
  }
  return ctx.reply("¡Muchas Gracias! 💚 Esto me ayuda para darte un mejor servicio. Feliz día 🤗");
});

// --- Reacciones rápidas (👍/👎) ---
const uxKeyboard = (action) =>
  new InlineKeyboard()
    .text("👍 Útil", `ux:${action}:1`)
    .text("👎 No",   `ux:${action}:0`);

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
  const m = data.match(/^ux:(save|query|delete):(1|0)$/);
  if (!m) return ctx.answerCallbackQuery();
  const action = m[1];
  const useful = m[2] === "1";
  await supabase.from("quick_reactions").insert({
    user_id: ctx.from.id, action, useful
  });
  await ctx.answerCallbackQuery({ text: useful ? "¡Gracias! 🙌" : "Gracias por avisar 💡" });
});

// --- Handler principal de texto ---
bot.on("message:text", async (ctx) => {
  const incoming = toPlainSpaces(ctx.message.text || "");
  const lines = incoming.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const outputs = [];

  for (const line of lines) {
    // 1) LISTAR TODO (?* o ?* <página>)
    if (/^\?\*\s*\d*$/.test(line)) {
      const m = line.match(/^\?\*\s*(\d+)?$/);
      const page = Math.max(1, parseInt(m?.[1] || "1", 10));
      const pageSize = 50;

      const { data, error, count } = await supabase
        .from("events"); // dummy to keep connection warm (optional)
      void data; void error; void count;

      const res = await supabase
        .from("records")
        .select("key_text,value", { count: "exact" })
        .eq("user_id", ctx.from.id)
        .order("created_at", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      if (res.error) {
        outputs.push(`⚠️ Error listando: ${res.error.message}`);
      } else if (!res.data || res.data.length === 0) {
        outputs.push(page === 1 ? "📭 No tienes registros aún." : `📭 Página ${page} vacía.`);
      } else {
        const total = res.count ?? res.data.length;
        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        const header = `🗂️ Tus registros (página ${page}/${maxPage}, total ${total})`;
        const body = res.data.map(r => `• ${r.key_text} → ${r.value}`).join("\n");
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

      await supabase.from("events").insert({
        user_id: ctx.from.id, type: "save", meta: { key_norm: keyNorm }
      });

      outputs.push(error
        ? `⚠️ Error guardando "${rawKey}": ${error.message}`
        : `✅ Guardado: "${rawKey}" → "${value}"`);

      // (Opcional) pedir reacción
      outputs.push("¿Te fue útil? (pulsa 👍/👎)");
      await ctx.reply("¿Te fue útil?", { reply_markup: uxKeyboard("save") });
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

      await supabase.from("events").insert({
        user_id: ctx.from.id,
        type: "query",
        meta: { key_norm: keyNorm, results: data ? data.length : 0 }
      });

      if (error) outputs.push(`⚠️ Error consultando "${q}": ${error.message}`);
      else if (!data || data.length === 0) outputs.push(`⚠️ No encontré "${q}"`);
      else if (data.length === 1) outputs.push(`🔍 "${data[0].key_text}": ${data[0].value}`);
      else outputs.push("🔎 Coincidencias:\n" + data.map(r => `• ${r.key_text} → ${r.value}`).join("\n"));

      await ctx.reply("¿Te fue útil?", { reply_markup: uxKeyboard("query") });
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

      await supabase.from("events").insert({
        user_id: ctx.from.id, type: "delete", meta: { key_norm: keyNorm }
      });

      outputs.push(error
        ? `⚠️ Error borrando "${rawKey}": ${error.message}`
        : data ? `🗑️ Borrado: "${data.key_text}"`
              : `⚠️ No había nada con "${rawKey}"`);

      await ctx.reply("¿Te fue útil?", { reply_markup: uxKeyboard("delete") });
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

  await replySmart(ctx, outputs.join("\n"));
});

// --- Arranque ---
bot.start({
  onStart: () => console.log("✅ Recordatorious bot is running…")
});
