module.exports = {
  apps: [
    {
      name: 'claude-agent',
      script: 'agent.js',
      env_file: '.env',
      watch: false,
      max_memory_restart: '300M',
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: 'discord-bot',
      script: 'bot.js',
      env_file: '.env',
      watch: false,
      max_memory_restart: '200M',
      restart_delay: 5000,
      max_restarts: 10,
      // Bot depende do agent estar rodando
      wait_ready: true
    }
  ]
};
