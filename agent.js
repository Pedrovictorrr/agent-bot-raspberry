require('dotenv').config();

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const AGENT_SECRET = process.env.AGENT_SECRET || '';
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/home/pi/projects';

// Abort tracking
const activeSessions = new Map(); // sessionId -> { process, aborted }

// Projects config
let projects = {};
const projectsFile = path.join(__dirname, 'projects.json');

function loadProjects() {
  if (fs.existsSync(projectsFile)) {
    projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  }
  console.log(`📋 ${Object.keys(projects).length} projetos carregados:`, Object.keys(projects).join(', '));
}
loadProjects();

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

// Abort endpoint
app.post('/abort', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
      session.aborted = true;
      if (session.process) {
        session.process.kill('SIGTERM');
      }
      console.log(`[Abort] Sessão ${sessionId} cancelada`);
      res.json({ ok: true, message: 'Tarefa cancelada' });
    } else {
      res.json({ ok: false, message: 'Sessão não encontrada' });
    }
  } else {
    for (const [id, s] of activeSessions) {
      s.aborted = true;
      if (s.process) s.process.kill('SIGTERM');
      console.log(`[Abort] Sessão ${id} cancelada (abort all)`);
    }
    res.json({ ok: true, message: `${activeSessions.size} sessões canceladas` });
  }
});

