// index.js — Recordatorious (MVP + EDITAR + UX throttle + PMF-early + feedback sin comando)
// Variables (Railway → Variables):
// BOT_TOKEN, SUPABASE_URL, (SUPABASE_SERVICE_ROLE o SUPABASE_ANON_KEY), OWNER_CHAT_ID (opcional)
// OPCIONALES: LOCAL_TZ (por defecto Europe/Madrid), PMF_DEBUG_ALWAYS ("1" para forzar pregunta)

require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

// --- Env ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID || 0);
const LOCAL_TZ = process.env.LOCAL_TZ || "Europe/Madrid";
const PMF_DEBUG_ALWAYS = process.env.PMF_DEBUG_ALWAYS === "1";

if (!BOT_TOKEN || !SUPABASE_URL || (!SUPABASE_SERVICE_ROLE && !SUPABASE_ANON_KEY)) {
  console.error("❌ Falta configurar BOT_TOKEN, SUPABASE_URL y SUPABASE_SERVICE_ROLE o SUPABASE_ANON_KEY");
  process.exit(1);
}

// --- Clientes ---
const bot = new Bot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE || SUPABASE_ANON_KEY);

// --- Utils ---
const toPlainSpaces = (s) =>
  (s || "").replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ").replace(/\s+/g, " ").trim();

const chunkText = (text, size = 3800) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
};
const replySmart = async (ctx, text, extra) => {
  const parts = chunkText(text);
  for (const p of parts) await ctx.reply(p, extra);
};

// Throttle “¿Te fue útil?” cada 3 acciones
const ASK_EVERY = 3;
const usageCounter = new Map();
function shouldAsk(userId, action) {
  const key = `${userId}:${action}`;
  const n = (usageCounter.get(key) || 0) + 1;
  usageCounter.set(key, n);
  return n % ASK_EVERY === 0;
}

// --- Modo feedback sin comando (ventana temporal) ---
const FEEDBACK_WINDOW_MS = 5 * 60 * 1000; // 5 minutos
// Map<userId, expiresAtMs>
const awaitingFeedback = new Map();
function setAwaitingFeedback(userId) {
  awaitingFeedback.set(userId, Date.now() + FEEDBACK_WINDOW_MS);
}
function isAwaitingFeedback(userId) {
  const exp = awaitingFeedback.get(userId);
  if (!exp) return false;
  if (Date.now() > exp) {
    awaitingFeedback.delete(userId);
    return false;
  }
  return true;
}
function clearAwaitingFeedback(userId) {
  awaitingFeedback.delete(userId);
}

// Parsing
const DASH = "[-–—]";
const SAVE_RE  = new RegExp(`^#\\s*(.+?)\\s*${DASH}\\s*(.+)$`, "i");
const QUERY_RE = new RegExp("^\\?\\s*(.+)$");
const DEL_RE   = new RegExp("^-\\s*(.+)$");
const EDIT_FULL_RE = new RegExp(`^\\?\\+\\s*(?:"([^"]+)"|(.+?))\\s*${DASH}\\s*(.+)$`);

const normalizeKey = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

const welcomeMsgHtml =
`👋 ¡Hola! Soy <b>Reco</b>, tu micro-asistente para recordar cosas simples.

<b>Comandos básicos:</b>
#nombre - valor   → guardar  
?nombre           → consultar  
?+nombre - valor  → editar  
-nombre           → borrar  
?*                → listar todo  

💡 Guarda ya el dato más útil (wifi, matrícula, clave bici…) y pruébalo 😉
¿Ideas o fallos? Puedes contármelo escribiendo aquí mismo cuando te lo pregunte. Si quieres ahora: /idea + tu mensaje`;

const helpMsg =
`<b>Cómo usar Reco</b>
Guarda: #nombre - valor
Consulta: ?nombre
Editar: ?+nombre - nuevo valor
Borrar: -nombre
Listar: ?*
Ej.: #wifi casa - PepeWifi / clave123

¿Sugerencias o fallos? /idea + tu mensaje`;

// --- PMF early ---
const PMF_MIN_DISTINCT_DAYS = 5;
const PMF_COOLDOWN_DAYS = 90;

