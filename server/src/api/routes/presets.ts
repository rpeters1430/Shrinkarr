import type { FastifyInstance } from "fastify";
import { updateConfig } from "../../config/index.js";
import { PresetSchema, type Preset } from "../../config/schema.js";

export async function presetRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/presets", async () => {
    return fastify.ctx.config.presets;
  });

  fastify.post<{ Body: unknown }>("/api/presets", async (request, reply) => {
    const parseResult = PresetSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: parseResult.error.format() });
    }

    const newPreset = parseResult.data;
    const existing = fastify.ctx.config.presets.find((p) => p.id === newPreset.id);
    if (existing) {
      return reply.code(409).send({ error: `Preset with ID "${newPreset.id}" already exists` });
    }

    const updatedPresets = [...fastify.ctx.config.presets, newPreset];
    const newConfig = { ...fastify.ctx.config, presets: updatedPresets };
    updateConfig(newConfig);
    fastify.ctx.config = newConfig;

    return reply.code(201).send(newPreset);
  });

  fastify.put<{ Params: { id: string }; Body: Partial<Preset> }>("/api/presets/:id", async (request, reply) => {
    const { id } = request.params;
    const index = fastify.ctx.config.presets.findIndex((p) => p.id === id);
    if (index === -1) {
      return reply.code(404).send({ error: `Preset "${id}" not found` });
    }

    const current = fastify.ctx.config.presets[index];
    const updated = { ...current, ...(request.body || {}), id };
    const parseResult = PresetSchema.safeParse(updated);
    if (!parseResult.success) {
      return reply.code(400).send({ error: parseResult.error.format() });
    }

    const updatedPresets = [...fastify.ctx.config.presets];
    updatedPresets[index] = parseResult.data;
    const newConfig = { ...fastify.ctx.config, presets: updatedPresets };
    updateConfig(newConfig);
    fastify.ctx.config = newConfig;

    return reply.send(parseResult.data);
  });

  fastify.post("/api/presets/restore-defaults", async () => {
    const { DEFAULT_PRESETS } = await import("../../config/schema.js");
    const existingMap = new Map(fastify.ctx.config.presets.map((p) => [p.id, p]));
    // Merge all default presets, keeping any custom user presets with different IDs
    const merged = [...DEFAULT_PRESETS];
    for (const p of fastify.ctx.config.presets) {
      if (!merged.some((m) => m.id === p.id)) {
        merged.push(p);
      }
    }
    const newConfig = { ...fastify.ctx.config, presets: merged };
    updateConfig(newConfig);
    fastify.ctx.config = newConfig;
    return fastify.ctx.config.presets;
  });

  fastify.delete<{ Params: { id: string } }>("/api/presets/:id", async (request, reply) => {
    const { id } = request.params;
    const filtered = fastify.ctx.config.presets.filter((p) => p.id !== id);
    if (filtered.length === fastify.ctx.config.presets.length) {
      return reply.code(404).send({ error: `Preset "${id}" not found` });
    }

    const newConfig = { ...fastify.ctx.config, presets: filtered };
    updateConfig(newConfig);
    fastify.ctx.config = newConfig;

    return reply.send({ success: true, id });
  });
}
