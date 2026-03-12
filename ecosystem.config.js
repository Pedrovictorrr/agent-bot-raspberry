module.exports = {
  apps: [
    {
      name: 'claude-agent',
      script: 'agent.js',
      watch: false,
      max_memory_restart: '300M',
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'discord-bot',
      script: 'bot.js',
      watch: false,
      max_memory_restart: '200M',
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'alexa-skill',
      script: 'alexa-skill.js',
      watch: false,
      max_memory_restart: '100M',
      restart_delay: 5000,
      max_restarts: 10
    }
  ]
};
