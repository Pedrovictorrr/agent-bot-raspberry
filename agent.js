require('dotenv').config();

const express = require('express');
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const anthropic = new Anthropic();

const AGENT_SECRET = process.env.AGENT_SECRET || '';
const MAX_TOOL_ITERATIONS = 25;
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/home/pi/projects';

// Projects config — loaded from projects.json
let projects = {};
const projectsFile = path.join(__dirname, 'projects.json');

function loadProjects() {
  if (fs.existsSync(projectsFile)) {
    projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  }
  console.log(`📋 ${Object.keys(projects).length} projetos carregados:`, Object.keys(projects).join(', '));
}
loadProjects();

// Current active project per session
let activeProject = Object.keys(projects)[0] || null;

// Auth middleware
app.use((req, res, next) => {
  if (AGENT_SECRET && req.headers.authorization !== `Bearer ${AGENT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Health check
app.get('/health', (req, res) => {
  const status = {};
  for (const [name, config] of Object.entries(projects)) {
    const repoPath = config.path;
    if (fs.existsSync(repoPath)) {
      const branch = safeExec(`cd ${repoPath} && git branch --show-current`).trim();
      const changes = safeExec(`cd ${repoPath} && git status --short`).trim();
      status[name] = { branch, changes: changes || 'clean', path: repoPath };
    } else {
      status[name] = { error: 'repo not found', path: repoPath };
    }
  }
  res.json({ activeProject, projects: status });
});

// List projects
app.get('/projects', (req, res) => {
  res.json({ activeProject, projects });
});

// Clone a new project
app.post('/projects/clone', async (req, res) => {
  const { name, repo, branch } = req.body;
  if (!name || !repo) return res.status(400).json({ error: 'name and repo required' });

  const repoPath = path.join(PROJECTS_DIR, name);
  try {
    if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const output = safeExec(`cd ${PROJECTS_DIR} && gh repo clone ${repo} ${name} 2>&1`, 120000);

    if (branch && branch !== 'main') {
      safeExec(`cd ${repoPath} && git checkout -b ${branch} 2>&1`, 10000);
      safeExec(`cd ${repoPath} && git push -u origin ${branch} 2>&1`, 30000);
    }

    projects[name] = {
      path: repoPath,
      repo,
      branch: branch || 'main',
      description: ''
    };
    fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
    activeProject = name;

    res.json({ success: true, output, project: projects[name] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main chat endpoint with SSE progress
app.post('/chat', async (req, res) => {
  const { message, auto, context } = req.body;

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

    // Build project list for Claude
    const projectList = Object.entries(projects).map(([name, config]) => {
      const repoPath = config.path;
      const branch = fs.existsSync(repoPath)
        ? safeExec(`cd ${repoPath} && git branch --show-current`).trim()
        : '(não clonado)';
      return `- **${name}**: ${config.repo} (branch: ${branch}) ${config.description ? '— ' + config.description : ''}`;
    }).join('\n');

    // Get active project info
    const proj = projects[activeProject];
    const repoPath = proj?.path || PROJECTS_DIR;
    let gitLog = '', gitStatus = '', currentBranch = '';

    if (proj && fs.existsSync(repoPath)) {
      gitLog = safeExec(`cd ${repoPath} && git log --oneline -10`);
      gitStatus = safeExec(`cd ${repoPath} && git status --short`);
      currentBranch = safeExec(`cd ${repoPath} && git branch --show-current`).trim();
    }

    const systemPrompt = `Você é o Pedrinho, um agente de desenvolvimento com acesso a múltiplos projetos.

## Projetos disponíveis:
${projectList}

## Projeto ativo: **${activeProject || 'nenhum'}**
${proj ? `Caminho: ${repoPath}
Branch: ${currentBranch}
Branch de deploy: ${proj.branch}

Git status:
${gitStatus || '(limpo)'}

Últimos commits:
${gitLog}` : 'Nenhum projeto ativo. Use switch_project para selecionar.'}

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
- IMPORTANTE: Ao terminar, SEMPRE dê um resumo final claro
- Formate respostas com quebras de linha para Discord
- Use ** para negrito e \` para código inline
- Se o usuário mencionar um projeto pelo nome, troque para ele com switch_project
- Quando listar projetos, mostre o status de cada um
- REGRA CRÍTICA: Se o usuário pedir qualquer tarefa (editar código, corrigir bug, criar feature, commitar, etc) e a mensagem NÃO mencionar claramente qual projeto (pelo nome, URL do repo, ou contexto óbvio), PARE e PERGUNTE: "Em qual projeto você quer que eu faça isso?" e liste os projetos disponíveis. NÃO assuma o projeto ativo automaticamente.
- Exceções: se o usuário acabou de trocar de projeto ou mencionou o nome do projeto na mesma mensagem, pode prosseguir sem perguntar.`}

${context?.recentMessages ? `Mensagens recentes do canal:\n${context.recentMessages.map(m => `[${m.author}]: ${m.content}`).join('\n')}` : ''}

IMPORTANTE: Sempre responda em português brasileiro.`;

    const tools = [
      {
        name: 'switch_project',
        description: 'Troca o projeto ativo. Todas as operações de arquivo e git passam a ser nesse projeto.',
        input_schema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Nome do projeto (ex: psiserp, hadescondo, petfolio)' }
          },
          required: ['project']
        }
      },
      {
        name: 'clone_project',
        description: 'Clona um novo repositório do GitHub para o Pi',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nome curto do projeto (usado como pasta)' },
            repo: { type: 'string', description: 'Repositório GitHub (ex: Pedrovictorrr/meu-repo ou org/repo)' },
            branch: { type: 'string', description: 'Branch de trabalho (padrão: main)' },
            description: { type: 'string', description: 'Descrição curta do projeto' }
          },
          required: ['name', 'repo']
        }
      },
      {
        name: 'read_file',
        description: 'Lê o conteúdo de um arquivo do projeto ativo',
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
        description: 'Escreve/modifica um arquivo do projeto ativo',
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
        name: 'edit_file',
        description: 'Substitui um trecho de texto em um arquivo (search & replace)',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Caminho relativo ao root do projeto' },
            old_text: { type: 'string', description: 'Texto exato a ser substituído' },
            new_text: { type: 'string', description: 'Texto novo que vai substituir' }
          },
          required: ['path', 'old_text', 'new_text']
        }
      },
      {
        name: 'run_command',
        description: 'Executa qualquer comando shell no diretório do projeto ativo',
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
        description: 'Busca por padrão no código do projeto ativo',
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
        description: 'Lista arquivos em um diretório do projeto ativo',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Caminho relativo ao root (padrão: root)' }
          },
          required: []
        }
      }
    ];

    // Agentic loop
    let messages = [{ role: 'user', content: message }];
    let iterations = 0;
    let lastTextReply = '';

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      console.log(`[${activeProject}] [Loop ${iterations}/${MAX_TOOL_ITERATIONS}]`);

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

      if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
        break;
      }

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

    console.log(`[${activeProject}] [Done] ${iterations} iterações`);
    sendReply(lastTextReply.trim() || '(sem resposta)');
  } catch (err) {
    console.error('Agent error:', err);
    sendError(err.message);
  }
});

function getToolDescription(name, input) {
  switch (name) {
    case 'switch_project': return `Trocando para projeto: **${input.project}**`;
    case 'clone_project': return `Clonando projeto: **${input.name}** de ${input.repo}`;
    case 'read_file': return `Lendo: \`${input.path}\``;
    case 'write_file': return `Escrevendo: \`${input.path}\``;
    case 'edit_file': return `Editando: \`${input.path}\``;
    case 'run_command': return `Executando: \`${input.command.slice(0, 80)}\``;
    case 'search_code': return `Buscando: \`${input.pattern}\``;
    case 'list_files': return `Listando: \`${input.path || '/'}\``;
    default: return `${name}...`;
  }
}

