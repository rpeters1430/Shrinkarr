import type { Config } from "../config/schema.js";
import type { Job } from "../db/jobsRepo.js";
import { createJellyfinClient } from "../integrations/jellyfin.js";
import { createEmbyClient } from "../integrations/emby.js";
import { createPlexClient } from "../integrations/plex.js";
import { createSonarrClient } from "../integrations/sonarr.js";
import { createRadarrClient } from "../integrations/radarr.js";
import type { MediaServerClient } from "../integrations/types.js";

export async function runPostJobHooks(job: Job, config: Config): Promise<void> {
  if (job.status !== "done") {
    return;
  }

  const clients: { name: string; client: MediaServerClient }[] = [];
  const { integrations } = config;

  if (integrations.jellyfin) clients.push({ name: "jellyfin", client: createJellyfinClient(integrations.jellyfin) });
  if (integrations.emby) clients.push({ name: "emby", client: createEmbyClient(integrations.emby) });
  if (integrations.plex) clients.push({ name: "plex", client: createPlexClient(integrations.plex) });
  if (integrations.sonarr) clients.push({ name: "sonarr", client: createSonarrClient(integrations.sonarr) });
  if (integrations.radarr) clients.push({ name: "radarr", client: createRadarrClient(integrations.radarr) });

  const results = await Promise.allSettled(clients.map(({ client }) => client.notifyLibraryChanged()));

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.warn(`Post-job hook for "${clients[i].name}" failed for job ${job.id}: ${result.reason}`);
    }
  });
}