async function countDistinctUsageDays(userId) {
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const { data, error } = await supabase
    .from("events")
    .select("created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error || !data) return 0;

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TZ, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const days = new Set();
  for (const row of data) {
    const d = new Date(row.created_at);
    days.add(fmt.format(d));
  }
  return days.size;
}

async function lastPmfAnswerWithin(userId, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from("pmf_answers")
    .select("created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return false;
  return (data && data.length > 0);
}

async function shouldAskPMF(userId) {
  if (PMF_DEBUG_ALWAYS) return true;
  const hasAnsweredRecently = await lastPmfAnswerWithin(userId, PMF_COOLDOWN_DAYS);
  if (hasAnsweredRecently) return false;
  const distinctDays = await countDistinctUsageDays(userId);
  return distinctDays >= PMF_MIN_DISTINCT_DAYS;
}

async function maybeAskPMF(ctx) {
  const userId = ctx.from.id;
  if (!(await shouldAskPMF(userId))) return;

  const kb = new InlineKeyboard()
    .text("1", "pmf:1").text("2", "pmf:2").text("3", "pmf:3").row()
    .text("4", "pmf:4").text("5", "pmf:5");

  await ctx.reply(
    "🙏 Mini-encuesta: ¿Cuánto te molestaría NO poder usar Reco?\n(1 = nada, 5 = muchísimo)",
    { reply_markup: kb }
  );
}

// --- /start, /help, alias ---
bot.command("start", async (ctx) => {
  const payload = (ctx.match || "").trim();
  await supabase.from("events").insert({
    user_id: ctx.from.id, type: "start", meta: payload ? { source: payload } : null
  });
  await ctx.reply(welcomeMsgHtml, { parse_mode: "HTML", disable_web_page_preview: true });
});
bot.command("help", async (ctx) => ctx.reply(helpMsg, { parse_mode: "HTML", disable_web_page_preview: true }));

// Alias sin slash para onboarding
bot.hears(/^start$/i,  (ctx)=>ctx.reply(welcomeMsgHtml,{parse_mode:"HTML",disable_web_page_preview:true}));
bot.hears(/^help$/i,   (ctx)=>ctx.reply(helpMsg,{parse_mode:"HTML",disable_web_page_preview:true}));

// Feedback: comandos y alias cortos (siguen existiendo, pero ya no son necesarios tras PMF)
async function handleFeedback(ctx, rawText) {
  const text = rawText.trim();
  if (!text) return ctx.reply("✍️ Envíame tu idea así:\n/idea Tu mensaje aquí");
  await supabase.from("feedback").insert({ user_id: ctx.from.id, text });
  if (OWNER_CHAT_ID) {
    try { await ctx.api.sendMessage(OWNER_CHAT_ID, `📝 Feedback de ${ctx.from.id} (@${ctx.from.username || "—"}):\n${text}`); } catch {}
  }
  return ctx.reply("¡Gracias! 💚 Me ayuda a mejorar.");
}
bot.command("feedback", async (ctx) => {
  const raw = (ctx.message.text || "").replace(/^\/feedback\s*/i, "");
  return handleFeedback(ctx, raw);
});
bot.command("idea", async (ctx) => {
  const raw = (ctx.message.text || "").replace(/^\/idea\s*/i, "");
  return handleFeedback(ctx, raw);
});
bot.command("opina", async (ctx) => {
  const raw = (ctx.message.text || "").replace(/^\/opina\s*/i, "");
  return handleFeedback(ctx, raw);
});

// Hints para quien escriba solo la palabra
bot.hears(/^feedback$/i, (ctx)=>ctx.reply('Envíame tu idea así:\n/idea Tu mensaje aquí'));
bot.hears(/^idea$/i,     (ctx)=>ctx.reply('Escribe:\n/idea Tu mensaje aquí'));
bot.hears(/^opina$/i,    (ctx)=>ctx.reply('Escribe:\n/opina Tu mensaje aquí'));

// PMF: control y debug
bot.command("encuesta", async (ctx) => { await maybeAskPMF(ctx); });
bot.command("debugpmf", async (ctx) => {
  const d = await countDistinctUsageDays(ctx.from.id);
  const recent = await lastPmfAnswerWithin(ctx.from.id, PMF_COOLDOWN_DAYS);
  await ctx.reply(
    `PMF debug:\n- Días distintos: ${d}\n- Contestó últimos ${PMF_COOLDOWN_DAYS} días: ${recent}\n- Forzar por var: ${PMF_DEBUG_ALWAYS ? "sí" : "no"}\n` +
    `→ ${(!recent && (d >= PMF_MIN_DISTINCT_DAYS)) || PMF_DEBUG_ALWAYS ? "PREGUNTARÍA" : "NO preguntaría"}`
  );
});

// Reacciones rápidas (👍/👎) y PMF (1–5)
const uxKeyboard = (action) => new InlineKeyboard().text("👍 Útil", `ux:${action}:1`).text("👎 No", `ux:${action}:0`);
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data || "";

  // PMF callback
  const pmf = data.match(/^pmf:(1|2|3|4|5)$/);
  if (pmf) {
    const score = Number(pmf[1]);
    await supabase.from("pmf_answers").insert({ user_id: ctx.from.id, score });
    await ctx.answerCallbackQuery({ text: `¡Gracias! (${score}/5)` });

    // Activar modo "esperando feedback" sin comando (5 minutos)
    setAwaitingFeedback(ctx.from.id);
    await ctx.reply(
      "🙏 Para ayudarme a mejorar, cuéntame aquí mismo en una frase: ¿qué echarías más de menos si no pudieras usar Reco?\n" +
      "✍️ Escribe tu comentario ahora (sin comandos)."
    );
    return;
  }

  // UX quick reactions
  const m = data.match(/^ux:(save|query|delete|edit):(1|0)$/);
  if (!m) return ctx.answerCallbackQuery();
  const action = m[1];
  const useful = m[2] === "1";
  await supabase.from("quick_reactions").insert({ user_id: ctx.from.id, action, useful });
  await ctx.answerCallbackQuery({ text: useful ? "¡Gracias! 🙌" : "Gracias por avisar 💡" });
});

