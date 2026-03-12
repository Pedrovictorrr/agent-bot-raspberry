require('dotenv').config();

const express = require('express');
const https = require('https');

const app = express();
app.use(express.json());

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const ALEXA_SKILL_PORT = process.env.ALEXA_SKILL_PORT || 3002;

if (!DISCORD_WEBHOOK) {
  console.error('❌ DISCORD_WEBHOOK não configurado!');
  process.exit(1);
}

// Alexa sends POST requests to this endpoint
app.post('/alexa', (req, res) => {
  const body = req.body;

  console.log(`[Alexa] Request type: ${body.request?.type}`);

  // LaunchRequest — "Alexa, abrir Pedrinho"
  if (body.request.type === 'LaunchRequest') {
    return res.json(buildResponse(
      'Oi! Pode falar o que você quer que eu mande pro Pedrinho.',
      false // keep session open
    ));
  }

  // SessionEndedRequest
  if (body.request.type === 'SessionEndedRequest') {
    return res.json(buildResponse('Até mais!', true));
  }

  // IntentRequest
  if (body.request.type === 'IntentRequest') {
    const intentName = body.request.intent.name;

    // Help
    if (intentName === 'AMAZON.HelpIntent') {
      return res.json(buildResponse(
        'Você pode me dizer qualquer comando e eu envio pro canal do Discord. Por exemplo: corrija o bug do login.',
        false
      ));
    }

    // Stop/Cancel
    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
      return res.json(buildResponse('Até mais!', true));
    }

    // SendCommandIntent — the main one
    if (intentName === 'SendCommandIntent') {
      const command = body.request.intent.slots?.command?.value;

      if (!command) {
        return res.json(buildResponse(
          'Não entendi o comando. Pode repetir?',
          false
        ));
      }

      console.log(`[Alexa] Comando recebido: "${command}"`);

      // Send to Discord webhook (fire and forget)
      sendToDiscord(`🎙️ **Comando via Alexa:** ${command}`)
        .then(() => console.log('[Alexa] Mensagem enviada ao Discord'))
        .catch(err => console.error('[Alexa] Erro ao enviar:', err.message));

      return res.json(buildResponse(
        `Pronto! Enviei pro Pedrinho: ${command}`,
        true
      ));
    }

    // Fallback
    return res.json(buildResponse(
      'Não entendi. Tente dizer um comando para o Pedrinho.',
      false
    ));
  }

  // Unknown request type
  res.json(buildResponse('Algo deu errado.', true));
});

function buildResponse(speechText, shouldEnd) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'PlainText',
        text: speechText
      },
      shouldEndSession: shouldEnd
    }
  };
}

function sendToDiscord(content) {
  return new Promise((resolve, reject) => {
    const url = new URL(DISCORD_WEBHOOK);
    const payload = JSON.stringify({ content });

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`Discord responded with ${res.statusCode}`));
      }
      res.resume();
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

app.listen(ALEXA_SKILL_PORT, '0.0.0.0', () => {
  console.log(`🎙️ Alexa Skill server rodando na porta ${ALEXA_SKILL_PORT}`);
});
