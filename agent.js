require('dotenv').config();

const express = require('express');
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const anthropic = new Anthropic();

const REPO_PATH = process.env.REPO_PATH || '/home/pi/psis-saas';
const BRANCH = process.env.BRANCH || 'ai-fixes';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const MAX_TOOL_ITERATIONS = 25;

// Auth middleware
app.use((req, res, next) => {
  if (AGENT_SECRET && req.headers.authorization !== `Bearer ${AGENT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Health check
app.get('/health', (req, res) => {
  const gitStatus = safeExec(`cd ${REPO_PATH} && git status --short`);
  const branch = safeExec(`cd ${REPO_PATH} && git branch --show-current`);
  res.json({ status: 'ok', branch: branch.trim(), changes: gitStatus.trim() || 'clean' });
});

// Main chat endpoint with SSE progress
app.post('/chat', async (req, res) => {
  const { message, auto, context } = req.body;

  // Set up SSE for progress updates
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  function sendProgress(step) {
    res.write(`data: ${JSON.stringify({ type: 'progress', step })}\n\n`);
  }

  function sendReply(reply) {
    res.write(`data: ${JSON.stringify({ type: 'reply', reply })}\n\n`);
    res.end();
  }

  function sendError(error) {
    res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
    res.end();
  }

  try {
    sendProgress('Analisando o pedido...');

    const gitLog = safeExec(`cd ${REPO_PATH} && git log --oneline -10`);
    const gitStatus = safeExec(`cd ${REPO_PATH} && git status --short`);
    const currentBranch = safeExec(`cd ${REPO_PATH} && git branch --show-current`);

    const systemPrompt = `Você é o Pedrinho, um agente de desenvolvimento trabalhando no repositório Laravel PSIS-SAAS em ${REPO_PATH}.
Branch atual: ${currentBranch.trim()}
Branch de trabalho: ${BRANCH}

Git status:
${gitStatus || '(limpo)'}

Últimos commits:
${gitLog}

${auto ? `MODO AUTOMÁTICO:
- Um webhook de deploy ou exception chegou no Discord
- Analise o evento e comente SOMENTE se for relevante
- Para exceptions: identifique a causa provável e sugira o fix
- Para deploy com sucesso: responda apenas "ok"
- Para deploy com falha: alerte e explique o problema
- Se não tiver nada útil a dizer, responda com ""` : `MODO CONVERSA:
- Responda normalmente ao usuário
- Execute tarefas, leia/edite arquivos, faça commits
- Use mensagens de commit descritivas em português
- O auto-deploy vai rodar após o push para a branch ${BRANCH}
- IMPORTANTE: Ao terminar, SEMPRE dê um resumo final claro
- Formate respostas com quebras de linha para Discord
- Use ** para negrito e \` para código inline`}

${context?.recentMessages ? `Mensagens recentes do canal:\n${context.recentMessages.map(m => `[${m.author}]: ${m.content}`).join('\n')}` : ''}

IMPORTANTE: Sempre responda em português brasileiro.`;

    const tools = [
      {
        name: 'read_file',
        description: 'Lê o conteúdo de um arquivo do projeto',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Caminho relativo ao root do projeto' }
          },
          required: ['path']
        }
      },
      {
        name: 'write_file',
        description: 'Escreve/modifica um arquivo do projeto',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Caminho relativo ao root do projeto' },
            content: { type: 'string', description: 'Conteúdo completo do arquivo' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'run_command',
        description: 'Executa qualquer comando shell no diretório do projeto (git, php, sed, grep, cat, npm, etc)',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Comando shell a executar' }
          },
          required: ['command']
        }
      },
      {
        name: 'search_code',
        description: 'Busca por padrão no código (grep recursivo)',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Padrão para buscar (regex)' },
            path: { type: 'string', description: 'Subdiretório para limitar busca (opcional)' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'list_files',
        description: 'Lista arquivos em um diretório do projeto',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Caminho relativo ao root (padrão: root)' }
          },
          required: []
        }
      },
      {
        name: 'edit_file',
        description: 'Substitui um trecho de texto em um arquivo (search & replace). Mais seguro que write_file para edições parciais.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Caminho relativo ao root do projeto' },
            old_text: { type: 'string', description: 'Texto exato a ser substituído' },
            new_text: { type: 'string', description: 'Texto novo que vai substituir' }
          },
          required: ['path', 'old_text', 'new_text']
        }
      }
    ];

    // Agentic loop
    let messages = [{ role: 'user', content: message }];
    let iterations = 0;
    let lastTextReply = '';

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      console.log(`[Loop ${iterations}/${MAX_TOOL_ITERATIONS}]`);

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system: systemPrompt,
        messages,
        tools
      });

      const textBlocks = response.content.filter(b => b.type === 'text');
      const toolUses = response.content.filter(b => b.type === 'tool_use');

      if (textBlocks.length > 0) {
        lastTextReply = textBlocks.map(b => b.text).join('\n');
      }

      // Se não tem tool calls, é a resposta final
      if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
        break;
      }

      // Process tool calls with progress
      const toolResults = [];
      for (const toolUse of toolUses) {
        const toolDesc = getToolDescription(toolUse.name, toolUse.input);
        sendProgress(toolDesc);
        console.log(`  → ${toolDesc}`);

        const result = await handleTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      lastTextReply = '';
    }

    // Se terminou sem texto final, pede um resumo
    if (!lastTextReply) {
      sendProgress('Gerando resumo...');
      const summaryResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: 'user', content: 'Resuma brevemente o que você acabou de fazer. Seja direto, use quebras de linha e formatação Discord.' }
        ]
      });
      const summaryText = summaryResponse.content.filter(b => b.type === 'text');
      lastTextReply = summaryText.map(b => b.text).join('\n');
    }

    console.log(`[Done] ${iterations} iterações`);
    sendReply(lastTextReply.trim() || '(sem resposta)');
  } catch (err) {
    console.error('Agent error:', err);
    sendError(err.message);
  }
});

function getToolDescription(name, input) {
  switch (name) {
    case 'read_file': return `Lendo arquivo: \`${input.path}\``;
    case 'write_file': return `Escrevendo arquivo: \`${input.path}\``;
    case 'edit_file': return `Editando arquivo: \`${input.path}\``;
    case 'run_command': return `Executando: \`${input.command.slice(0, 80)}\``;
    case 'search_code': return `Buscando: \`${input.pattern}\``;
    case 'list_files': return `Listando: \`${input.path || '/'}\``;
    default: return `${name}...`;
  }
}

async function handleTool(name, input) {
  try {
    switch (name) {
      case 'read_file': {
        const fullPath = path.join(REPO_PATH, input.path);
        if (!fullPath.startsWith(REPO_PATH)) return 'Acesso negado: caminho fora do projeto';
        if (!fs.existsSync(fullPath)) return `Arquivo não encontrado: ${input.path}`;
        const content = fs.readFileSync(fullPath, 'utf8');
        return content.length > 15000 ? content.slice(0, 15000) + '\n... (truncado)' : content;
      }

      case 'write_file': {
        const fullPath = path.join(REPO_PATH, input.path);
        if (!fullPath.startsWith(REPO_PATH)) return 'Acesso negado: caminho fora do projeto';
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, input.content);
        return `Arquivo ${input.path} salvo com sucesso (${input.content.length} bytes).`;
      }

      case 'edit_file': {
        const fullPath = path.join(REPO_PATH, input.path);
        if (!fullPath.startsWith(REPO_PATH)) return 'Acesso negado: caminho fora do projeto';
        if (!fs.existsSync(fullPath)) return `Arquivo não encontrado: ${input.path}`;
        let content = fs.readFileSync(fullPath, 'utf8');
        if (!content.includes(input.old_text)) {
          return `Texto não encontrado no arquivo ${input.path}. Verifique o trecho exato.`;
        }
        content = content.replace(input.old_text, input.new_text);
        fs.writeFileSync(fullPath, content);
        return `Arquivo ${input.path} editado com sucesso.`;
      }

      case 'run_command': {
        // Sem restrições - confia no Claude
        return safeExec(`cd ${REPO_PATH} && ${input.command}`, 60000);
      }

      case 'search_code': {
        const searchPath = input.path ? path.join(REPO_PATH, input.path) : REPO_PATH;
        const result = safeExec(
          `cd ${REPO_PATH} && grep -rn --include="*.php" --include="*.js" --include="*.vue" --include="*.blade.php" --include="*.css" --include="*.json" --include="*.ts" "${input.pattern}" ${searchPath} | head -50`,
          15000
        );
        return result || 'Nenhum resultado encontrado.';
      }

      case 'list_files': {
        const listPath = input.path ? path.join(REPO_PATH, input.path) : REPO_PATH;
        return safeExec(`find ${listPath} -maxdepth 2 -type f | head -80`);
      }

      default:
        return `Tool desconhecida: ${name}`;
    }
  } catch (err) {
    return `Erro: ${err.message}`;
  }
}

function safeExec(cmd, timeout = 15000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 5 * 1024 * 1024 });
  } catch (err) {
    return err.stdout || err.stderr || err.message;
  }
}

const PORT = process.env.AGENT_PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Claude Agent rodando na porta ${PORT}`);
  console.log(`📁 Repo: ${REPO_PATH}`);
  console.log(`🌿 Branch: ${BRANCH}`);
});
