import type { FastifyInstance } from "fastify";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { serializeCookie } from "../../auth/cookies.js";
import { createSessionToken, generateSessionSecret, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "../../auth/session.js";
import { saveConfigFile } from "../../config/index.js";

const MIN_PASSWORD_LENGTH = 8;

function setSessionCookie(reply: { header: (name: string, value: string) => void }, request: { protocol: string }, token: string): void {
  reply.header(
    "set-cookie",
    serializeCookie(SESSION_COOKIE_NAME, token, { maxAge: SESSION_TTL_SECONDS, secure: request.protocol === "https" }),
  );
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/auth/status", async () => {
    return { needsSetup: !fastify.ctx.config.auth };
  });

  fastify.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/setup",
    async (request, reply) => {
      if (fastify.ctx.config.auth) {
        return reply.code(409).send({ error: "An account already exists" });
      }
      const { username, password } = request.body || {};
      const trimmedUsername = username?.trim();
      if (!trimmedUsername || !password) {
        return reply.code(400).send({ error: "Username and password are required" });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const auth = {
        username: trimmedUsername,
        passwordHash: hashPassword(password),
        sessionSecret: generateSessionSecret(),
      };
      const updatedConfig = { ...fastify.ctx.config, auth };
      saveConfigFile(fastify.ctx.configPath, updatedConfig);
      fastify.ctx.config = updatedConfig;

      const token = createSessionToken(auth.username, auth.sessionSecret);
      setSessionCookie(reply, request, token);
      return { username: auth.username };
    },
  );

  fastify.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    async (request, reply) => {
      const { username, password } = request.body || {};
      const auth = fastify.ctx.config.auth;
      if (!username || !password || !auth || username !== auth.username || !verifyPassword(password, auth.passwordHash)) {
        return reply.code(401).send({ error: "Invalid username or password" });
      }

      const token = createSessionToken(auth.username, auth.sessionSecret);
      setSessionCookie(reply, request, token);
      return { username: auth.username };
    },
  );

  fastify.post("/api/auth/logout", async (request, reply) => {
    reply.header(
      "set-cookie",
      serializeCookie(SESSION_COOKIE_NAME, "", { maxAge: 0, secure: request.protocol === "https" }),
    );
    return { success: true };
  });

  fastify.get("/api/auth/me", async () => {
    return { username: fastify.ctx.config.auth?.username };
  });

  fastify.put<{ Body: { currentPassword?: string; newUsername?: string; newPassword?: string } }>(
    "/api/auth/account",
    async (request, reply) => {
      const { currentPassword, newUsername, newPassword } = request.body || {};
      const auth = fastify.ctx.config.auth;
      if (!auth || !currentPassword || !verifyPassword(currentPassword, auth.passwordHash)) {
        return reply.code(401).send({ error: "Current password is incorrect" });
      }
      const trimmedUsername = newUsername?.trim();
      if (!trimmedUsername && !newPassword) {
        return reply.code(400).send({ error: "Provide a new username or password" });
      }
      if (newPassword && newPassword.length < MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      // Rotating the session secret invalidates every previously issued cookie
      // (including a stolen one) as soon as the account changes.
      const updatedAuth = {
        username: trimmedUsername || auth.username,
        passwordHash: newPassword ? hashPassword(newPassword) : auth.passwordHash,
        sessionSecret: generateSessionSecret(),
      };
      const updatedConfig = { ...fastify.ctx.config, auth: updatedAuth };
      saveConfigFile(fastify.ctx.configPath, updatedConfig);
      fastify.ctx.config = updatedConfig;

      const token = createSessionToken(updatedAuth.username, updatedAuth.sessionSecret);
      setSessionCookie(reply, request, token);
      return { username: updatedAuth.username };
    },
  );
}
