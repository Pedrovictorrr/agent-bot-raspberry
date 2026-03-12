require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const http = require('http');

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3001';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const CHANNEL_NAME = process.env.DISCORD_CHANNEL || 'deploy-logs';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

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

  try {
    const reply = await callAgentSSE(content, true, message.channel, null);
    if (!reply || reply.trim() === '' || reply.trim() === 'ok') return;
    await sendLongMessage(message.channel, reply);
  } catch (err) {
    console.error('Erro ao processar webhook:', err.message);
  }
}

async function handleHumanMessage(message) {
  const statusMsg = await message.reply('⏳ Pensando...');
  let stepCount = 0;

  try {
    const recentMessages = await getRecentMessages(message.channel);
    const reply = await callAgentSSE(
      message.content,
      false,
      message.channel,
      async (step) => {
        stepCount++;
        try {
          await statusMsg.edit(`🔧 **Etapa ${stepCount}:** ${step}`);
        } catch (e) {
          console.error('Erro ao atualizar status:', e.message);
        }
      },
      recentMessages
    );

    const finalReply = reply || '(sem resposta)';

    // Envia resposta final como NOVA mensagem
    await statusMsg.edit(`✅ Concluído em ${stepCount} etapas.`);
    await sendLongMessage(message.channel, finalReply);
  } catch (err) {
    console.error('Erro ao processar mensagem:', err.message);
    await statusMsg.edit(`❌ Erro: ${err.message}`);
  }
}

function callAgentSSE(message, auto, channel, onProgress, recentMessages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      message,
      auto,
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
              onProgress(data.step);
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

client.on('error', (err) => {
  console.error('Discord client error:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

client.login(DISCORD_TOKEN);
