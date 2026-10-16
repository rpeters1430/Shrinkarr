import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  arrWebhookToken,
  findLibraryForPath,
  isValidArrWebhookToken,
  mapArrPath,
  parseArrWebhook,
} from "../../integrations/arrWebhook.js";

const WEBHOOK_PATH = "/api/webhooks/arr";

// Sonarr/Radarr can send the token in the URL, as a header, or as the
// password of their webhook's basic-auth fields.
function tokenFrom(request: FastifyRequest<{ Querystring: { token?: string } }>): string | undefined {
  if (request.query.token) return request.query.token;
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    if (colon !== -1) return decoded.slice(colon + 1);
  }
  return undefined;
}

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Behind the session check, unlike the webhook itself: this hands out the token.
  fastify.get("/api/webhooks/arr/info", async (_request, reply) => {
    const auth = fastify.ctx.config.auth;
    if (!auth) return reply.code(409).send({ error: "Create the admin account first" });
    return { path: `${WEBHOOK_PATH}?token=${arrWebhookToken(auth.sessionSecret)}` };
  });

  fastify.post<{ Querystring: { token?: string } }>(WEBHOOK_PATH, async (request, reply) => {
    const { config, watcher } = fastify.ctx;
    if (!config.auth || !isValidArrWebhookToken(tokenFrom(request), config.auth.sessionSecret)) {
      return reply.code(401).send({ error: "Invalid or missing webhook token" });
    }

    const event = parseArrWebhook(request.body);
    if (event.kind === "test") {
      return { ok: true, message: "Shrinkarr received the test event" };
    }
    if (event.kind === "ignored") {
      return { ok: true, ignored: event.eventType || "unknown event" };
    }
    if (!watcher) {
      return reply.code(503).send({ error: "Library watcher is not running in this process" });
    }

    const matched = new Map<string, string>();
    const unmatched: string[] = [];
    for (const arrPath of event.paths) {
      const localPath = mapArrPath(arrPath, config.webhooks.pathMappings);
      const library = findLibraryForPath(localPath, config.libraries);
      if (library) {
        matched.set(library.id, library.name);
      } else {
        unmatched.push(arrPath);
      }
    }
    for (const libraryId of matched.keys()) {
      watcher.requestLibraryCheck(libraryId);
    }
    // A path with no library is usually a missing path mapping. Logged so it
    // shows up without digging through the arr's webhook history.
    if (matched.size === 0 && unmatched.length > 0) {
      console.warn(
        `[Webhook] ${event.eventType} for ${unmatched.join(", ")} is not inside any library. ` +
          "If Sonarr/Radarr mount your media at a different path, add a webhooks.pathMappings entry.",
      );
    }
    return { ok: true, libraries: [...matched.values()], unmatched };
  });
}
