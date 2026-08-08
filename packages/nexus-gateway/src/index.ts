import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { startWSClient } from './ws-client.js';

const config = loadConfig();
const app = createApp(config);

const port = config.port;
app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    service: 'nexus-gateway',
    tenantId: config.tenantId,
    port,
    message: 'Gateway started',
  }));

  // Start Feishu WS long-connection for this tenant (non-blocking)
  if (config.platform === 'feishu') {
    startWSClient(config).catch(err => {
      console.error(`[ws:${config.tenantId}] WSClient failed:`, err);
    });
  }
});
