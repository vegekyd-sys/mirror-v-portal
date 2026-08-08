import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 8090);
const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    service: 'admin-dashboard',
    port: PORT,
    message: 'Admin Dashboard started',
  }));
});
