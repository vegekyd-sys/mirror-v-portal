import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { startWSClient, shouldStartWSClient } from './ws-client.js';

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

  // Start the Feishu WS long-connection for this tenant (non-blocking) —
  // unless the in-agent @openclaw/feishu plugin owns the message plane.
  if (shouldStartWSClient(config.platform, process.env.DEALCLAW_MESSAGE_PLANE)) {
    startWSClient(config).catch(err => {
      console.error(`[ws:${config.tenantId}] WSClient failed:`, err);
    });
  } else if ((process.env.DEALCLAW_MESSAGE_PLANE || 'gateway') === 'openclaw') {
    console.log(`[ws:${config.tenantId}] DEALCLAW_MESSAGE_PLANE=openclaw — feishu plugin owns the message plane, WS not started`);
  }
});
