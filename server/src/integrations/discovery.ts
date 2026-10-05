export interface DiscoveredServer {
  service: "jellyfin" | "emby" | "plex";
  url: string;
  name: string;
  version?: string;
}

interface ProbeTarget {
  serviceHint?: "jellyfin" | "emby" | "plex";
  host: string;
  port: number;
}

export async function discoverLocalMediaServers(
  fetchFn: typeof fetch = fetch,
): Promise<DiscoveredServer[]> {
  const isWindows = process.platform === "win32";

  // Standard hosts to probe: localhost/loopback, host.docker.internal, and standard docker service names
  const hosts = ["127.0.0.1", "localhost"];
  if (!isWindows) {
    hosts.push("host.docker.internal");
  }

  const targets: ProbeTarget[] = [
    // Jellyfin / Emby standard HTTP port
    ...hosts.map((host) => ({ host, port: 8096 })),
    // Plex standard port
    ...hosts.map((host) => ({ host, port: 32400, serviceHint: "plex" as const })),
    // Common Docker container hostnames
    { host: "jellyfin", port: 8096, serviceHint: "jellyfin" as const },
    { host: "emby", port: 8096, serviceHint: "emby" as const },
    { host: "plex", port: 32400, serviceHint: "plex" as const },
  ];

  const results: DiscoveredServer[] = [];
  const seenUrls = new Set<string>();

  const probePromises = targets.map(async (target): Promise<DiscoveredServer | null> => {
    const baseUrl = `http://${target.host}:${target.port}`;

    // If target port is 32400 or hint is plex, try Plex identity first
    if (target.port === 32400 || target.serviceHint === "plex") {
      try {
        const res = await fetchFn(`${baseUrl}/identity`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(900),
        });
        if (res.ok) {
          let version: string | undefined;
          const serverName = "Plex Media Server";
          try {
            if (typeof res.json === "function") {
              try {
                const data = (await res.json()) as {
                  MediaContainer?: { version?: string; machineIdentifier?: string };
                };
                if (data?.MediaContainer) {
                  version = data.MediaContainer.version;
                }
              } catch {
                if (typeof res.text === "function") {
                  const text = await res.text();
                  const match = text.match(/version="([^"]+)"/i);
                  if (match) {
                    version = match[1];
                  }
                }
              }
            } else if (typeof res.text === "function") {
              const text = await res.text();
              const match = text.match(/version="([^"]+)"/i);
              if (match) {
                version = match[1];
              }
            }
          } catch {
            // text or xml response still indicates Plex
          }
          return {
            service: "plex",
            url: baseUrl,
            name: serverName,
            version,
          };
        }
      } catch {
        // Not a reachable Plex server
      }
    }

    // Try Jellyfin / Emby /System/Info/Public
    if (target.port === 8096 || target.serviceHint === "jellyfin" || target.serviceHint === "emby") {
      try {
        const res = await fetchFn(`${baseUrl}/System/Info/Public`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(900),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            ServerName?: string;
            Version?: string;
            ProductName?: string;
            Id?: string;
          };
          const prod = (data.ProductName || "").toLowerCase();
          const srvName = data.ServerName || data.ProductName || "Media Server";
          const version = data.Version;

          let service: "jellyfin" | "emby" = "jellyfin";
          if (prod.includes("emby") || target.serviceHint === "emby" || srvName.toLowerCase().includes("emby")) {
            service = "emby";
          } else if (prod.includes("jellyfin") || target.serviceHint === "jellyfin" || srvName.toLowerCase().includes("jellyfin")) {
            service = "jellyfin";
          }

          return {
            service,
            url: baseUrl,
            name: srvName,
            version,
          };
        }
      } catch {
        // Not a reachable Jellyfin/Emby server
      }
    }

    return null;
  });

  const settled = await Promise.allSettled(probePromises);
  for (const item of settled) {
    if (item.status === "fulfilled" && item.value) {
      const server = item.value;
      const key = `${server.service}:${server.url}`;
      if (!seenUrls.has(key)) {
        seenUrls.add(key);
        results.push(server);
      }
    }
  }

  return results;
}
