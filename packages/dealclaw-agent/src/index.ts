import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 18789);
const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    service: 'dealclaw-agent',
    port: PORT,
    message: 'DealClaw Agent started',
  }));
});
