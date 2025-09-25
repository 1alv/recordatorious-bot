require('dotenv').config();
const { Bot } = require('grammy');
const { createClient } = require('@supabase/supabase-js');

// Load configuration from environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Set it in your .env file or environment variables.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL or SUPABASE_ANON_KEY is missing. Set them in your .env file or environment variables.');
  process.exit(1);
}

// Initialise Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Create the bot
const bot = new Bot(BOT_TOKEN);

/**
 * Helper to normalise keys for search.
 * Converts to lowercase and trims whitespace.
 */
function normaliseKey(key) {
  return key.toLowerCase().trim();
}

// On /start command: send welcome message and templates
bot.command('start', async (ctx) => {
  const templates = [
    '#tel papá - 612345678',
    '#tel mamá - 612345679',
    '#candado bici - 1234',
    '#clave tarjeta - 4321',
    '#cita médico - 12/10 10:00h',
    '#toma vitaminas - 08:00h cada día',
    '#matrícula coche - 1234ABC',
    '#talla zapato Juan - 42',
    '#wifi casa - PepeWifi / clave123'
  ];
  let message = '👋 ¡Hola! Soy Reco, tu bot para recordar datos simples.\n';
  message += 'Guarda un dato con:\n#nombre - valor\n';
  message += 'Consúltalo con:\n?nombre\n';
  message += 'Bórralo con:\n-nombre\n\n';
  message += 'Ejemplos:\n';
  templates.forEach((t) => {
    message += `• ${t}\n`;
  });
  await ctx.reply(message);
});

// Main message handler
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;

  // Save entry: starts with '#'
  if (text.startsWith('#')) {
    const content = text.substring(1).trim();
    // Expect format: key - value (allowing spaces around '-')
    const match = content.match(/^(.*?)\s*-\s*(.+)$/);
    if (!match) {
      await ctx.reply('⚠️ Formato no reconocido. Usa #clave - valor, por ejemplo:\n#vecino Juan - 3B');
      return;
    }
    const key = match[1].trim();
    const value = match[2].trim();
    const keyLower = normaliseKey(key);

    // Upsert record
    const { error } = await supabase.from('records').upsert(
      { user_id: userId, key_norm: keyLower, key_text: key, value: value },
      { onConflict: ['user_id', 'key_norm'] }
    );
    if (error) {
      console.error('Error saving record:', error);
      await ctx.reply('❌ Hubo un error al guardar tu dato. Intenta de nuevo más tarde.');
    } else {
      await ctx.reply(`✅ Guardado: "${key}" → "${value}"`);
    }
    return;
  }

  // Query entries: starts with '?'
  if (text.startsWith('?')) {
    const query = text.substring(1).trim();
    if (!query) {
      await ctx.reply('Por favor, indica qué clave buscar después del signo de interrogación. Ejemplo: ?vecino Juan');
      return;
    }
    const searchTerm = normaliseKey(query);
    // Search for exact and partial matches
    const { data, error } = await supabase
      .from('records')
      .select('key_text, value')
      .eq('user_id', userId)
      .ilike('key_norm', `%${searchTerm}%`)
      .limit(10);
    if (error) {
      console.error('Error searching records:', error);
      await ctx.reply('❌ Hubo un error al buscar. Intenta de nuevo más tarde.');
      return;
    }
    if (!data || data.length === 0) {
      await ctx.reply('No he encontrado nada con esa clave.');
      return;
    }
    // Build response with matches
    let replyText = '🔍 Resultados:\n';
    data.forEach((row) => {
      replyText += `• ${row.key_text}: ${row.value}\n`;
    });
    await ctx.reply(replyText.trim());
    return;
  }

  // Delete entry: starts with '-'
  if (text.startsWith('-')) {
    const key = text.substring(1).trim();
    if (!key) {
      await ctx.reply('Indica la clave que quieres borrar después del guion. Ejemplo: -vecino Juan');
      return;
    }
    const keyLower = normaliseKey(key);
    const { error } = await supabase
      .from('records')
      .delete()
      .match({ user_id: userId, key_norm: keyLower });
    if (error) {
      console.error('Error deleting record:', error);
      await ctx.reply('❌ Hubo un error al borrar. Intenta de nuevo más tarde.');
    } else {
      await ctx.reply(`🗑️ Borrado: "${key}"`);
    }
    return;
  }

  // If message doesn't match any command, ignore or give hint
  // Optionally, you can respond with help text here
});

// Start bot
bot.start().then(() => {
  console.log('Recordatorious bot is running');
});
