// index.js — Recordatorious (MVP + EDITAR + UX + PMF-early + feedback post-PMF + métricas avanzadas)
// Variables (Railway → Variables):
// BOT_TOKEN, SUPABASE_URL, (SUPABASE_SERVICE_ROLE o SUPABASE_ANON_KEY), OWNER_CHAT_ID (opcional)
// OPCIONALES: LOCAL_TZ (por defecto Europe/Madrid), PMF_DEBUG_ALWAYS ("1" para forzar PMF)

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

// Helpers fecha/hora
const fmtYMD = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};
// Semana empezando lunes; offset 0=actual, -1=pasada…
function rangeISOForWeek(offset = 0) {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0..6 (lunes=0)
  const monday = new Date(now);
  monday.setDate(now.getDate() - dow + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return {
    since: monday.toISOString(),
    until: nextMonday.toISOString(),
    label: `${fmtYMD(monday)} → ${fmtYMD(nextMonday)}`
  };
}

// Throttle “¿Te fue útil?” cada 3 acciones
const ASK_EVERY = 3;
const usageCounter = new Map();
function shouldAsk(userId, action) {
  const key = `${userId}:${action}`;
  const n = (usageCounter.get(key) || 0) + 1;
  usageCounter.set(key, n);
  return n % ASK_EVERY === 0;
}

// --- Modo feedback libre post-PMF (ventana 5 min) ---
const FEEDBACK_WINDOW_MS = 5 * 60 * 1000;
const awaitingFeedback = new Map(); // Map<userId, expiresAtMs>
function setAwaitingFeedback(userId) { awaitingFeedback.set(userId, Date.now() + FEEDBACK_WINDOW_MS); }
function isAwaitingFeedback(userId) {
  const exp = awaitingFeedback.get(userId);
  if (!exp) return false;
  if (Date.now() > exp) { awaitingFeedback.delete(userId); return false; }
  return true;
}
function clearAwaitingFeedback(userId) { awaitingFeedback.delete(userId); }

// Parsing
const DASH = "[-–—]";
const SAVE_RE  = new RegExp(`^#\\s*(.+?)\\s*${DASH}\\s*(.+)$`, "i");
const QUERY_RE = new RegExp("^\\?\\s*(.+)$");
const DEL_RE   = new RegExp("^-\\s*(.+)$");

// EDITAR
const EDIT_FULL_RE = new RegExp(`^\\?\\+\\s*(?:"([^"]+)"|(.+?))\\s*${DASH}\\s*(.+)$`);

const normalizeKey = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// --- Mensajes (tu bienvenida intacta) ---
const welcomeMsgHtml =
`👋 ¡Hola! Espero que estés fenomenal.
Soy <b>Reco</b>, tu micro-asistente personal en el chat para recordar cualquier dato simple.

📌 <b>¿Qué puedo hacer por ti?</b>
• Guardar cumpleaños, claves, citas, notas rápidas… lo que quieras.  
• Consultar cualquier dato en segundos.  
• Editar y borrar cuando cambien las cosas.  
• Listar todo lo tuyo en una sola página.  

<b>Comandos básicos:</b>
#nombre - valor   → guardar  
?nombre           → consultar  
?+nombre - valor  → editar  
-nombre           → borrar  
?*                → listar todo  

<b>Ejemplos:</b>
• #tel mamá - 612345679
• #candado bici - 1234
• #clave tarjeta - 4321
• #cita médico - 12/10 10:00h
• #toma vitaminas - 08:00h cada día
• #matrícula coche - 1234ABC
• #talla zapato Juan - 42
• #wifi casa - PepeWifi / clave123

💡 <b>Nudge inicial:</b>  
Guarda <b>ahora mismo</b> el dato que más veces repites o que quieres tener siempre a mano (ej: wifi, matrícula, clave bici).  
Así verás en un segundo el poder de tenerlo rápido 😉  

¿Ideas o fallos? Escríbeme con /feedback.  
¡Gracias por probar Reco y que disfrutes la experiencia ✨!`;

const helpMsg =
`<b>Cómo usar Reco</b>
Guarda: #nombre - valor
Consulta: ?nombre
Editar: ?+nombre - nuevo valor
Borrar: -nombre
Listar: ?*
Ej.: #wifi casa - PepeWifi / clave123`;

// --- PMF early ---
const PMF_MIN_DISTINCT_DAYS = 5;   // pide encuesta a partir de 5 días distintos
const PMF_COOLDOWN_DAYS = 90;      // no repetir pregunta si contestó en últimos 90 días

// Cuenta días distintos de uso desde los últimos 180 días
async function countDistinctUsageDays(userId) {
  const since = new Date(Date.now() - 180 * 86400000).toISOString();
  const { data, error } = await supabase
    .from("events")
    .select("created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error || !data) return 0;

  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: LOCAL_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const days = new Set();
  for (const row of data) days.add(fmt.format(new Date(row.created_at)));
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
  await supabase.from("events").insert({ user_id: ctx.from.id, type: "start", meta: payload ? { source: payload } : null });
  await ctx.reply(welcomeMsgHtml, { parse_mode: "HTML", disable_web_page_preview: true });
});
bot.command("help", async (ctx) => ctx.reply(helpMsg, { parse_mode: "HTML", disable_web_page_preview: true }));
bot.hears(/^start$/i,  (ctx)=>ctx.reply(welcomeMsgHtml,{parse_mode:"HTML",disable_web_page_preview:true}));
bot.hears(/^help$/i,   (ctx)=>ctx.reply(helpMsg,{parse_mode:"HTML",disable_web_page_preview:true}));
bot.hears(/^feedback$/i,(ctx)=>ctx.reply('Escribe:\n/feedback Tu mensaje aquí'));

// /whoami + /feedback
bot.command("whoami", (ctx) => ctx.reply(`Tu chat_id es: ${ctx.from.id}`));
bot.command("feedback", async (ctx) => {
  const raw = (ctx.message.text || "").replace(/^\/feedback\s*/i, "").trim();
  if (!raw) return ctx.reply("✍️ Ejemplo:\n/feedback Estaría bien exportar todo a TXT");
  await supabase.from("feedback").insert({ user_id: ctx.from.id, text: raw });
  if (OWNER_CHAT_ID) {
    try { await ctx.api.sendMessage(OWNER_CHAT_ID, `📝 Feedback de ${ctx.from.id} (@${ctx.from.username || "—"}):\n${raw}`); } catch {}
  }
  return ctx.reply("¡Muchas Gracias! 💚 Me ayuda muchisimo a mejorar.");
});

// --- /stats: métricas mejoradas ---
bot.command("stats", async (ctx) => {
  try {
    // Total de recordatorios
    const { count: recCount } = await supabase.from("records").select("*", { count: "exact", head: true });

    // Usuarios únicos de verdad (últimos 365 días para no traer infinito)
    const since365 = new Date(Date.now() - 365 * 86400000).toISOString();
    const { data: evAll } = await supabase
      .from("events")
      .select("user_id, type, created_at, meta")
      .gte("created_at", since365)
      .limit(100000);
    const uniqAll = new Set((evAll || []).map(e => e.user_id)).size;

    // Activos últimos 7 días
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: ev7d } = await supabase
      .from("events")
      .select("user_id")
      .gte("created_at", since7)
      .limit(100000);
    const active7d = new Set((ev7d || []).map(e => e.user_id)).size;

    // Error rate por formato no reconocido (últimos 30 días)
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: ev30 } = await supabase
      .from("events")
      .select("type, created_at")
      .gte("created_at", since30)
      .in("type", ["save", "query", "edit", "delete", "list", "unrecognized"])
      .limit(100000);
    const totalTracked = (ev30 || []).length;
    const unrec = (ev30 || []).filter(e => e.type === "unrecognized").length;
    const errRate = totalTracked ? (unrec / totalTracked) : 0;

    // Retención 7 días (cohorte primeros 30 días)
    const since60 = new Date(Date.now() - 60 * 86400000).toISOString(); // margen para cubrir semanas
    const { data: ev60 } = await supabase
      .from("events")
      .select("user_id, created_at")
      .gte("created_at", since60)
      .order("created_at", { ascending: true })
      .limit(100000);

    const firstSeen = new Map(); // userId -> firstDate
    const daysWithinWeek = new Map(); // userId -> Set(YYYY-MM-DD) dentro de la primera semana

    for (const e of ev60 || []) {
      const uid = e.user_id;
      const t = new Date(e.created_at);
      if (!firstSeen.has(uid)) {
        firstSeen.set(uid, t);
        daysWithinWeek.set(uid, new Set([fmtYMD(t)]));
      } else {
        const start = firstSeen.get(uid);
        const diff = (t - start) / 86400000;
        if (diff < 7) {
          daysWithinWeek.get(uid)?.add(fmtYMD(t));
        }
      }
    }
    // Cohorte: usuarios cuyo firstSeen es en últimos 30 días
    const cohortSince = new Date(Date.now() - 30 * 86400000);
    let cohort = 0, retained = 0;
    for (const [uid, start] of firstSeen.entries()) {
      if (start >= cohortSince) {
        cohort++;
        const set = daysWithinWeek.get(uid) || new Set();
        if (set.size >= 2) retained++;
      }
    }
    const retention7d = cohort ? (retained / cohort) : 0;

    await ctx.reply(
      `📊 <b>Estadísticas Reco</b>\n\n` +
      `• Recordatorios guardados: <b>${recCount ?? 0}</b>\n` +
      `• Usuarios únicos (12 meses): <b>${uniqAll}</b>\n` +
      `• Activos últimos 7 días: <b>${active7d}</b>\n` +
      `• Fallos de formato (30d): <b>${(errRate * 100).toFixed(1)}%</b>  (${unrec}/${totalTracked})\n` +
      `• Retención 7d (cohorte 30d): <b>${(retention7d * 100).toFixed(1)}%</b>  (${retained}/${cohort})`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await ctx.reply(`⚠️ Error en /stats: ${e.message || e}`);
  }
});

