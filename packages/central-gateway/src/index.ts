import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = createApp();

app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    level: 'info',
    service: 'central-gateway',
    port: config.port,
    host: config.host,
    baseUrl: config.baseUrl,
    provisioningServiceUrl: config.provisioningServiceUrl,
    message: 'Central Gateway started',
  }));
});
