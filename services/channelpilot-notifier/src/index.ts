import "dotenv/config";
import pino from "pino";
import { ChannelPilotRepository } from "@channelpilot/db";
import { FileBackedMockOpenClawStore, MockOpenClawAdapter } from "@channelpilot/openclaw-adapter";
import { loadRuntimeConfig } from "@channelpilot/shared-types";

const config = loadRuntimeConfig(process.env);
const logger = pino({ level: config.LOG_LEVEL });
const repository = new ChannelPilotRepository();
const adapter = new MockOpenClawAdapter(new FileBackedMockOpenClawStore(config.MOCK_OPENCLAW_STATE_FILE));

async function drainOutbox() {
  const claimed = await repository.claimNotifications(20, `notifier:${process.pid}`);
  for (const item of claimed) {
    try {
      const payload = item.payload_json as {
        message: string;
        taskId: string;
        threadKey: string;
        notificationKind: string;
      };

      await adapter.postThreadReply({
        threadKey: item.thread_key,
        taskId: item.task_id,
        message: payload.message
      });
      await repository.markNotificationDelivered(item.notification_id);
      await repository.updateTaskSnapshot({
        taskId: item.task_id,
        lastEmittedSummary: payload.message,
        lastNotifiedAt: new Date()
      });
      await repository.appendTaskEvent({
        taskId: item.task_id,
        eventType: "NOTIFICATION_DELIVERED",
        source: "notifier",
        reason: `notification delivered: ${item.notification_kind}`,
        payloadJson: {
          notificationId: item.notification_id
        }
      });
    } catch (error) {
      logger.error({ err: error, notificationId: item.notification_id }, "notification delivery failed");
      await repository.markNotificationFailed(
        item.notification_id,
        error instanceof Error ? error.message : "unknown notifier failure",
        15
      );
      await repository.appendTaskEvent({
        taskId: item.task_id,
        eventType: "NOTIFICATION_FAILED",
        source: "notifier",
        reason: error instanceof Error ? error.message : "unknown notifier failure",
        payloadJson: {
          notificationId: item.notification_id
        }
      });
    }
  }
}

setInterval(() => {
  drainOutbox().catch((error) => {
    logger.error({ err: error }, "failed to drain notification outbox");
  });
}, 5_000);

drainOutbox().catch((error) => {
  logger.error({ err: error }, "initial notification drain failed");
});

logger.info("channelpilot notifier started");
