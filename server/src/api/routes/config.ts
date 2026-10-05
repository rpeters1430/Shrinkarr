import type { FastifyInstance } from "fastify";
import { applyConfig } from "../applyConfig.js";
import { ConfigSchema, type Config, type Integrations } from "../../config/schema.js";
import { createEmbyClient } from "../../integrations/emby.js";
import { createJellyfinClient } from "../../integrations/jellyfin.js";
import { createPlexClient } from "../../integrations/plex.js";
import { createRadarrClient } from "../../integrations/radarr.js";
import { createSonarrClient } from "../../integrations/sonarr.js";
import { normalizeIntegrationUrl, type MediaServerClient } from "../../integrations/types.js";
import { discoverLocalMediaServers } from "../../integrations/discovery.js";

const REDACTED = "********";

export function redactConfig(config: Config): Config {
  const clone: Config = JSON.parse(JSON.stringify(config));
  if (clone.auth) {
    clone.auth.passwordHash = REDACTED;
    clone.auth.sessionSecret = REDACTED;
  }
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

  const cleanOrMerge = <T extends { url?: string; apiKey?: string; token?: string }>(
    item: T | undefined,
    existingSecret?: string,
    secretField: "apiKey" | "token" = "apiKey",
  ): T | undefined => {
    if (!item) return undefined;
    if (item.url) item.url = normalizeIntegrationUrl(item.url);
    if (item[secretField] === REDACTED && existingSecret) {
      item[secretField] = existingSecret;
    }
    const hasUrl = Boolean(item.url && item.url.trim().length > 0);
    const hasSecret = Boolean(item[secretField] && item[secretField]?.trim().length > 0);
    if (!hasUrl && !hasSecret) {
      return undefined;
    }
    return item;
  };

  merged.jellyfin = cleanOrMerge(merged.jellyfin, existing.jellyfin?.apiKey, "apiKey");
  merged.emby = cleanOrMerge(merged.emby, existing.emby?.apiKey, "apiKey");
  merged.plex = cleanOrMerge(merged.plex, existing.plex?.token, "token");
  merged.sonarr = cleanOrMerge(merged.sonarr, existing.sonarr?.apiKey, "apiKey");
  merged.radarr = cleanOrMerge(merged.radarr, existing.radarr?.apiKey, "apiKey");

  return merged;
}

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/config", async () => {
    return redactConfig(fastify.ctx.config);
  });

  fastify.put<{ Body: Partial<Config> }>("/api/config", async (request, reply) => {
    const currentConfig = fastify.ctx.config;
    const body = request.body || {};

    const mergedIntegrations = body.integrations !== undefined
      ? mergeIntegrationsWithSecrets(
          body.integrations,
          currentConfig.integrations || {},
        )
      : currentConfig.integrations || {};

    const merged = {
      ...currentConfig,
      ...body,
      queue: {
        ...currentConfig.queue,
        ...(body.queue || {}),
        schedule: body.queue?.schedule
          ? {
              ...(currentConfig.queue?.schedule || {}),
              ...body.queue.schedule,
            }
          : currentConfig.queue?.schedule,
      },
      watcher: { ...currentConfig.watcher, ...(body.watcher || {}) },
      scanner: { ...currentConfig.scanner, ...(body.scanner || {}) },
      integrations: mergedIntegrations,
      // Credentials are managed via /api/auth/account and are never
      // client-editable through this endpoint, regardless of what the body sends.
      auth: currentConfig.auth,
    };

    const result = ConfigSchema.safeParse(merged);
    if (!result.success) {
      return reply.code(400).send({ error: result.error.format() });
    }

    applyConfig(fastify.ctx, result.data);

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
        const parsed = new URL(cleanUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return reply.code(400).send({ error: "Only HTTP and HTTPS URLs are allowed" });
        }
        if (!parsed.hostname) {
          return reply.code(400).send({ error: "Invalid URL: hostname is missing" });
        }
      } catch {
        return reply.code(400).send({ error: "Invalid URL format" });
      }

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

  fastify.get("/api/integrations/discover", async () => {
    const servers = await discoverLocalMediaServers();
    return { servers };
  });
}

