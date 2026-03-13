import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __channelPilotPrisma__: PrismaClient | undefined;
}

export function createPrismaClient(): PrismaClient {
  if (!globalThis.__channelPilotPrisma__) {
    globalThis.__channelPilotPrisma__ = new PrismaClient();
  }

  return globalThis.__channelPilotPrisma__;
}
