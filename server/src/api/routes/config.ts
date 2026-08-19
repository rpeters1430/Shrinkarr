import type { FastifyInstance } from "fastify";
import { updateConfig } from "../../config/index.js";
import { ConfigSchema, type Config, type Integrations } from "../../config/schema.js";

const REDACTED = "********";

export function redactConfig(config: Config): Config {
  const clone: Config = JSON.parse(JSON.stringify(config));
  if (clone.integrations.jellyfin?.apiKey) clone.integrations.jellyfin.apiKey = REDACTED;
  if (clone.integrations.emby?.apiKey) clone.integrations.emby.apiKey = REDACTED;
  if (clone.integrations.plex?.token) clone.integrations.plex.token = REDACTED;
  if (clone.integrations.sonarr?.apiKey) clone.integrations.sonarr.apiKey = REDACTED;
  if (clone.integrations.radarr?.apiKey) clone.integrations.radarr.apiKey = REDACTED;
  return clone;
}

export function mergeIntegrationsWithSecrets(
  incoming: Integrations,
  existing: Integrations,
): Integrations {
  const merged: Integrations = JSON.parse(JSON.stringify(incoming ?? {}));

  if (merged.jellyfin) {
    if (merged.jellyfin.apiKey === REDACTED && existing.jellyfin?.apiKey) {
      merged.jellyfin.apiKey = existing.jellyfin.apiKey;
    }
  }
  if (merged.emby) {
    if (merged.emby.apiKey === REDACTED && existing.emby?.apiKey) {
      merged.emby.apiKey = existing.emby.apiKey;
    }
  }
  if (merged.plex) {
    if (merged.plex.token === REDACTED && existing.plex?.token) {
      merged.plex.token = existing.plex.token;
    }
  }
  if (merged.sonarr) {
    if (merged.sonarr.apiKey === REDACTED && existing.sonarr?.apiKey) {
      merged.sonarr.apiKey = existing.sonarr.apiKey;
    }
  }
  if (merged.radarr) {
    if (merged.radarr.apiKey === REDACTED && existing.radarr?.apiKey) {
      merged.radarr.apiKey = existing.radarr.apiKey;
    }
  }

  return merged;
}

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/config", async () => {
    return redactConfig(fastify.ctx.config);
  });

  fastify.put<{ Body: Partial<Config> }>("/api/config", async (request, reply) => {
    const currentConfig = fastify.ctx.config;
    const body = request.body || {};

    const mergedIntegrations = mergeIntegrationsWithSecrets(
      body.integrations || {},
      currentConfig.integrations || {},
    );

    const merged = {
      ...currentConfig,
      ...body,
      integrations: mergedIntegrations,
    };

    const result = ConfigSchema.safeParse(merged);
    if (!result.success) {
      return reply.code(400).send({ error: result.error.format() });
    }

    updateConfig(result.data);
    fastify.ctx.config = result.data;

    return redactConfig(fastify.ctx.config);
  });

  fastify.post<{ Body: { service: "jellyfin" | "emby" | "plex" | "sonarr" | "radarr"; url: string; tokenOrKey: string } }>(
    "/api/integrations/test",
    async (request, reply) => {
      const { service, url, tokenOrKey } = request.body || {};
      if (!service || !url || !tokenOrKey) {
        return reply.code(400).send({ error: "service, url, and tokenOrKey are required" });
      }

      const keyToUse = tokenOrKey === REDACTED
        ? (service === "plex"
            ? fastify.ctx.config.integrations.plex?.token
            : (fastify.ctx.config.integrations as Record<string, { apiKey?: string }>)[service]?.apiKey)
        : tokenOrKey;

      if (!keyToUse) {
        return reply.code(400).send({ error: "No API key or token found" });
      }

      try {
        let testUrl = "";
        let headers: Record<string, string> = {};

        if (service === "jellyfin" || service === "emby") {
          testUrl = `${url.replace(/\/$/, "")}/System/Info`;
          headers = { "X-Emby-Token": keyToUse };
        } else if (service === "plex") {
          testUrl = `${url.replace(/\/$/, "")}/identity`;
          headers = { "X-Plex-Token": keyToUse };
        } else if (service === "sonarr" || service === "radarr") {
          testUrl = `${url.replace(/\/$/, "")}/api/v3/system/status`;
          headers = { "X-Api-Key": keyToUse };
        }

        const res = await fetch(testUrl, { headers, signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          return { success: true, message: `Successfully connected to ${service}!` };
        } else {
          return reply.code(res.status).send({ error: `${service} returned HTTP ${res.status}: ${res.statusText}` });
        }
      } catch (err) {
        return reply.code(500).send({ error: `Connection failed: ${(err as Error).message}` });
      }
    },
  );
}
