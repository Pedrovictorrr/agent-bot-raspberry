# agent-bot-raspberry

Discord bot + Claude agent rodando em Raspberry Pi 4 para gerenciar um projeto Laravel via chat.

## Arquitetura

- **bot.js** — Bot Discord que escuta mensagens no canal `#deploy-logs`
- **agent.js** — Servidor Express (porta 3001) com Claude agentic loop
- **SSE** — Feedback em tempo real no Discord a cada etapa executada

## Setup

```bash
# Clone
git clone https://github.com/Pedrovictorrr/agent-bot-raspberry.git
cd agent-bot-raspberry

# Instalar dependências
npm install

# Configurar .env
cp .env.example .env
# Editar .env com suas chaves

# Rodar com PM2
pm2 start ecosystem.config.js
pm2 save
```

## Variáveis de ambiente

| Variável | Descrição |
|----------|-----------|
| `DISCORD_TOKEN` | Token do bot Discord |
| `DISCORD_CHANNEL` | Nome do canal para monitorar |
| `ANTHROPIC_API_KEY` | Chave da API do Claude |
| `REPO_PATH` | Caminho do repositório clonado |
| `BRANCH` | Branch de trabalho (auto-deploy) |
| `AGENT_SECRET` | Token de autenticação do agent |
