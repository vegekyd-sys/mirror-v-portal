import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = createApp();

app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    service: 'central-gateway',
    port: config.port,
    baseUrl: config.baseUrl,
    provisioningServiceUrl: config.provisioningServiceUrl,
    message: 'Central Gateway started',
  }));
});
