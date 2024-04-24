/* eslint-disable @typescript-eslint/no-explicit-any */

import _ from "lodash";
import Hapi, { Request } from "@hapi/hapi";

import { idb, pgp, redb } from "@/common/db";
import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import {
  ApiKeyEntity,
  ApiKeyPermission,
  ApiKeyUpdateParams,
} from "@/models/api-keys/api-key-entity";
import getUuidByString from "uuid-by-string";
import { AllChainsChannel, Channel } from "@/pubsub/channels";
import axios from "axios";
import { getNetworkName, getSubDomain } from "@/config/network";
import { config } from "@/config/index";
import { Boom } from "@hapi/boom";
import tracer from "@/common/tracer";
import flat from "flat";
import { fromBuffer, regex } from "@/common/utils";
import { syncApiKeysJob } from "@/jobs/api-keys/sync-api-keys-job";
import { AllChainsPubSub, PubSub } from "@/pubsub/index";

export type ApiKeyRecord = {
  appName: string;
  website: string;
  email: string;
  tier: number;
  key?: string;
  active?: boolean;
  permissions?: Partial<Record<ApiKeyPermission, unknown>>;
  ips?: string[];
  origins?: string[];
  revShareBps?: number | null;
};

export type NewApiKeyResponse = {
  key: string;
};

export class ApiKeyManager {
  public static defaultRevShareBps = 3000;

  private static apiKeys: Map<string, ApiKeyEntity> = new Map();

  /**
   * Create a new key, leave the ApiKeyRecord.key empty to generate a new key (uuid) in this function
   *
   * @param values
   */
  public async create(values: ApiKeyRecord): Promise<NewApiKeyResponse | boolean> {
    // Create a new key if none was set
    if (!values.key) {
      values.key = getUuidByString(`${values.key}${values.email}${values.website}`);
    }

    values.active = true;

    let created;

    const columns = new pgp.helpers.ColumnSet(
      Object.entries(values).map(([key, value]) =>
        _.isObject(value) ? { name: _.snakeCase(key), mod: ":json" } : _.snakeCase(key)
      ),
      {
        table: "api_keys",
      }
    );

    // Create the record in the database
    try {
      created = await idb.oneOrNone(
        `${pgp.helpers.insert(
          _.mapKeys(values, (value, key) => _.snakeCase(key)),
          columns
        )} ON CONFLICT DO NOTHING RETURNING 1`
      );
    } catch (e) {
      logger.error("api-key", `Unable to create a new apikeys record: ${e}`);
      return false;
    }

    // Sync to other chains only if created on mainnet
    if (created && config.chainId === 1) {
      await ApiKeyManager.notifyApiKeyCreated(values);
      await AllChainsPubSub.publish(AllChainsChannel.ApiKeyCreated, JSON.stringify({ values }));

      // Trigger delayed jobs to make sure all chains have the new api key
      await syncApiKeysJob.addToQueue({ apiKey: values.key }, 30 * 1000);
      await syncApiKeysJob.addToQueue({ apiKey: values.key }, 60 * 1000);
    }

    return {
      key: values.key,
    };
  }

  public static async deleteCachedApiKey(key: string) {
    ApiKeyManager.apiKeys.delete(key); // Delete from local memory cache
    await redis.del(`api-key:${key}`); // Delete from redis cache
  }