// --- /pmf: distribución respuestas PMF ---
bot.command("pmf", async (ctx) => {
  const { data, error } = await supabase.from("pmf_answers").select("score");
  if (error || !data) return ctx.reply("📭 Aún no hay respuestas PMF.");
  if (data.length === 0) return ctx.reply("📭 Aún no hay respuestas PMF.");

  const total = data.length;
  const dist = [1,2,3,4,5].map(s => ({ s, n: data.filter(d => d.score === s).length }));
  const pct = (n) => ((n / total) * 100).toFixed(1);
  const lines = dist.map(d => `${d.s}: ${d.n} (${pct(d.n)}%)`);
  const strong = dist.filter(d => d.s >= 4).reduce((sum, d) => sum + d.n, 0);

  await ctx.reply(
    `📊 <b>Resultados PMF</b>\n\n${lines.join("\n")}\n\n` +
    `Total: ${total}\nUsuarios que sufrirían (4–5): ${strong} (${pct(strong)}%)`,
    { parse_mode: "HTML" }
  );
});

// --- /top — Top consultas/guardados por semana o rango custom (solo admin) ---
bot.command("top", async (ctx) => {
  if (!(OWNER_CHAT_ID && ctx.from?.id === OWNER_CHAT_ID)) {
    return ctx.reply("Comando solo para admin.");
  }
  const raw = (ctx.match || "").trim();
  const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  let since, until, label;
  if (!raw) {
    ({ since, until, label } = rangeISOForWeek(0));
  } else {
    const parts = raw.split(/\s+/);
    if (parts.length === 1 && /^-?\d+$/.test(parts[0])) {
      const weekOffset = parseInt(parts[0], 10);
      ({ since, until, label } = rangeISOForWeek(weekOffset));
    } else if (parts.length === 2 && isYMD(parts[0]) && isYMD(parts[1])) {
      const s = new Date(parts[0] + "T00:00:00Z");
      const e = new Date(parts[1] + "T00:00:00Z");
      if (!(s instanceof Date && !isNaN(s)) || !(e instanceof Date && !isNaN(e)) || e <= s) {
        return ctx.reply("Formato inválido. Usa: /top YYYY-MM-DD YYYY-MM-DD (end > start).");
      }
      since = s.toISOString();
      until = e.toISOString();
      label = `${parts[0]} → ${parts[1]}`;
    } else {
      return ctx.reply(
        "Uso:\n" +
        "• /top              → semana actual\n" +
        "• /top -1           → semana pasada\n" +
        "• /top -2           → hace dos semanas\n" +
        "• /top 2025-09-01 2025-09-07  → rango personalizado"
      );
    }
  }

  try {
    const tally = (rows = []) => {
      const m = new Map();
      for (const r of rows) {
        const k = r?.meta?.key_norm;
        if (!k) continue;
        m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    };

    const { data: saves } = await supabase
      .from("events").select("meta, created_at")
      .eq("type", "save").gte("created_at", since).lt("created_at", until);
    const { data: queries } = await supabase
      .from("events").select("meta, created_at")
      .eq("type", "query").gte("created_at", since).lt("created_at", until);

    const topSaves = tally(saves);
    const topQueries = tally(queries);
    const fmt = (arr) => (arr.length ? arr.map(([k, n], i) => `${i + 1}. ${k} (${n})`).join("\n") : "—");

    await ctx.reply(
      `📌 <b>Top por ${label}</b>\n` +
      `<b>🔐 Top guardados</b>\n${fmt(topSaves)}\n\n` +
      `<b>🔎 Top consultas</b>\n${fmt(topQueries)}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await ctx.reply(`⚠️ Error en /top: ${e.message || e}`);
  }
});

// PMF: comandos de control
bot.command("encuesta", async (ctx) => { await maybeAskPMF(ctx); });
bot.command("debugpmf", async (ctx) => {
  const d = await countDistinctUsageDays(ctx.from.id);
  const recent = await lastPmfAnswerWithin(ctx.from.id, PMF_COOLDOWN_DAYS);
  await ctx.reply(
    `PMF debug:\n- Días distintos: ${d}\n- Contestó últimos ${PMF_COOLDOWN_DAYS} días: ${recent}\n- Forzar por var: ${PMF_DEBUG_ALWAYS ? "sí" : "no"}\n` +
    `→ ${(!recent && (d >= PMF_MIN_DISTINCT_DAYS)) || PMF_DEBUG_ALWAYS ? "PREGUNTARÍA" : "NO preguntaría"}`
  );
});

// Reacciones rápidas (👍/👎) y PMF
const uxKeyboard = (action) => new InlineKeyboard().text("👍 Útil", `ux:${action}:1`).text("👎 No", `ux:${action}:0`);
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data || "";

  // PMF callback
  const pmf = data.match(/^pmf:(1|2|3|4|5)$/);
  if (pmf) {
    const score = Number(pmf[1]);
    await supabase.from("pmf_answers").insert({ user_id: ctx.from.id, score });
    await ctx.answerCallbackQuery({ text: `¡Gracias! (${score}/5)` });

    // Feedback libre 5 min
    setAwaitingFeedback(ctx.from.id);
    await ctx.reply(
      "🙏 Para ayudarme a mejorar, cuéntame AQUÍ MISMO en una frase: ¿qué echarías más de menos si no pudieras usar Reco?\n" +
      "✍️ Escribe tu comentario debajo."
    );
    return;
  }

  // UX quick reactions
  const m = data.match(/^ux:(save|query|delete|edit):(1|0)$/);
  if (!m) return ctx.answerCallbackQuery();
  const action = m[1];
  const useful = m[2] === "1";
  await supabase.from("quick_reactions").insert({ user_id: ctx.from.id, action, useful });
  await ctx.answerCallbackQuery({ text: useful ? "¡Muchas Gracias! 🙌" : "Muchas Gracias por avisar 💡" });
});

// --- Handler principal ---
bot.on("message:text", async (ctx) => {
  const original = ctx.message.text || "";
  const incoming = toPlainSpaces(original);

  // 0) feedback libre post-PMF
  if (isAwaitingFeedback(ctx.from.id)) {
    const looksLikeCommand =
      /^#/.test(incoming) || /^\?(\+)?/.test(incoming) || /^-/.test(incoming) || /^\//.test(incoming);
    if (!looksLikeCommand && incoming.length > 0) {
      await supabase.from("feedback").insert({ user_id: ctx.from.id, text: incoming });
      if (OWNER_CHAT_ID) {
        try {
          await ctx.api.sendMessage(
            OWNER_CHAT_ID,
            `📝 Feedback (post-PMF) de ${ctx.from.id} (@${ctx.from.username || "—"}):\n${incoming}`
          );
        } catch {}
      }
      clearAwaitingFeedback(ctx.from.id);
      await ctx.reply("¡Muchas Gracias por tu idea! 💚");
      return;
    }
  }

  const lines = incoming.split(/(?:\r?\n|(?=#))/).map(l => l.trim()).filter(Boolean);
  const outputs = [];

  for (const line of lines) {
    // 1) LISTAR TODO
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

      // Log de evento para métricas
      await supabase.from("events").insert({ user_id: ctx.from.id, type: "list", meta: null });

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

    // 2) GUARDAR
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

    // 3) EDITAR
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

    // 4) CONSULTAR
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

    // 5) BORRAR
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

    // 6) No reconocido → registramos para error-rate
    outputs.push(
      "⚠️ Formato no reconocido. Usa:\n" +
      "#nombre - valor  (— o – también valen)\n" +
      "Consultar: ?nombre  |  Listar: ?*\n" +
      "Editar: ?+nombre - nuevo valor  |  Borrar: -nombre"
    );
    await supabase.from("events").insert({ user_id: ctx.from.id, type: "unrecognized", meta: { sample: line.slice(0, 100) } });
  }

  await replySmart(ctx, outputs.join("\n"));

  // PMF al final de cada interacción
  await maybeAskPMF(ctx);
});

// --- Arranque ---
bot.start({ onStart: () => console.log("✅ Recordatorious bot is running…") });
