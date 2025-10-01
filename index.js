// index.js — Recordatorious (MVP + EDITAR + UX + PMF-early + feedback post-PMF + métricas avanzadas + Nudges + PrettyList + WipeAll + FriendlyCards)
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

/* ===================== FRIENDLY CARDS (estilo "canal") ===================== */

// Número a emoji 1️⃣…🔟
function numEmoji(n) {
  const map = ["0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  return map[n] || "•";
}
// Título capitalizado sin #
function titleCase(s="") {
  s = String(s).replace(/^#/, "").trim();
  if (!s) return "";
  return s[0].toUpperCase() + s.slice(1);
}
// Emoji por tipo de clave
function emojiForKey(key="") {
  const k = normalizeKey(key);
  if (/\bcumple|cumples|birthday/.test(k)) return "🎂";
  if (/\bcita|medico|dentista|pediatra/.test(k)) return "🩺";
  if (/\bwifi|clave|password|pass|pin/.test(k)) return "🔐";
  if (/\bcompra|super|lista/.test(k)) return "🛒";
  if (/\bmatricula|coche|car/.test(k)) return "🚗";
  if (/\bfactura|luz|gas|agua/.test(k)) return "🧾";
  if (/\btalla|zapat|ropa/.test(k)) return "👟";
  if (/\bseguro|poliza/.test(k)) return "🛡️";
  if (/\bvuelo|billete|tren|avion/.test(k)) return "✈️";
  if (/\bpedido|amazon|correos|envio/.test(k)) return "📦";
  return "📌";
}
// Convierte valores en bullets (acepta "1. a 2. b", "• a - b", líneas, etc.)
function prettyListToBullets(value) {
  if (!value) return "";
  // si ya viene multilinea: normalizamos prefijos
  if (/\n/.test(value)) {
    return value
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => x.replace(/^\s*(?:\d+[.)]|[•·\-–—])\s*/, "• ").trim())
      .join("\n");
  }
  // separar por numeración o bullets inline
  const parts = value.split(/\s*(?:\d+[.)]|[•·\-–—])\s+/).map(v=>v.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.map(p => `• ${p}`).join("\n");
  // separadores comunes
  const parts2 = value.split(/\s*[;|•]\s+|\s+-\s+|\s+\|\s+/).map(v=>v.trim()).filter(Boolean);
  if (parts2.length >= 2) return parts2.map(p => `• ${p}`).join("\n");
  // sin lista
  return `• ${value}`;
}
// Tarjeta para listados (?*)
function renderRecordCard(keyText, value, idx=1) {
  const icon = emojiForKey(keyText);
  const title = titleCase(keyText);
  const bullets = prettyListToBullets(value);
  return `${numEmoji(idx)} <b>${title}</b> ${icon}\n${bullets}`;
}
// Inline para consultas unitarias (?clave) y mensajes de guardado/edición
function renderRecordInline(keyText, value) {
  const icon = emojiForKey(keyText);
  const title = `#${String(keyText || "").replace(/^#/, "")}`;
  const bullets = prettyListToBullets(value);
  if (/\n/.test(bullets) || /^• /.test(bullets)) {
    return `<b>${title}</b> ${icon}\n${bullets}`;
  }
  return `<b>${title}</b> ${icon} — ${bullets.replace(/^•\s*/, "")}`;
}

/* ===================== FIN FRIENDLY CARDS ================================== */

// --- Mensajes ---
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
• Guarda: #nombre - valor
• Consulta: ?nombre
• Editar: ?+nombre - nuevo valor
• Borrar: -nombre
• Borrar todo: escribe “borrar todo” o “borra todo” (te pediré confirmación)
• Listar: ?*

Ej.: #wifi casa - PepeWifi / clave123`;

// --- PMF early ---
const PMF_MIN_DISTINCT_DAYS = 5;
const PMF_COOLDOWN_DAYS = 90;

// Días distintos de uso (últimos 180 días)
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

// Atajo privado: escribir "nudges" muestra los 3 mensajes de prueba (solo admin)
bot.hears(/^nudges$/i, async (ctx) => {
  if (!(OWNER_CHAT_ID && ctx.from?.id === OWNER_CHAT_ID)) return; // ignora si no eres admin
  await ctx.reply("— Nudge 1 —\n" + nudge1Text(), { parse_mode: "Markdown" });
  await ctx.reply("— Nudge 2 —\n" + nudge2Text(), { parse_mode: "Markdown" });
  await ctx.reply("— Nudge 3 —\n" + nudge3Text(), { parse_mode: "Markdown" });
});

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

