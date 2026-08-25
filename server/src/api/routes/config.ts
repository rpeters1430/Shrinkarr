import type { FastifyInstance } from "fastify";
import { updateConfig } from "../../config/index.js";
import { ConfigSchema, type Config, type Integrations } from "../../config/schema.js";
import { createEmbyClient } from "../../integrations/emby.js";
import { createJellyfinClient } from "../../integrations/jellyfin.js";
import { createPlexClient } from "../../integrations/plex.js";
import { createRadarrClient } from "../../integrations/radarr.js";
import { createSonarrClient } from "../../integrations/sonarr.js";
import { normalizeIntegrationUrl, type MediaServerClient } from "../../integrations/types.js";

const REDACTED = "********";

export function redactConfig(config: Config): Config {
  const clone: Config = JSON.parse(JSON.stringify(config));
  if (clone.apiKey) clone.apiKey = REDACTED;
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
    if (merged.jellyfin.url) merged.jellyfin.url = normalizeIntegrationUrl(merged.jellyfin.url);
    if (merged.jellyfin.apiKey === REDACTED && existing.jellyfin?.apiKey) {
      merged.jellyfin.apiKey = existing.jellyfin.apiKey;
    }
  }
  if (merged.emby) {
    if (merged.emby.url) merged.emby.url = normalizeIntegrationUrl(merged.emby.url);
    if (merged.emby.apiKey === REDACTED && existing.emby?.apiKey) {
      merged.emby.apiKey = existing.emby.apiKey;
    }
  }
  if (merged.plex) {
    if (merged.plex.url) merged.plex.url = normalizeIntegrationUrl(merged.plex.url);
    if (merged.plex.token === REDACTED && existing.plex?.token) {
      merged.plex.token = existing.plex.token;
    }
  }
  if (merged.sonarr) {
    if (merged.sonarr.url) merged.sonarr.url = normalizeIntegrationUrl(merged.sonarr.url);
    if (merged.sonarr.apiKey === REDACTED && existing.sonarr?.apiKey) {
      merged.sonarr.apiKey = existing.sonarr.apiKey;
    }
  }
  if (merged.radarr) {
    if (merged.radarr.url) merged.radarr.url = normalizeIntegrationUrl(merged.radarr.url);
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
      queue: { ...currentConfig.queue, ...(body.queue || {}) },
      watcher: { ...currentConfig.watcher, ...(body.watcher || {}) },
      integrations: mergedIntegrations,
      // The API key is managed by the server (see config/loader.ts) and is never
      // client-editable through this endpoint, regardless of what the body sends.
      apiKey: currentConfig.apiKey,
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

      const cleanUrl = normalizeIntegrationUrl(url);

      try {
        let client: MediaServerClient;
        if (service === "jellyfin") client = createJellyfinClient({ url: cleanUrl, apiKey: keyToUse });
        else if (service === "emby") client = createEmbyClient({ url: cleanUrl, apiKey: keyToUse });
        else if (service === "sonarr") client = createSonarrClient({ url: cleanUrl, apiKey: keyToUse });
        else if (service === "radarr") client = createRadarrClient({ url: cleanUrl, apiKey: keyToUse });
        else if (service === "plex") client = createPlexClient({ url: cleanUrl, token: keyToUse });
        else return reply.code(400).send({ error: `Unknown service "${service}"` });

        if (client.testConnection) {
          const testRes = await client.testConnection();
          if (testRes.ok) {
            return { success: true, message: testRes.message };
          } else {
            return reply.code(400).send({ error: testRes.message });
          }
        }

        return { success: true, message: `Connected to ${service} successfully!` };
      } catch (err) {
        return reply.code(400).send({ error: `Connection failed: ${(err as Error).message}` });
      }
    },
  );
}

