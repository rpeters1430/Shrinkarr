import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import type { FastifyInstance } from "fastify";
import { ConfigSchema, type Config } from "../../config/schema.js";
import { resetConfigCache } from "../../config/index.js";

const REDACTED = "********";

function redactConfig(config: Config): Config {
  const clone: Config = JSON.parse(JSON.stringify(config));
  if (clone.integrations.jellyfin) clone.integrations.jellyfin.apiKey = REDACTED;
  if (clone.integrations.emby) clone.integrations.emby.apiKey = REDACTED;
  if (clone.integrations.plex) clone.integrations.plex.token = REDACTED;
  if (clone.integrations.sonarr) clone.integrations.sonarr.apiKey = REDACTED;
  if (clone.integrations.radarr) clone.integrations.radarr.apiKey = REDACTED;
  return clone;
}

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/config", async () => {
    return redactConfig(fastify.ctx.config);
  });

  fastify.put<{ Body: unknown }>("/api/config", async (request, reply) => {
    const result = ConfigSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ error: result.error.format() });
    }

    writeFileSync(fastify.ctx.configPath, stringify(result.data), "utf-8");
    resetConfigCache();
    fastify.ctx.config = result.data;

    return redactConfig(fastify.ctx.config);
  });
}