// --- /stats: métricas mejoradas (excluye OWNER_CHAT_ID si existe) ---
bot.command("stats", async (ctx) => {
  try {
    const excludeOwner = !!OWNER_CHAT_ID;

    // Total de recordatorios
    let recCount = 0;
    {
      let q = supabase.from("records").select("*", { count: "exact", head: true });
      if (excludeOwner) q = q.neq("user_id", OWNER_CHAT_ID);
      const { count } = await q;
      recCount = count ?? 0;
    }

    // Eventos 12 meses (para uniques y firstSeen)
    const since365 = new Date(Date.now() - 365 * 86400000).toISOString();
    let qAll = supabase.from("events").select("user_id, type, created_at, meta").gte("created_at", since365).limit(100000);
    if (excludeOwner) qAll = qAll.neq("user_id", OWNER_CHAT_ID);
    const { data: evAll } = await qAll;

    const uniqAll = new Set((evAll || []).map(e => e.user_id)).size;

    // Nuevos últimos 7 días (firstSeen dentro de 7d)
    const firstSeen = new Map(); // uid -> date
    for (const e of evAll || []) {
      const t = new Date(e.created_at);
      const p = firstSeen.get(e.user_id);
      if (!p || t < p) firstSeen.set(e.user_id, t);
    }
    const sevenAgo = new Date(Date.now() - 7 * 86400000);
    let new7d = 0;
    for (const d of firstSeen.values()) if (d >= sevenAgo) new7d++;

    // Activos últimos 7 días
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
    let q7 = supabase.from("events").select("user_id").gte("created_at", since7).limit(100000);
    if (excludeOwner) q7 = q7.neq("user_id", OWNER_CHAT_ID);
    const { data: ev7d } = await q7;
    const active7d = new Set((ev7d || []).map(e => e.user_id)).size;

    // Error rate por formato no reconocido (últimos 30 días)
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    let q30 = supabase
      .from("events")
      .select("type, created_at, user_id")
      .gte("created_at", since30)
      .in("type", ["save", "query", "edit", "delete", "list", "unrecognized"])
      .limit(100000);
    if (excludeOwner) q30 = q30.neq("user_id", OWNER_CHAT_ID);
    const { data: ev30 } = await q30;
    const totalTracked = (ev30 || []).length;
    const unrec = (ev30 || []).filter(e => e.type === "unrecognized").length;
    const errRate = totalTracked ? (unrec / totalTracked) : 0;

    // Retención 7 días (cohorte 30 días) — excluye owner
    const since60 = new Date(Date.now() - 60 * 86400000).toISOString();
    let q60 = supabase.from("events").select("user_id, created_at").gte("created_at", since60).order("created_at", { ascending: true }).limit(100000);
    if (excludeOwner) q60 = q60.neq("user_id", OWNER_CHAT_ID);
    const { data: ev60 } = await q60;

    const firstSeen60 = new Map(); // userId -> firstDate
    const daysWithinWeek = new Map(); // userId -> Set(YYYY-MM-DD) dentro de la primera semana

    for (const e of ev60 || []) {
      const uid = e.user_id;
      const t = new Date(e.created_at);
      if (!firstSeen60.has(uid)) {
        firstSeen60.set(uid, t);
        daysWithinWeek.set(uid, new Set([fmtYMD(t)]));
      } else {
        const start = firstSeen60.get(uid);
        const diff = (t - start) / 86400000;
        if (diff < 7) daysWithinWeek.get(uid)?.add(fmtYMD(t));
      }
    }
    const cohortSince = new Date(Date.now() - 30 * 86400000);
    let cohort = 0, retained = 0;
    for (const [uid, start] of firstSeen60.entries()) {
      if (start >= cohortSince) {
        cohort++;
        const set = daysWithinWeek.get(uid) || new Set();
        if (set.size >= 2) retained++;
      }
    }
    const retention7d = cohort ? (retained / cohort) : 0;

    await ctx.reply(
      `📊 <b>Estadísticas Reco</b>\n\n` +
      `• Recordatorios guardados: <b>${recCount}</b>\n` +
      `• Usuarios únicos (12 meses): <b>${uniqAll}</b>\n` +
      `• <u>Nuevos últimos 7 días</u>: <b>${new7d}</b>\n` +
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
  let q = supabase.from("pmf_answers").select("score");
  if (OWNER_CHAT_ID) q = q.neq("user_id", OWNER_CHAT_ID);
  const { data, error } = await q;
  if (error || !data || data.length === 0) return ctx.reply("📭 Aún no hay respuestas PMF.");

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

// --- /top — Top + totales por semana o rango custom (solo admin) ---
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
    const fmt = (arr) => (arr.length ? arr.map(([k, n], i) => `${i + 1}. ${k} (${n})`).join("\n") : "—");

    // Consultas base
    let qSaves = supabase
      .from("events").select("meta, created_at, user_id")
      .eq("type", "save").gte("created_at", since).lt("created_at", until);
    let qQueries = supabase
      .from("events").select("meta, created_at, user_id")
      .eq("type", "query").gte("created_at", since).lt("created_at", until);
    if (OWNER_CHAT_ID) {
      qSaves = qSaves.neq("user_id", OWNER_CHAT_ID);
      qQueries = qQueries.neq("user_id", OWNER_CHAT_ID);
    }

    const [{ data: saves }, { data: queries }] = await Promise.all([qSaves, qQueries]);

    const topSaves = tally(saves);
    const topQueries = tally(queries);

    const totalSaves = saves?.length || 0;
    const totalQueries = queries?.length || 0;

    await ctx.reply(
      `📌 <b>Top por ${label}</b>\n` +
      `• Total guardados: <b>${totalSaves}</b>\n` +
      `• Total consultas: <b>${totalQueries}</b>\n\n` +
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

// Reacciones rápidas (👍/👎) y PMF + wipe
const uxKeyboard = (action) => new InlineKeyboard().text("👍 Útil", `ux:${action}:1`).text("👎 No", `ux:${action}:0`);
const wipeKb = new InlineKeyboard().text("✅ Sí, borrar todo", "wipe:yes").text("❌ No, cancelar", "wipe:no");

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data || "";

  // PMF callback
  const pmf = data.match(/^pmf:(1|2|3|4|5)$/);
  if (pmf) {
    const score = Number(pmf[1]);
    await supabase.from("pmf_answers").insert({ user_id: ctx.from.id, score });
    await ctx.answerCallbackQuery({ text: `¡Gracias! (${score}/5)` });
    setAwaitingFeedback(ctx.from.id);
    await ctx.reply("🙏 Para ayudarme a mejorar, cuéntame AQUÍ MISMO en una frase: ¿qué echarías más de menos si no pudieras usar Reco?\n✍️ Escribe tu comentario debajo.");
    return;
  }

  // WIPE ALL callback
  if (data === "wipe:yes" || data === "wipe:no") {
    if (data === "wipe:no") {
      await ctx.answerCallbackQuery({ text: "Cancelar borrado" });
      return ctx.editMessageText("Operación cancelada. No se borró nada.");
    }
    // Contar y borrar
    await ctx.answerCallbackQuery({ text: "Borrando…" });
    const { count } = await supabase.from("records").select("*", { count: "exact", head: true }).eq("user_id", ctx.from.id);
    await supabase.from("records").delete().eq("user_id", ctx.from.id);
    await supabase.from("events").insert({ user_id: ctx.from.id, type: "wipe_all", meta: { deleted: count || 0 } });
    try { await ctx.editMessageText(`🧹 He borrado ${count || 0} recordatorios.`); } catch {}
    return;
  }

  // UX quick reactions
  const m = data.match(/^ux:(save|query|delete|edit):(1|0)$/);
  if (m) {
    const action = m[1];
    const useful = m[2] === "1";
    await supabase.from("quick_reactions").insert({ user_id: ctx.from.id, action, useful });
    return ctx.answerCallbackQuery({ text: useful ? "¡Muchas Gracias! 🙌" : "Muchas Gracias por avisar 💡" });
  }

  // default
  return ctx.answerCallbackQuery();
});

// === NUDGES ===================================================================
function nudge1Text() {
  const A =
`👋 ¡Hey! Aún no has guardado nada en Reco.
Prueba con algo 100% cotidiano que usarás luego en segundos:

• Lista corta de compra → \`#compra octubre - 
  1. Plátanos  
  2. Huevos  
  3. Papel higiénico\`
  
• Cita dentista → \`#cita dentista - 15/11 16:00h\`

Tu “yo del futuro” te lo va a agradecer 😅
Solo Escribe para verlos \`?compra\` o \`?cita\` y verás la magia.`;
  const B =
`🤔 Si lo dejas en la cabeza... se pierde.
Guarda 1 cosa útil ahora y pruébame con \`?nombre\`:

• PIN parking → \`#pin parking - 2781\`

• Pedido online → \`#pedido Correos - 113-998877\`

5 segundos para guardar; 1 segundo para encontrar 😉
Tip: con \`?*\` ves todo lo que llevas.`;
  return Math.random() < 0.5 ? A : B;
}
function nudge2Text() {
  const A =
`🔓 Con 3 cositas guardadas Reco despega.
Añade 2 más y buscalos de forma rápida usando \`?nombre\`.
Inspo rápida y muy real:
• Wifi → \`#wifi casa - PepeWifi / clave123\`

• Lista compra → \`#compra - 
  1. Leche  
  2. Pan  
  3. Huevos\`
• Cita → \`#cita pediatra - 10/10 09:30h\`

Tres toques y tienes memoria turbo 💪
Escribe para verlos \`?Wifi\` o \`?compra\` o \`?cita\``;

  const B =
`Ya guardaste 1 (¡bien!). Sube a 3 y verás la magia de \`?*\`.
Ideas que salvan el día:
• Matrícula → \`#matrícula coche - 1234ABC\`

• Factura → \`#factura luz - vence 12/11\`

• Extraescolar → \`#clase inglés - lunes 17:30h\`

Solo escribe para verlos \`?compra\` o \`?cita\` y verás la magia.`;
  return Math.random() < 0.5 ? A : B;
}
function nudge3Text() {
  const A =
`🧱 Con 3 ya vas rápido; con 4–5 es teletransporte.
¿Qué te falta?
• Seguro coche → \`#seguro coche - póliza 998877\`
• NIF cliente → \`#cliente X - NIF B-12345678\`
• Vuelo → \`#vuelo Madrid - IB1234 salida 08:00\`
Ese “lo tenía en la punta de la lengua”… ya no 🤟`;
  const B =
`Estás a 1 nota de convertir Reco en tu bolsillo pro.
Añade una súper cotidiana y pruébame mañana:

• Compra finde → \`#compra finde - 
  1. Café  
  2. Arroz  
  3. Papel higiénico\`
  
• Cita dentista → \`#dentista - 21/10 12:00h\`

• PIN que siempre olvidas → \`#pin trastero - 5402\`

Prueba para verlos \`?compra\` o \`?cita\` y voilá 😄`;
  return Math.random() < 0.5 ? A : B;
}

// Helpers para nudges
async function getRecordCount(uid) {
  const { count } = await supabase.from("records").select("*", { count: "exact", head: true }).eq("user_id", uid);
  return count ?? 0;
}
async function lastEventAt(uid, type) {
  const { data } = await supabase
    .from("events")
    .select("created_at")
    .eq("user_id", uid)
    .eq("type", type)
    .order("created_at", { ascending: false })
    .limit(1);
  return (data && data[0]) ? new Date(data[0].created_at) : null;
}
async function nudgeAlreadySentWithin(uid, nudgeType, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await supabase
    .from("events")
    .select("id")
    .eq("user_id", uid)
    .eq("type", nudgeType)
    .gte("created_at", since)
    .limit(1);
  return !!(data && data.length);
}

// Reglas NUDGES
async function maybeSendNudges(ctx) {
  const uid = ctx.from.id;

  const recCount = await getRecordCount(uid);

  // Nudge 1
  if (recCount === 0) {
    const st = await lastEventAt(uid, "start");
    if (st && (Date.now() - st.getTime()) >= 24 * 3600 * 1000) {
      if (!(await nudgeAlreadySentWithin(uid, "nudge1", 7))) {
        await ctx.reply(nudge1Text(), { parse_mode: "Markdown" });
        await supabase.from("events").insert({ user_id: uid, type: "nudge1", meta: null });
        return;
      }
    }
  }

  // Nudge 2
  if (recCount === 1) {
    const lastSave = await lastEventAt(uid, "save");
    if (lastSave && (Date.now() - lastSave.getTime()) >= 48 * 3600 * 1000) {
      if (!(await nudgeAlreadySentWithin(uid, "nudge2", 14))) {
        await ctx.reply(nudge2Text(), { parse_mode: "Markdown" });
        await supabase.from("events").insert({ user_id: uid, type: "nudge2", meta: null });
        return;
      }
    }
  }

  // Nudge 3
  if (recCount === 3) {
    const lastSave = await lastEventAt(uid, "save");
    if (lastSave && (Date.now() - lastSave.getTime()) >= 5 * 24 * 3600 * 1000) {
      if (!(await nudgeAlreadySentWithin(uid, "nudge3", 30))) {
        await ctx.reply(nudge3Text(), { parse_mode: "Markdown" });
        await supabase.from("events").insert({ user_id: uid, type: "nudge3", meta: null });
        return;
      }
    }
  }
}

// Forzar nudge manual (solo admin)
bot.command(["nudge", "nudges"], async (ctx) => {
  if (!(OWNER_CHAT_ID && ctx.from?.id === OWNER_CHAT_ID)) {
    return ctx.reply("Comando solo para admin.");
  }
  await maybeSendNudges(ctx);
});

// --- Handler principal ---
bot.on("message:text", async (ctx) => {
  const original = ctx.message.text || "";
  const incoming = toPlainSpaces(original);

  // 👉 Si es un comando (/algo), no lo parseamos aquí (evita “formato no reconocido”)
  if (/^\/\w+/.test(incoming)) {
    return;
  }

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

  // 0-bis) Frases “borrar/borra todo(s) …” → confirmación
  if (/\bborra(r)?\s+todos?\b/i.test(incoming)) {
    await ctx.reply("⚠️ ¿Seguro que quieres <b>borrar TODOS</b> tus recordatorios? Esta acción no se puede deshacer.", {
      parse_mode: "HTML",
      reply_markup: wipeKb
    });
    await supabase.from("events").insert({ user_id: ctx.from.id, type: "wipe_prompt", meta: null });
    return;
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

      await supabase.from("events").insert({ user_id: ctx.from.id, type: "list", meta: null });

      if (res.error) outputs.push(`⚠️ Error listando: ${res.error.message}`);
      else if (!res.data || res.data.length === 0) {
        outputs.push(page === 1 ? "📭 No tienes registros aún." : `📭 Página ${page} vacía.`);
      } else {
        const total = res.count ?? res.data.length;
        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        const header = `🗂️ Tus registros (página ${page}/${maxPage}, total ${total})`;
        const body = res.data
          .map((r, i) => renderRecordCard(r.key_text, r.value, (page - 1) * pageSize + (i + 1)))
          .join("\n\n");
        outputs.push(`${header}\n\n${body}\n\n➡️ Usa \`?* ${page + 1}\` para la siguiente página.`);
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

      const nice = renderRecordInline(rawKey, value);
      outputs.push(error ? `⚠️ Error guardando "${rawKey}": ${error.message}` : `✅ Guardado:\n${nice}`);

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
      else outputs.push(`📝 Actualizado:\n${renderRecordInline(updated.key_text, updated.value)} ✅`);

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
      else if (data.length === 1) {
        outputs.push(`🔍 ${renderRecordInline(data[0].key_text, data[0].value)}`);
      } else {
        const cards = data.map((r, i) => renderRecordCard(r.key_text, r.value, i + 1)).join("\n\n");
        outputs.push(`🔎 <b>Coincidencias</b>\n\n${cards}`);
      }

      if (shouldAsk(ctx.from.id, "query")) await ctx.reply("¿Te fue útil?", { reply_markup: uxKeyboard("query") });
      continue;
    }

    // 5) BORRAR UNITARIO
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
      "⚠️ Perdona, ese formato no me suena. Usa:\n" +
      "#nombre - valor  (— o – también valen)\n" +
      "Consultar: ?nombre  |  Listar: ?*\n" +
      "Editar: ?+nombre - nuevo valor  |  Borrar: -nombre"
    );
    await supabase.from("events").insert({ user_id: ctx.from.id, type: "unrecognized", meta: { sample: line.slice(0, 100) } });
  }

  // ⬇️ Ahora enviamos el bloque con HTML para que se vean títulos/bullets/emoji
  await replySmart(ctx, outputs.join("\n"), { parse_mode: "HTML" });

  // PMF: al final de interacción (respeta cooldown y días)
  await maybeAskPMF(ctx);

  // NUDGES al final (no bloquea y respeta ventanas)
  await maybeSendNudges(ctx);
});

// --- Arranque ---
bot.start({ onStart: () => console.log("✅ Recordatorious bot is running…") });