  /**
   * When a user passes an api key, we retrieve the details from redis
   * In case the details are not in redis (new redis, api key somehow disappeared from redis) we try to fetch it from
   * the database. In case we couldn't find the key in the database, the key must be wrong. To avoid us doing the
   * lookup constantly in the database, we set a temporary hash key in redis with one value { empty: true }
   *
   * @param key
   * @param remoteAddress
   * @param origin
   * @param validateOriginAndIp
   */
  public static async getApiKey(
    key: string,
    remoteAddress = "",
    origin = "",
    validateOriginAndIp = true
  ): Promise<ApiKeyEntity | null> {
    // Static admin API key
    if (key === config.adminApiKey) {
      return new ApiKeyEntity({
        key: "00000000-0000-0000-0000-000000000000",
        app_name: "Indexer Admin",
        website: "reservoir.tools",
        email: "backend@unevenlabs.com",
        created_at: "1970-01-01T00:00:00.000Z",
        active: true,
        tier: 5,
        permissions: {
          update_metadata_disabled: true,
        },
        ips: [],
        origins: [],
        rev_share_bps: ApiKeyManager.defaultRevShareBps,
      });
    }

    const cachedApiKey = ApiKeyManager.apiKeys.get(key);
    if (cachedApiKey) {
      if (!validateOriginAndIp) {
        return cachedApiKey;
      } else if (ApiKeyManager.isOriginAndIpValid(cachedApiKey, remoteAddress, origin)) {
        return cachedApiKey;
      }

      return null;
    }

    // Timeout for redis
    const timeout = new Promise<null>((resolve) => {
      setTimeout(resolve, 1000, null);
    });

    const redisKey = `api-key:${key}`;

    try {
      const apiKey = await Promise.race([redis.get(redisKey), timeout]);

      if (apiKey) {
        if (apiKey == "empty") {
          return null;
        } else {
          const apiKeyEntity = new ApiKeyEntity(JSON.parse(apiKey));
          ApiKeyManager.apiKeys.set(key, apiKeyEntity); // Set in local memory storage
          if (!validateOriginAndIp) {
            return apiKeyEntity;
          } else if (ApiKeyManager.isOriginAndIpValid(apiKeyEntity, remoteAddress, origin)) {
            return apiKeyEntity;
          }
        }
      } else {
        // check if it exists in the database
        const fromDb = await redb.oneOrNone(
          `SELECT * FROM api_keys WHERE key = $/key/ AND active = true`,
          { key }
        );

        if (fromDb) {
          try {
            Promise.race([redis.set(redisKey, JSON.stringify(fromDb)), timeout]).catch(); // Set in redis (no need to wait)
          } catch {
            // Ignore errors
          }

          const apiKeyEntity = new ApiKeyEntity(fromDb);
          ApiKeyManager.apiKeys.set(key, apiKeyEntity); // Set in local memory storage
          if (!validateOriginAndIp) {
            return apiKeyEntity;
          } else if (ApiKeyManager.isOriginAndIpValid(apiKeyEntity, remoteAddress, origin)) {
            return apiKeyEntity;
          }
        } else {
          const pipeline = redis.pipeline();
          pipeline.set(redisKey, "empty");
          pipeline.expire(redisKey, 3600 * 24);

          try {
            Promise.race([pipeline.exec(), timeout]).catch(); // Set in redis (no need to wait)
          } catch {
            // Ignore errors
          }
        }
      }
    } catch (error) {
      logger.error("get-api-key", `Failed to get ${key} error: ${error}`);
    }

    return null;
  }

  static isOriginAndIpValid(apiKey: ApiKeyEntity, remoteAddress: string, origin: string) {
    if (apiKey.origins && !_.isEmpty(apiKey.origins)) {
      const hostname = origin.match(regex.origin);
      if (!hostname || (hostname && _.indexOf(apiKey.origins, hostname[0]) === -1)) {
        return false;
      }
    }

    if (apiKey.ips && !_.isEmpty(apiKey.ips) && _.indexOf(apiKey.ips, remoteAddress) === -1) {
      return false;
    }

    return true;
  }

  /**
   * Log usage of the api key in the logger
   *
   * @param request
   */
  static async getBaseLog(request: Request) {
    const key = request.headers["x-api-key"];

    let responseStatusCode = (request.response as Hapi.ResponseObject).statusCode;

    if ("output" in request.response) {
      responseStatusCode = request.response["output"]["statusCode"];
    }

    const log: any = {
      route: request.route.path,
      method: request.route.method,
      requestReceivedAt: new Date(request.info.received).toISOString(),
      responseStatusCode,
      responseLatencyMs: new Date().getTime() - request.info.received,
    };

    if (request.payload) {
      log.payload = {};
      for (const [key, value] of Object.entries(request.payload)) {
        log.payload[key] = Buffer.isBuffer(value) ? fromBuffer(value) : value;
      }
    }

    if (request.params) {
      log.params = {};
      for (const [key, value] of Object.entries(request.params)) {
        log.params[key] = Buffer.isBuffer(value) ? fromBuffer(value) : value;
      }
    }

    if (request.query) {
      log.query = {};
      for (const [key, value] of Object.entries(request.query)) {
        log.query[key] = Buffer.isBuffer(value) ? fromBuffer(value) : value;
      }
    }

    if (request.headers["user-agent"]) {
      log.userAgent = request.headers["user-agent"];
    }

    if (request.headers["x-forwarded-for"]) {
      log.remoteAddress = request.headers["x-forwarded-for"];
    }

    if (request.headers["origin"]) {
      log.origin = request.headers["origin"];
    }

    if (request.headers["x-syncnode-version"]) {
      log.syncnodeVersion = request.headers["x-syncnode-version"];
    }

    if (request.headers["x-rkui-context"]) {
      log.rkuiContext = request.headers["x-rkui-context"];
    }

    if (request.headers["x-rkui-version"]) {
      log.rkuiVersion = request.headers["x-rkui-version"];
    }

    if (request.headers["x-rkc-version"]) {
      log.rkcVersion = request.headers["x-rkc-version"];
    }

    if (request.info.referrer) {
      log.referrer = request.info.referrer;
    }

    if (request.headers["host"]) {
      log.hostname = request.headers["host"];
    }

    if (log.route) {
      log.fullUrl = `https://${getSubDomain()}.reservoir.tools${log.route}${
        request.pre.queryString ? `?${request.pre.queryString}` : ""
      }`;
    }

    // Add key information if it exists
    if (key) {
      try {
        const apiKey = await ApiKeyManager.getApiKey(key);

        // There is a key, set that key information
        if (apiKey) {
          log.apiKey = apiKey;
        } else {
          // There is a key, but it's null
          log.apiKey = {};
          log.apiKey.appName = key;
        }

        log.debugApiKey = config.debugApiKeys.includes(key);
      } catch (e: any) {
        logger.info("api-key", e.message);
      }
    } else {
      // No key, just log No Key as the app name
      log.apiKey = {};
      log.apiKey.appName = "No Key";
    }

    return log;
  }
  public static async logRequest(request: Request) {
    const log: any = await ApiKeyManager.getBaseLog(request);

    logger.info("metrics", JSON.stringify(log));

    // Add request params to Datadog trace
    try {
      const requestParams: any = flat.flatten({ ...log.payload, ...log.query, ...log.params });
      Object.keys(requestParams).forEach(
        (key) => (requestParams[key] = String(requestParams[key]))
      );

      if (requestParams) {
        tracer.scope().active()?.setTag("requestParams", requestParams);
      }
    } catch (error) {
      logger.warn("metrics", "Could not add payload to Datadog trace: " + error);
    }
  }

