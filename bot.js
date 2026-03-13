require('dotenv').config();

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const http = require('http');

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3001';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const CHANNEL_NAME = process.env.DISCORD_CHANNEL || 'deploy-logs';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ALEXA_SKILL_PORT = process.env.ALEXA_SKILL_PORT || 3002;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN não configurado!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  console.log(`📡 Monitorando canal: #${CHANNEL_NAME}`);
  console.log(`🔗 Agent URL: ${AGENT_URL}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return;
  if (message.channel.name !== CHANNEL_NAME) return;

  if (message.webhookId || message.author.bot) {
    await handleWebhookMessage(message);
    return;
  }

  await handleHumanMessage(message);
});

// Extract image URLs from message attachments
function extractImages(message) {
  const images = [];
  for (const attachment of message.attachments.values()) {
    const ct = attachment.contentType || '';
    if (ct.startsWith('image/')) {
      images.push({ url: attachment.url, mediaType: ct });
    }
  }
  return images;
}

async function handleWebhookMessage(message) {
  let content = message.content || '';
  if (message.embeds.length > 0) {
    for (const embed of message.embeds) {
      content += `\n[Embed] ${embed.title || ''}: ${embed.description || ''}`;
      if (embed.fields) {
        for (const field of embed.fields) {
          content += `\n  ${field.name}: ${field.value}`;
        }
      }
    }
  }

  if (!content.trim()) return;

  const isAlexa = content.includes('🎙️') || content.includes('Comando via Alexa');
  const isException = content.includes('Exception') || content.includes('Error') || content.includes('❌') || content.includes('🔴');

  // Show status for exceptions
  let statusMsg = null;
  if (isException) {
    statusMsg = await message.channel.send('🔍 **Analisando exception...**');
  }

  try {
    let stepCount = 0;
    const reply = await callAgentSSE(content, true, message.channel, isException ? async (step, sessionId) => {
      stepCount++;
      try {
        if (statusMsg) {
          await statusMsg.edit(`🔧 **Etapa ${stepCount}:** ${step}`);
        }
      } catch (e) {}
    } : null);

    if (!reply || reply.trim() === '' || reply.trim() === 'ok') {
      if (statusMsg) await statusMsg.delete().catch(() => {});
      return;
    }

    if (statusMsg) {
      await statusMsg.edit(`✅ Análise concluída em ${stepCount} etapas.`);
    }
    await sendLongMessage(message.channel, reply);

    // If the message came from Alexa, send the response back
    if (isAlexa && reply) {
      notifyAlexa(reply);
    }
  } catch (err) {
    console.error('Erro ao processar webhook:', err.message);
    if (statusMsg) await statusMsg.edit(`❌ Erro: ${err.message}`).catch(() => {});
    if (isAlexa) {
      notifyAlexa(`Erro: ${err.message}`);
    }
  }
}

async function handleHumanMessage(message) {
  const cancelBtn = new ButtonBuilder()
    .setCustomId('cancel_task')
    .setLabel('Cancelar')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('⛔');

  const row = new ActionRowBuilder().addComponents(cancelBtn);

  const statusMsg = await message.reply({ content: '⏳ Pensando...', components: [row] });
  let stepCount = 0;
  let currentSessionId = null;
  let cancelled = false;

  // Listen for button click
  const collector = statusMsg.createMessageComponentCollector({ time: 600000 });
  collector.on('collect', async (interaction) => {
    if (interaction.customId === 'cancel_task') {
      cancelled = true;
      await interaction.update({ content: '⛔ Cancelando...', components: [] });
      // Call agent abort endpoint
      abortAgent(currentSessionId);
    }
  });

  try {
    const recentMessages = await getRecentMessages(message.channel);
    const images = extractImages(message);
    const reply = await callAgentSSE(
      message.content,
      false,
      message.channel,
      async (step, sessionId) => {
        if (cancelled) return;
        stepCount++;
        currentSessionId = sessionId;
        try {
          await statusMsg.edit({ content: `🔧 **Etapa ${stepCount}:** ${step}`, components: [row] });
        } catch (e) {
          console.error('Erro ao atualizar status:', e.message);
        }
      },
      recentMessages,
      images
    );

    collector.stop();
    const finalReply = reply || '(sem resposta)';

    if (cancelled) {
      await statusMsg.edit({ content: `⛔ Cancelado após ${stepCount} etapas.`, components: [] });
    } else {
      await statusMsg.edit({ content: `✅ Concluído em ${stepCount} etapas.`, components: [] });
    }
    await sendLongMessage(message.channel, finalReply);
  } catch (err) {
    collector.stop();
    console.error('Erro ao processar mensagem:', err.message);
    await statusMsg.edit({ content: `❌ Erro: ${err.message}`, components: [] });
  }
}

function abortAgent(sessionId) {
  const payload = JSON.stringify({ sessionId });
  const url = new URL(AGENT_URL);
  const req = http.request({
    hostname: url.hostname,
    port: url.port || 3001,
    path: '/abort',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(AGENT_SECRET ? { Authorization: `Bearer ${AGENT_SECRET}` } : {})
    }
  }, (res) => { res.resume(); });
  req.on('error', (err) => console.error('[Bot] Erro ao abortar:', err.message));
  req.write(payload);
  req.end();
}

function callAgentSSE(message, auto, channel, onProgress, recentMessages, images) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      message,
      auto,
      images: images || [],
      context: { recentMessages: recentMessages || [] }
    });

    const url = new URL(AGENT_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 3001,
      path: '/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(AGENT_SECRET ? { Authorization: `Bearer ${AGENT_SECRET}` } : {})
      }
    };

    const req = http.request(options, (res) => {
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // keep incomplete chunk

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'progress' && onProgress) {
              onProgress(data.step, data.sessionId);
            } else if (data.type === 'reply') {
              resolve(data.reply);
            } else if (data.type === 'error') {
              reject(new Error(data.error));
            }
          } catch (e) {
            // ignore parse errors
          }
        }
      });

      res.on('end', () => {
        // Process any remaining buffer
        if (buffer.startsWith('data: ')) {
          try {
            const data = JSON.parse(buffer.slice(6));
            if (data.type === 'reply') resolve(data.reply);
            else if (data.type === 'error') reject(new Error(data.error));
          } catch (e) {
            // ignore
          }
        }
        // If we haven't resolved yet
        resolve('(sem resposta)');
      });
    });

    req.on('error', reject);
    req.setTimeout(600000, () => {
      req.destroy();
      reject(new Error('Timeout de 10 minutos excedido'));
    });

    req.write(payload);
    req.end();
  });
}

async function getRecentMessages(channel, limit = 15) {
  try {
    const msgs = await channel.messages.fetch({ limit });
    return [...msgs.values()].reverse().map(m => ({
      author: m.author.username,
      content: m.content,
      timestamp: m.createdAt.toISOString(),
      isBot: m.author.bot,
      embeds: m.embeds.map(e => ({
        title: e.title,
        description: e.description,
        fields: e.fields
      }))
    }));
  } catch {
    return [];
  }
}

function splitMessage(text, maxLength = 1900) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

async function sendLongMessage(channel, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

// Notify alexa-skill with the bot's response
function notifyAlexa(text) {
  const payload = JSON.stringify({ text });
  const req = http.request({
    hostname: 'localhost',
    port: ALEXA_SKILL_PORT,
    path: '/response',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, (res) => { res.resume(); });
  req.on('error', (err) => console.error('[Bot] Erro ao notificar Alexa:', err.message));
  req.write(payload);
  req.end();
}

client.on('error', (err) => {
  console.error('Discord client error:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

client.login(DISCORD_TOKEN);
