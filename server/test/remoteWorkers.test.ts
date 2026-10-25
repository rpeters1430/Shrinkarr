import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { RemoteWorkersRepo } from "../src/db/remoteWorkersRepo.js";
import { remoteWorkerRoutes } from "../src/api/routes/remoteWorkers.js";
import { parseWorkerMaps, resolveWorkerPath } from "../src/cli/workerCommand.js";

let db: ReturnType<typeof openDb>;
let repo: RemoteWorkersRepo;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  db = openDb(":memory:");
  repo = new RemoteWorkersRepo(db);
  app = Fastify();
  app.decorate("ctx", { remoteWorkersRepo: repo });
  await app.register(remoteWorkerRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe("remote worker registry", () => {
  it("returns a token once and omits it from worker listings", async () => {
    const created = await app.inject({ method: "POST", url: "/api/remote-workers", payload: { name: "GPU worker" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().token).toMatch(/^[\w-]{40,}$/);
    expect(repo.authenticate(created.json().token)?.id).toBe(created.json().worker.id);

    const listed = await app.inject({ method: "GET", url: "/api/remote-workers" });
    expect(listed.json()[0]).toMatchObject({ id: created.json().worker.id, name: "GPU worker", status: "offline" });
    expect(listed.json()[0]).not.toHaveProperty("token");
    expect(listed.json()[0]).not.toHaveProperty("tokenHash");
  });

  it("validates names and only accepts valid worker tokens for heartbeat", async () => {
    expect((await app.inject({ method: "POST", url: "/api/remote-workers", payload: { name: "  " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/remote/heartbeat", payload: {} })).statusCode).toBe(401);

    const created = repo.create("encoder");
    const response = await app.inject({
      method: "POST",
      url: "/api/remote/heartbeat",
      headers: { authorization: `Bearer ${created.token}` },
      payload: { ffmpegAvailable: true, ffmpegVersion: "7.1", mediaKinds: ["video", "audio"], libraryIds: ["movies"], encoders: ["libx265"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ workerId: created.worker.id, heartbeatIntervalSeconds: 15 });
    expect(repo.get(created.worker.id)).toMatchObject({
      status: "online",
      capabilities: { ffmpegAvailable: true, mediaKinds: ["video", "audio"], libraryIds: ["movies"] },
    });
  });

  it("revokes a worker token and rejects malformed capability reports", async () => {
    const created = repo.create("encoder");
    const malformed = await app.inject({
      method: "POST",
      url: "/api/remote/heartbeat",
      headers: { authorization: `Bearer ${created.token}` },
      payload: { ffmpegAvailable: true, mediaKinds: ["gpu"], libraryIds: [] },
    });
    expect(malformed.statusCode).toBe(400);

    const revoked = await app.inject({ method: "DELETE", url: `/api/remote-workers/${created.worker.id}` });
    expect(revoked.json()).toEqual({ revoked: true });
    expect(repo.authenticate(created.token)).toBeUndefined();
  });
});

describe("remote library listing", () => {
  it("lists the server's libraries only for a valid worker token", async () => {
    const libraries = [{ id: "tv", name: "TV Shows", path: "/volume1/Media/TV Shows", mediaType: "tv", presetId: "p" }];
    const listApp = Fastify();
    listApp.decorate("ctx", { remoteWorkersRepo: repo, config: { libraries } });
    await listApp.register(remoteWorkerRoutes);
    await listApp.ready();
    const { token } = repo.create("PC");

    expect((await listApp.inject({ method: "GET", url: "/api/remote/libraries" })).statusCode).toBe(401);
    const listed = await listApp.inject({ method: "GET", url: "/api/remote/libraries", headers: { authorization: `Bearer ${token}` } });
    expect(listed.json()).toEqual([{ id: "tv", name: "TV Shows", path: "/volume1/Media/TV Shows" }]);
    await listApp.close();
  });
});

describe("remote worker mount validation", () => {
  it("requires unique worker maps rooted at absolute paths", () => {
    expect(() => parseWorkerMaps(["movies=/srv/movies"])).not.toThrow();
    expect(() => parseWorkerMaps(["movies=relative"])).toThrow(/absolute/);
    expect(() => parseWorkerMaps(["movies=/a", "movies=/b"])).toThrow(/duplicate/);
  });

  it("rejects absolute paths and traversal in coordinator assignments", () => {
    expect(resolveWorkerPath("/srv/media", "Films/Movie.mkv")).toBe("/srv/media/Films/Movie.mkv");
    expect(() => resolveWorkerPath("/srv/media", "../secret")).toThrow(/unsafe/);
    expect(() => resolveWorkerPath("/srv/media", "/etc/passwd")).toThrow(/unsafe/);
  });
});
