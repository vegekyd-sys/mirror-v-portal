import { config } from "./config";
import { prisma } from "./prisma";
import { buildServer } from "./http/server";

async function main() {
  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    { env: config.appEnv, port: config.port, bridgeBaseUrl: config.bridgeBaseUrl },
    "whatsapp-platform-bridge listening",
  );
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