function getActiveRepoPath() {
  const proj = projects[activeProject];
  return proj?.path || PROJECTS_DIR;
}

async function handleTool(name, input) {
  try {
    // Project management tools
    if (name === 'switch_project') {
      const projectName = input.project.toLowerCase();
      // Fuzzy match
      const match = Object.keys(projects).find(k =>
        k.toLowerCase() === projectName ||
        k.toLowerCase().includes(projectName) ||
        projectName.includes(k.toLowerCase())
      );
      if (!match) {
        return `Projeto "${input.project}" não encontrado. Disponíveis: ${Object.keys(projects).join(', ')}`;
      }
      activeProject = match;
      const proj = projects[match];
      const branch = safeExec(`cd ${proj.path} && git branch --show-current`).trim();
      return `Projeto ativo: **${match}** (${proj.repo}, branch: ${branch})`;
    }

    if (name === 'clone_project') {
      const repoPath = path.join(PROJECTS_DIR, input.name);
      if (fs.existsSync(repoPath)) {
        return `Pasta ${input.name} já existe. Use switch_project para ativar.`;
      }
      if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

      const output = safeExec(`cd ${PROJECTS_DIR} && gh repo clone ${input.repo} ${input.name} 2>&1`, 120000);

      const branch = input.branch || 'ai-fixes';
      if (branch !== 'main') {
        safeExec(`cd ${repoPath} && git checkout -b ${branch} 2>&1`, 10000);
        safeExec(`cd ${repoPath} && git push -u origin ${branch} 2>&1`, 30000);
      }

      projects[input.name] = {
        path: repoPath,
        repo: input.repo,
        branch,
        description: input.description || ''
      };
      fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
      activeProject = input.name;

      return `Projeto "${input.name}" clonado com sucesso em ${repoPath} (branch: ${branch}).\n${output}`;
    }

    // File/code tools — use active project
    const repoPath = getActiveRepoPath();

    switch (name) {
      case 'read_file': {
        const fullPath = path.join(repoPath, input.path);
        if (!fullPath.startsWith(repoPath)) return 'Acesso negado: caminho fora do projeto';
        if (!fs.existsSync(fullPath)) return `Arquivo não encontrado: ${input.path}`;
        const content = fs.readFileSync(fullPath, 'utf8');
        return content.length > 15000 ? content.slice(0, 15000) + '\n... (truncado)' : content;
      }

      case 'write_file': {
        const fullPath = path.join(repoPath, input.path);
        if (!fullPath.startsWith(repoPath)) return 'Acesso negado: caminho fora do projeto';
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, input.content);
        return `Arquivo ${input.path} salvo com sucesso (${input.content.length} bytes).`;
      }

      case 'edit_file': {
        const fullPath = path.join(repoPath, input.path);
        if (!fullPath.startsWith(repoPath)) return 'Acesso negado: caminho fora do projeto';
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
        return safeExec(`cd ${repoPath} && ${input.command}`, 60000);
      }

      case 'search_code': {
        const searchPath = input.path ? path.join(repoPath, input.path) : repoPath;
        const result = safeExec(
          `cd ${repoPath} && grep -rn --include="*.php" --include="*.js" --include="*.vue" --include="*.blade.php" --include="*.css" --include="*.json" --include="*.ts" "${input.pattern}" ${searchPath} | head -50`,
          15000
        );
        return result || 'Nenhum resultado encontrado.';
      }

      case 'list_files': {
        const listPath = input.path ? path.join(repoPath, input.path) : repoPath;
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
  console.log(`📁 Projetos: ${PROJECTS_DIR}`);
  console.log(`📋 Ativo: ${activeProject || 'nenhum'}`);
  loadProjects();
});