  public static async logUnexpectedErrorResponse(request: Request, error: Boom) {
    const log: any = await ApiKeyManager.getBaseLog(request);
    log.error = error;
    logger.error("metrics", JSON.stringify(log));
  }

  public static async update(key: string, fields: ApiKeyUpdateParams) {
    let updateString = "updated_at = now(),";
    const updatedFields: string[] = [];
    const replacementValues = {
      key,
    };

    _.forEach(fields, (value, fieldName) => {
      if (!_.isUndefined(value)) {
        updatedFields.push(fieldName);

        if (_.isArray(value)) {
          value.forEach((v, k) => {
            if (fieldName === "origins") {
              const matched = v.match(regex.origin);
              if (matched) {
                value[k] = matched[0];
              }
            }
          });

          updateString += `${_.snakeCase(fieldName)} = '$/${fieldName}:raw/'::jsonb,`;
          (replacementValues as any)[`${fieldName}`] = JSON.stringify(value);
        } else if (_.isObject(value)) {
          updateString += `${_.snakeCase(
            fieldName
          )} = COALESCE(${fieldName}, '{}') || '$/${fieldName}:raw/'::jsonb,`;
          (replacementValues as any)[`${fieldName}`] = JSON.stringify(value);
        } else {
          updateString += `${_.snakeCase(fieldName)} = $/${fieldName}/,`;
          (replacementValues as any)[fieldName] = value;
        }
      }
    });

    updateString = _.trimEnd(updateString, ",");

    const query = `
      WITH old_values AS (
        SELECT *
        FROM api_keys
        WHERE key = $/key/
      )
  
     UPDATE api_keys
     SET ${updateString}
     WHERE key = $/key/
     RETURNING ${updatedFields
       .map((fieldName) => `(SELECT ${fieldName} FROM old_values) AS "old_${fieldName}"`)
       .join(",")}`;

    const oldValues = await idb.manyOrNone(query, replacementValues);

    await ApiKeyManager.deleteCachedApiKey(key); // reload the cache
    await PubSub.publish(Channel.ApiKeyUpdated, JSON.stringify({ key }));

    // Sync to other chains only if created on mainnet
    if (config.chainId === 1) {
      await AllChainsPubSub.publish(
        AllChainsChannel.ApiKeyUpdated,
        JSON.stringify({ key, fields })
      );
    }

    logger.info(
      "api-key",
      `Update key ${key} with ${JSON.stringify(fields)}, oldValues=${JSON.stringify(oldValues)}`
    );
  }

  static async notifyApiKeyCreated(values: ApiKeyRecord) {
    await axios
      .post(
        config.slackApiKeyWebhookUrl,
        JSON.stringify({
          text: "API Key created",
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "API Key created",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `New API Key created on *${getNetworkName()}*`,
              },
            },
            {
              type: "section",
              text: {
                type: "plain_text",
                text: `Key: ${values.key}`,
              },
            },
            {
              type: "section",
              text: {
                type: "plain_text",
                text: `AppName: ${values.appName}`,
              },
            },
            {
              type: "section",
              text: {
                type: "plain_text",
                text: `Website: ${values.website}`,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Email: ${values.email}`,
              },
            },
          ],
        }),
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
      .catch(() => {
        // Skip on any errors
      });
  }
}
