import { createApp } from './app.js';

const PORT = process.env.PORT ?? 8086;

const app = createApp();

app.listen(PORT, () => {
  console.log(JSON.stringify({
    level: 'info',
    action: 'startup',
    message: `Mock Agent listening on port ${PORT}`,
  }));
});