// --- Handler principal ---
bot.on("message:text", async (ctx) => {
  const original = ctx.message.text || "";
  const incoming = toPlainSpaces(original);

  // 0) ¿Está el usuario en modo "esperando feedback"?
  //    Si el mensaje NO parece un comando (#, ?, ?+, -, /), lo guardamos como feedback y salimos.
  if (isAwaitingFeedback(ctx.from.id)) {
    const looksLikeCommand =
      /^#/.test(incoming) ||
      /^\?(\+)?/.test(incoming) ||
      /^-/.test(incoming) ||
      /^\//.test(incoming);

    if (!looksLikeCommand && incoming.length > 0) {
      await supabase.from("feedback").insert({ user_id: ctx.from.id, text: incoming });
      if (OWNER_CHAT_ID) {
        try { await ctx.api.sendMessage(OWNER_CHAT_ID, `📝 Feedback (post-PMF) de ${ctx.from.id} (@${ctx.from.username || "—"}):\n${incoming}`); } catch {}
      }
      clearAwaitingFeedback(ctx.from.id);
      await ctx.reply("¡Gracias por tu idea! 💚");
      // seguimos sin procesar más (no es comando)
      return;
    }
    // Si sí parecía comando, no consumimos el modo feedback; dejamos que se procese normal.
  }

  // 1) Soportar múltiples líneas / múltiples # en un mismo mensaje
  const lines = incoming.split(/(?:\r?\n|(?=#))/).map(l => l.trim()).filter(Boolean);
  const outputs = [];

  for (const line of lines) {
    // 1) LISTAR TODO (?* o ?* <página>)
    if (/^\?\*\s*\d*$/.test(line)) {
      const m = line.match(/^\?\*\s*(\d+)?$/);
      const page = Math.max(1, parseInt(m?.[1] || "1", 10));
      const pageSize = 50;

      const res = await supabase
        .from("records")
        .select("key_text,value", { count: "exact" })
        .eq("user_id", ctx.from.id)
        .order("created_at", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      if (res.error) outputs.push(`⚠️ Error listando: ${res.error.message}`);
      else if (!res.data || res.data.length === 0) outputs.push(page === 1 ? "📭 No tienes registros aún." : `📭 Página ${page} vacía.`);
      else {
        const total = res.count ?? res.data.length;
        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        const header = `🗂️ Tus registros (página ${page}/${maxPage}, total ${total})`;
        const body = res.data.map(r => `• #${r.key_text.replace(/^#/, "")} - ${r.value}`).join("\n");
        outputs.push(`${header}\n${body}\n\n➡️ Usa \`?* ${page + 1}\` para la siguiente página.`);
      }
      continue;
    }

    // 2) GUARDAR (#clave - valor)
    let m = line.match(SAVE_RE);
    if (m) {
      const rawKey = toPlainSpaces(m[1]);
      const value  = toPlainSpaces(m[2]);
      const keyNorm = normalizeKey(rawKey);

      const { error } = await supabase
        .from("records")
        .upsert({ user_id: ctx.from.id, key_norm: keyNorm, key_text: rawKey, value }, { onConflict: "user_id,key_norm" });

      await supabase.from("events").insert({ user_id: ctx.from.id, type: "save", meta: { key_norm: keyNorm } });

      outputs.push(error ? `⚠️ Error guardando "${rawKey}": ${error.message}` : `✅ Guardado: "${rawKey}" → "${value}"`);
      if (shouldAsk(ctx.from.id, "save")) await ctx.reply("¿Te fue útil?", { reply_markup: uxKeyboard("save") });
      continue;
    }

    // 3) EDITAR (?+nombre - nuevo valor)
    if (/^\?\+/.test(line)) {
      const mm = line.match(EDIT_FULL_RE);
      if (!mm) { outputs.push('Formato: ?+nombre - nuevo valor\nEj.: ?+"cumple john" - 11/12'); continue; }

      const rawKey   = toPlainSpaces((mm[1] || mm[2] || "").replace(/^"|"$/g, ""));
      const newValue = toPlainSpaces(mm[3] || "");
      if (!rawKey) { outputs.push("Falta el nombre del recordatorio."); continue; }
      if (!newValue) { outputs.push(`El nuevo valor está vacío. Usa: ?+${rawKey} - nuevo valor`); continue; }
      const keyNorm = normalizeKey(rawKey);

      const { data: row, error: findErr } = await supabase
        .from("records").select("id,key_text,value")
        .eq("user_id", ctx.from.id).eq("key_norm", keyNorm).maybeSingle();

      if (findErr) { outputs.push(`⚠️ Error buscando "${rawKey}": ${findErr.message}`); continue; }
      if (!row)    { outputs.push(`⚠️ No encontré "${rawKey}"`); continue; }

      const { data: updated, error: upErr } = await supabase
        .from("records").update({ value: newValue, key_text: rawKey }).eq("id", row.id)
        .select("key_text,value").maybeSingle();

      await supabase.from("events").insert({ user_id: ctx.from.id, type: "edit", meta: { key_norm: keyNorm } });

      if (upErr) outputs.push(`⚠️ Error actualizando "${rawKey}": ${upErr.message}`);
      else       outputs.push(`📝 "${updated.key_text}" actualizado → ${updated.value} ✅`);

      if (shouldAsk(ctx.from.id, "edit")) await ctx.reply("¿Te fue útil?", { reply_markup: uxKeyboard("edit") });
      continue;
    }

    // 4) CONSULTAR (?clave, también por prefijo)
    if (QUERY_RE.test(line)) {
      const q = toPlainSpaces(line.replace(/^\?\s*/, ""));
      const keyNorm = normalizeKey(q);

      const { data, error } = await supabase
        .from("records").select("key_text,value")
        .eq("user_id", ctx.from.id)
        .ilike("key_norm", `%${keyNorm}%`).limit(50);

      await supabase.from("events").insert({ user_id: ctx.from.id, type: "query", meta: { key_norm: keyNorm, results: data ? data.length : 0 } });

      if (error) outputs.push(`⚠️ Error consultando "${q}": ${error.message}`);
      else if (!data || data.length === 0) outputs.push(`⚠️ No encontré "${q}"`);
      else if (data.length === 1) outputs.push(`🔍 #${data[0].key_text.replace(/^#/, "")} - ${data[0].value}`);
      else outputs.push("🔎 Coincidencias:\n" + data.map(r => `• #${r.key_text.replace(/^#/, "")} - ${r.value}`).join("\n"));

      if (shouldAsk(ctx.from.id, "query")) await ctx.reply("¿Te fue útil?", { reply_markup: uxKeyboard("query") });
      continue;
    }

    // 5) BORRAR (-clave)
    m = line.match(DEL_RE);
    if (m) {
      const rawKey = toPlainSpaces(m[1]);
      const keyNorm = normalizeKey(rawKey);

      const { data, error } = await supabase
        .from("records").delete().eq("user_id", ctx.from.id).eq("key_norm", keyNorm)
        .select("key_text").maybeSingle();

      await supabase.from("events").insert({ user_id: ctx.from.id, type: "delete", meta: { key_norm: keyNorm } });

      outputs.push(error ? `⚠️ Error borrando "${rawKey}": ${error.message}`
                         : data ? `🗑️ Borrado: "${data.key_text}"` : `⚠️ No había nada con "${rawKey}"`);

      if (shouldAsk(ctx.from.id, "delete")) await ctx.reply("¿Te fue útil?", { reply_markup: uxKeyboard("delete") });
      continue;
    }

    // 6) No reconocido
    outputs.push(
      "⚠️ Formato no reconocido. Usa:\n" +
      "#nombre - valor  (— o – también valen)\n" +
      "Consultar: ?nombre  |  Listar: ?*\n" +
      "Editar: ?+nombre - nuevo valor  |  Borrar: -nombre\n" +
      "Sugerencias: /idea + tu mensaje"
    );
  }

  await replySmart(ctx, outputs.join("\n"));

  // Intentar PMF al final
  await maybeAskPMF(ctx);
});

// --- Arranque ---
bot.start({ onStart: () => console.log("✅ Recordatorious bot is running…") });
