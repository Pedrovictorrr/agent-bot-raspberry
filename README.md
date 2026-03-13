# Agent Bot Raspberry

Sistema de automacao de desenvolvimento via Discord + Alexa rodando em um Raspberry Pi 4. Usa o **Claude Code CLI** (plano Max) para analisar, editar e gerenciar projetos diretamente pelo chat.

## Como funciona

```
Discord #deploy-logs  ──>  bot.js  ──>  agent.js  ──>  Claude Code CLI
       <──  resposta  <──         <──              <──  (lê, edita, executa)
              |
Alexa (voz)  ──>  alexa-skill.js  ──>  Discord Webhook  ──>  mesmo fluxo acima
```

1. **Voce manda uma mensagem** no canal `#deploy-logs` do Discord (ou via Alexa por voz)
2. **bot.js** recebe a mensagem e envia para o **agent.js** via HTTP
3. **agent.js** executa o `claude --print --output-format stream-json` no diretorio do projeto
4. **Claude Code CLI** analisa o codigo, edita arquivos, roda comandos, faz commits — tudo autonomamente
5. O **progresso aparece em tempo real** no Discord (qual arquivo esta lendo, editando, etc.)
6. A **resposta final** e enviada de volta no Discord

## Componentes

### bot.js — Bot Discord
- Escuta **todas as mensagens** no canal configurado (`#deploy-logs`)
- Mensagens de **humanos**: mostra botao de cancelar, envia para o agent
- Mensagens de **webhooks** (deploy, exceptions): analisa automaticamente
  - Se detecta `Exception`, `Error`, `❌`, `🔴`: mostra "Analisando exception..." e envia para Claude
  - Se deploy OK: ignora (Claude responde "ok")
- **Botao de cancelar**: aborta a tarefa em andamento via endpoint `/abort`
- **Imagens**: extrai attachments de imagem e envia junto (vision)
- **Mensagens longas**: divide automaticamente em chunks de 1900 chars

### agent.js — Servidor Claude Code
- Express na porta `3001`
- **SSE (Server-Sent Events)** para feedback em tempo real
- Executa `claude` CLI como subprocesso com `spawn`
- Usa `--output-format stream-json` para parsear eventos em tempo real:
  - `📖 Lendo: arquivo.php`
  - `🔧 Editando: arquivo.php`
  - `⚡ Executando: php artisan migrate`
  - `🔍 Buscando: padrao`
  - `💬 texto da resposta...`
- **Multi-projeto**: carrega `projects.json` com configs de cada projeto
- **Abort**: mata o processo Claude Code via SIGTERM

### alexa-skill.js — Alexa Skill Server
- Express na porta `3002`
- Exposto via **ngrok** com dominio estatico
- Intents:
  - **SendCommandIntent**: "Alexa, abrir Mango, manda [comando]" → envia pro Discord via webhook
  - **GetResponseIntent**: "qual foi a resposta?" → le a ultima resposta do bot
  - LaunchRequest, Help, Stop/Cancel

### start-ngrok.sh — Tunnel HTTPS
- Inicia ngrok com dominio estatico apontando para porta 3002
- Necessario para Alexa que exige HTTPS

## Arquivos

| Arquivo | Descricao |
|---------|-----------|
| `bot.js` | Bot Discord com botao cancelar, imagens, SSE |
| `agent.js` | Servidor que executa Claude Code CLI |
| `alexa-skill.js` | Endpoint para Alexa Skill |
| `projects.json` | Configuracao dos projetos (path, repo, branch) |
| `ecosystem.config.js` | Configuracao PM2 |
| `start-ngrok.sh` | Script para iniciar ngrok |
| `.env` | Variaveis de ambiente (nao commitado) |

## Setup

### Pre-requisitos

- **Raspberry Pi 4** (ou qualquer Linux) com Node.js 18+
- **Claude Code CLI** instalado e autenticado com plano Max:
  ```bash
  sudo npm install -g @anthropic-ai/claude-code
  claude login  # selecionar "Claude account with subscription"
  ```
- **PM2** para gerenciamento de processos:
  ```bash
  sudo npm install -g pm2
  ```
- **ngrok** (se usar Alexa):
  ```bash
  sudo snap install ngrok
  ngrok config add-authtoken SEU_TOKEN
  ```

### Instalacao

