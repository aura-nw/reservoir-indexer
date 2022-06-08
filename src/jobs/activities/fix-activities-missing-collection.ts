/* eslint-disable @typescript-eslint/no-explicit-any */

import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { config } from "@/config/index";

import { Activities } from "@/models/activities";
import { UserActivities } from "@/models/user_activities";
import { Tokens } from "@/models/tokens";

const QUEUE_NAME = "fix-activities-missing-collection-queue";
const MAX_RETRIES = 5;

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: true,
    removeOnFail: 10000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { contract, tokenId } = job.data;

      const token = await Tokens.getByContractAndTokenId(contract, tokenId);

      if (token?.collectionId) {
        // Update the collection id of any missing activities
        await Promise.all([
          Activities.updateMissingCollectionId(contract, tokenId, token.collectionId),
          UserActivities.updateMissingCollectionId(contract, tokenId, token.collectionId),
        ]);
      }
    },
    { connection: redis.duplicate(), concurrency: 15 }
  );

  worker.on("completed", async (job) => {
    if (job.data.retry < MAX_RETRIES) {
      await addToQueue(job.data.contract, job.data.tokenId, ++job.data.retry);
    } else {
      logger.warn(QUEUE_NAME, `Max retries reached for ${JSON.stringify(job.data)}`);
    }
  });

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const addToQueue = async (contract: string, tokenId: string, retry = 0) => {
  const jobId = `${contract}:${tokenId}`;
  const delay = retry ? retry ** 2 * 300 * 1000 : 0;

  await queue.add(
    randomUUID(),
    {
      contract,
      tokenId,
      retry,
    },
    {
      jobId,
      delay,
    }
  );
};
