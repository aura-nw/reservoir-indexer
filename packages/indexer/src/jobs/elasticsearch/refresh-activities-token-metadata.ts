import { Job, Queue, QueueScheduler, Worker } from "bullmq";

import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { config } from "@/config/index";
import { Tokens } from "@/models/tokens";
import * as ActivitiesIndex from "@/elasticsearch/indexes/activities";

const QUEUE_NAME = "refresh-activities-token-metadata-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 1000,
    removeOnFail: 1000,
    backoff: {
      type: "fixed",
      delay: 5000,
    },
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      logger.info(QUEUE_NAME, `Worker started. jobData=${JSON.stringify(job.data)}`);

      const { contract, tokenId } = job.data;

      const tokenData = await Tokens.getByContractAndTokenId(contract, tokenId);

      if (tokenData) {
        await ActivitiesIndex.updateActivitiesTokenMetadata(contract, tokenId, tokenData);
      }
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const addToQueue = async (contract: string, tokenId: string) => {
  await queue.add(
    `${contract}:${tokenId}`,
    { contract, tokenId },
    { jobId: `${contract}:${tokenId}` }
  );
};