```bash
# Clone o repositorio
git clone https://github.com/Pedrovictorrr/agent-bot-raspberry.git
cd agent-bot-raspberry

# Instale dependencias
npm install

# Configure o .env
cp .env.example .env
nano .env  # preencha com suas chaves

# Clone seus projetos
mkdir -p /home/pi/projects
cd /home/pi/projects
git clone https://github.com/seu-org/seu-projeto.git

# Configure projects.json com seus projetos
nano projects.json
```

### Configuracao do projects.json

```json
{
  "meu-projeto": {
    "path": "/home/pi/projects/meu-projeto",
    "repo": "org/repo-name",
    "branch": "main",
    "description": "Descricao do projeto"
  }
}
```

### Variaveis de ambiente (.env)

| Variavel | Descricao |
|----------|-----------|
| `DISCORD_TOKEN` | Token do bot Discord |
| `DISCORD_CHANNEL` | Nome do canal para monitorar (ex: `deploy-logs`) |
| `DISCORD_WEBHOOK` | Webhook URL do canal (para Alexa enviar mensagens) |
| `AGENT_URL` | URL do agent (default: `http://localhost:3001`) |
| `AGENT_PORT` | Porta do agent (default: `3001`) |
| `AGENT_SECRET` | Token de autenticacao entre bot e agent |
| `PROJECTS_DIR` | Diretorio base dos projetos (default: `/home/pi/projects`) |
| `ALEXA_SKILL_PORT` | Porta do Alexa skill (default: `3002`) |

### Iniciando com PM2

```bash
# Iniciar todos os servicos
pm2 start ecosystem.config.js

# Iniciar ngrok (se usar Alexa)
pm2 start start-ngrok.sh --name ngrok-tunnel --interpreter bash

# Salvar para auto-start no boot
pm2 save
pm2 startup
```

### Verificando

```bash
# Ver status dos processos
pm2 list

# Ver logs em tempo real
pm2 logs

# Health check do agent
curl http://localhost:3001/health
```

## Endpoints do Agent

| Metodo | Rota | Descricao |
|--------|------|-----------|
| `GET` | `/health` | Status dos projetos (branch, changes) |
| `GET` | `/projects` | Lista projetos configurados |
| `POST` | `/chat` | Envia mensagem para Claude (SSE response) |
| `POST` | `/abort` | Cancela tarefa em andamento |

### POST /chat

```json
{
  "message": "crie uma migration para tabela users",
  "auto": false,
  "images": [],
  "context": {
    "recentMessages": []
  }
}
```

Retorna SSE com eventos:
```
data: {"type":"progress","step":"🧠 Claude Code conectado (claude-opus-4-6)","sessionId":"s_123"}
data: {"type":"progress","step":"[1] 📖 Lendo: app/Models/User.php","sessionId":"s_123"}
data: {"type":"progress","step":"[2] ✏️ Escrevendo: database/migrations/2026_create_users.php","sessionId":"s_123"}
data: {"type":"reply","reply":"Migration criada com sucesso!","sessionId":"s_123"}
```

## Autenticacao do Claude Code

O Claude Code CLI usa **OAuth** com sua conta Claude (plano Max/Pro/Team). Nao usa API key.

Para autenticar em um servidor headless (sem browser):
1. Rode `claude login` no servidor
2. Selecione "Claude account with subscription"
3. Copie a URL gerada e abra no browser do seu computador
4. Autorize e o terminal do servidor detecta automaticamente

As credenciais ficam em `~/.claude/.credentials.json`.

**Alternativa**: copie as credenciais de uma maquina ja autenticada:
```bash
# Na maquina autenticada (Mac/Linux):
security find-generic-password -s "Claude Code-credentials" -w  # macOS
cat ~/.claude/.credentials.json  # Linux

# No servidor:
mkdir -p ~/.claude
echo 'CREDENCIAIS_JSON' > ~/.claude/.credentials.json
chmod 600 ~/.claude/.credentials.json
```

## Dicas

- Crie um `.claudeignore` na raiz dos projetos para ignorar pastas grandes:
  ```
  vendor/
  node_modules/
  storage/
  .git/
  ```
- O Claude Code usa **Opus 4.6** por padrao (modelo mais capaz)
- Limite de 30 turns por execucao (`--max-turns 30`)
- Timeout de 10 minutos por tarefa
- Para exceptions automaticas, configure webhooks do Laravel/Sentry apontando para o canal Discord