// Main chat endpoint with SSE
app.post('/chat', async (req, res) => {
  const { message, auto, context, images } = req.body;
  const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session = { aborted: false, process: null };
  activeSessions.set(sessionId, session);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  function sendProgress(step) {
    res.write(`data: ${JSON.stringify({ type: 'progress', step, sessionId })}\n\n`);
  }

  function sendReply(reply) {
    res.write(`data: ${JSON.stringify({ type: 'reply', reply, sessionId })}\n\n`);
    activeSessions.delete(sessionId);
    res.end();
  }

  function sendError(error) {
    res.write(`data: ${JSON.stringify({ type: 'error', error, sessionId })}\n\n`);
    activeSessions.delete(sessionId);
    res.end();
  }

  try {
    sendProgress('Analisando o pedido...');

    // Determine project and working directory
    const proj = projects[activeProject];
    const cwd = proj?.path || PROJECTS_DIR;

    // Build project context
    const projectList = Object.entries(projects).map(([name, config]) => {
      const repoPath = config.path;
      const branch = fs.existsSync(repoPath)
        ? safeExec(`cd ${repoPath} && git branch --show-current`).trim()
        : '(não clonado)';
      return `- ${name}: ${config.repo} (branch: ${branch}) ${config.description ? '— ' + config.description : ''}`;
    }).join('\n');

    // Build the prompt for Claude Code
    let prompt = '';

    if (auto) {
      prompt += `MODO AUTOMÁTICO — analise este evento do Discord:\n`;
      prompt += `Para exceptions: identifique a causa provável e sugira o fix.\n`;
      prompt += `Para deploy com sucesso: responda apenas "ok".\n`;
      prompt += `Para deploy com falha: alerte e explique.\n`;
      prompt += `Se não tiver nada útil, responda "".\n\n`;
    } else {
      prompt += `Você é o Pedrinho, agente de desenvolvimento.\n`;
      prompt += `Responda em português brasileiro. Formate para Discord (** negrito, \` código).\n`;
      prompt += `REGRA: Se o pedido não mencionar qual projeto, pergunte qual projeto.\n\n`;
    }

    prompt += `Projetos disponíveis:\n${projectList}\n`;
    prompt += `Projeto ativo: ${activeProject || 'nenhum'}\n\n`;

    if (context?.recentMessages?.length > 0) {
      const recent = context.recentMessages.slice(-5).map(m => `[${m.author}]: ${m.content}`).join('\n');
      prompt += `Mensagens recentes:\n${recent}\n\n`;
    }

    prompt += `Pedido: ${message}`;

    // Handle images
    if (images && images.length > 0) {
      prompt += `\n\n[${images.length} imagem(ns) anexada(s) na mensagem]`;
    }

    sendProgress('Iniciando Claude Code...');

    // Run claude CLI with stream-json for real-time feedback
    // Use stdbuf -oL to force line-buffered stdout (Node spawn buffers otherwise)
    const claudeArgs = [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--max-turns', '30',
      '--verbose',
      prompt
    ];

    console.log(`[${activeProject}] Executando: claude --print --output-format stream-json "<prompt>"`);
    console.log(`[${activeProject}] CWD: ${cwd}`);

    const claudeProcess = spawn('stdbuf', ['-oL', 'claude', ...claudeArgs], {
      cwd: fs.existsSync(cwd) ? cwd : PROJECTS_DIR,
      env: { ...process.env, LANG: 'pt_BR.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600000, // 10 min
    });

    session.process = claudeProcess;

    let finalText = '';
    let buffer = '';
    let stepCount = 0;
    let lastProgressTime = 0;

    claudeProcess.stdout.on('data', (data) => {
      buffer += data.toString();

      // stream-json outputs one JSON object per line
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Init event — Claude Code started successfully
          if (event.type === 'system' && event.subtype === 'init') {
            sendProgress(`🧠 Claude Code conectado (${event.model || 'opus'})`);
            console.log(`[${activeProject}] Claude Code init: model=${event.model}`);
            continue;
          }

          // Collect final result text
          if (event.type === 'result' && event.result) {
            finalText = event.result;
            continue;
          }

          // Assistant message — check for tool_use and text
          if (event.type === 'assistant' && event.message) {
            const blocks = event.message.content || [];
            for (const block of blocks) {
              if (block.type === 'text') {
                finalText = block.text;
                // Send a snippet of text as progress
                const snippet = block.text.slice(0, 120).split('\n')[0];
                if (snippet.trim()) {
                  sendProgress(`💬 ${snippet}`);
                }
              }
              if (block.type === 'tool_use') {
                stepCount++;
                const name = block.name;
                const input = block.input || {};
                let detail = '';
                if (name === 'Read' || name === 'read_file') {
                  detail = `📖 Lendo: ${input.file_path || input.path || ''}`;
                } else if (name === 'Write' || name === 'write_file') {
                  detail = `✏️ Escrevendo: ${input.file_path || input.path || ''}`;
                } else if (name === 'Edit' || name === 'edit_file') {
                  detail = `🔧 Editando: ${input.file_path || input.path || ''}`;
                } else if (name === 'Bash' || name === 'execute_command') {
                  const cmd = (input.command || '').slice(0, 120);
                  detail = `⚡ Executando: \`${cmd}\``;
                } else if (name === 'Grep' || name === 'search') {
                  detail = `🔍 Buscando: ${input.pattern || input.query || ''}`;
                } else if (name === 'Glob') {
                  detail = `📂 Listando: ${input.pattern || ''}`;
                } else {
                  detail = `🛠️ ${name}`;
                }
                sendProgress(`[${stepCount}] ${detail}`);
                console.log(`[${activeProject}] [Step ${stepCount}] ${detail}`);
              }
            }
          }

          // Skip rate_limit_event and other types
        } catch (e) {
          // Not valid JSON, might be plain text output
          if (line.trim()) {
            finalText += line + '\n';
          }
        }
      }
    });

    claudeProcess.stderr.on('data', (data) => {
      const chunk = data.toString();
      console.error(`[Claude stderr] ${chunk}`);
    });

    claudeProcess.on('close', (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'result' && event.result) {
            finalText = event.result;
          }
        } catch (e) {
          if (buffer.trim()) finalText += buffer;
        }
      }

      if (session.aborted) {
        sendReply(`⛔ Tarefa cancelada pelo usuário.`);
        return;
      }

      if (code !== 0 && !finalText.trim()) {
        sendError(`Claude Code saiu com código ${code}`);
        return;
      }

      const reply = finalText.trim() || '(sem resposta)';
      console.log(`[${activeProject}] [Done] código: ${code}, ${stepCount} steps, ${reply.length} chars`);
      sendReply(reply);
    });

    claudeProcess.on('error', (err) => {
      console.error('Claude process error:', err);
      sendError(`Erro ao executar Claude Code: ${err.message}`);
    });

  } catch (err) {
    console.error('Agent error:', err);
    sendError(err.message);
  }
});

function safeExec(cmd, timeout = 15000) {
  const { execSync } = require('child_process');
  try {
    return execSync(cmd, { encoding: 'utf8', timeout, maxBuffer: 5 * 1024 * 1024 });
  } catch (err) {
    return err.stdout || err.stderr || err.message;
  }
}

const PORT = process.env.AGENT_PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Agent (Claude Code) rodando na porta ${PORT}`);
  console.log(`📁 Projetos: ${PROJECTS_DIR}`);
  console.log(`📋 Ativo: ${activeProject || 'nenhum'}`);
  loadProjects();
});
