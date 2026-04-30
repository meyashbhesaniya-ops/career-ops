/**
 * ecosystem.config.cjs — pm2 process definitions
 *
 * Micro #0 (89.168.115.96): orchestrator, telegram-bot, scout, evaluator, oci-watch
 * Micro #1 (130.162.209.192): tailor
 *
 * Usage:
 *   On Micro #0: pm2 start ecosystem.config.cjs --only orchestrator,telegram-bot,scout,evaluator,oci-watch
 *   On Micro #1: pm2 start ecosystem.config.cjs --only tailor
 *   Or just:     pm2 start ecosystem.config.cjs (starts all — filter by host)
 */

module.exports = {
  apps: [
    {
      name: 'orchestrator',
      script: 'agents/orchestrator.mjs',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: { NODE_ENV: 'production' },
      error_file: 'logs/orchestrator-err.log',
      out_file: 'logs/orchestrator-out.log',
      merge_logs: true,
    },
    {
      name: 'telegram-bot',
      script: 'agents/telegram-bot.mjs',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: { NODE_ENV: 'production' },
      error_file: 'logs/bot-err.log',
      out_file: 'logs/bot-out.log',
      merge_logs: true,
    },
    {
      name: 'scout',
      script: 'agents/scout.mjs',
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 10000,
      env: { NODE_ENV: 'production' },
      error_file: 'logs/scout-err.log',
      out_file: 'logs/scout-out.log',
      merge_logs: true,
    },
    {
      name: 'evaluator',
      script: 'agents/evaluator.mjs',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: { NODE_ENV: 'production' },
      error_file: 'logs/evaluator-err.log',
      out_file: 'logs/evaluator-out.log',
      merge_logs: true,
    },
    {
      name: 'oci-watch',
      script: 'agents/oci-capacity-watch.mjs',
      instances: 1,
      autorestart: true,
      max_restarts: 3,
      restart_delay: 60000,
      env: { NODE_ENV: 'production' },
      error_file: 'logs/oci-watch-err.log',
      out_file: 'logs/oci-watch-out.log',
      merge_logs: true,
    },
    {
      name: 'tailor',
      script: 'agents/tailor.mjs',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: { NODE_ENV: 'production' },
      error_file: 'logs/tailor-err.log',
      out_file: 'logs/tailor-out.log',
      merge_logs: true,
    },
  ],
};
