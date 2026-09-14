import { loadConfig } from "../src/config.js";
const c = loadConfig();
process.env.BASE_URL = `http://127.0.0.1:${c.port}`;
process.env.PROVISIONING_SERVICE_URL = process.env.BASE_URL;
process.env.PROVISIONING_API_TOKEN = c.adminToken;
const { createApp } = await import("../../central-gateway/src/app.js");
createApp().listen(8098, "127.0.0.1", () =>
  console.log("Original QR onboarding on loopback 8098"),
);
