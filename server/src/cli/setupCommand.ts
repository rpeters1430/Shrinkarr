import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { getConfig, updateConfig, type Config, type Role } from "../config/index.js";
import { startServer } from "../api/server.js";
import { runStart } from "./startCommand.js";
import { parseWorkerMaps, runRemoteWorker } from "./workerCommand.js";

export type Ask = (question: string) => Promise<string>;

export interface ServerLibrary {
  id: string;
  name: string;
  path: string;
}

export interface SetupDeps {
  ask: Ask;
  log: (line: string) => void;
  fetchLibraries: (serverUrl: string, token: string) => Promise<ServerLibrary[]>;
  isDirectory: (path: string) => boolean;
}

export class SetupRequestError extends Error {
  constructor(message: string, readonly unauthorized = false) {
    super(message);
  }
}

/** Accepts "nas:3000" or "http://nas:3000/" and returns "http://nas:3000". */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function fetchServerLibraries(serverUrl: string, token: string): Promise<ServerLibrary[]> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/remote/libraries`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new SetupRequestError(`Could not reach ${serverUrl}: ${(err as Error).message}`);
  }
  if (response.status === 401) throw new SetupRequestError("The server rejected that token", true);
  // Servers from before this endpoint existed answer 404.
  if (response.status === 404) throw new SetupRequestError(`${serverUrl} is not a Shrinkarr server, or it needs updating`);
  if (!response.ok) throw new SetupRequestError(`The server answered HTTP ${response.status}`);
  return (await response.json()) as ServerLibrary[];
}

async function askChoice(deps: SetupDeps): Promise<Role["mode"]> {
  deps.log("");
  deps.log("How will this machine run Shrinkarr?");
  deps.log("  1) All-in-one: scan, web UI and encoding all on this machine");
  deps.log("  2) Server: scan and web UI here, nodes do the encoding");
  deps.log("  3) Node: encode jobs handed out by a Shrinkarr server");
  for (;;) {
    const answer = (await deps.ask("Choose 1-3 [1]: ")).trim();
    if (answer === "" || answer === "1") return "all-in-one";
    if (answer === "2") return "server";
    if (answer === "3") return "node";
    deps.log("Type 1, 2 or 3.");
  }
}

async function askNode(deps: SetupDeps): Promise<NonNullable<Role["node"]>> {
  for (;;) {
    let serverUrl: string | null = null;
    while (!serverUrl) {
      serverUrl = normalizeServerUrl(await deps.ask("Server address (e.g. 192.168.1.50:3000): "));
      if (!serverUrl) deps.log("That isn't a valid address.");
    }
    deps.log("Create a token on the server under Settings > Remote Workers.");
    let libraries: ServerLibrary[] | null = null;
    let token = "";
    while (!libraries) {
      token = (await deps.ask("Worker token: ")).trim();
      if (!token) continue;
      try {
        libraries = await deps.fetchLibraries(serverUrl, token);
      } catch (err) {
        deps.log((err as Error).message);
        // A bad token is worth retyping; anything else means the address is wrong.
        if (!(err instanceof SetupRequestError && err.unauthorized)) break;
      }
    }
    if (!libraries) continue;
    if (libraries.length === 0) {
      deps.log("The server has no libraries yet. Add them in its web UI, then run setup again.");
      throw new Error("No libraries on the server");
    }

    deps.log("");
    deps.log("Where does this machine see each library? Use a mapped drive or UNC path, e.g. Z:\\TV or \\\\nas\\media\\TV.");
    const mapped: Record<string, string> = {};
    for (const library of libraries) {
      deps.log(`${library.name} (on the server: ${library.path})`);
      for (;;) {
        const answer = (await deps.ask("  Path here, or blank to skip: ")).trim().replace(/^"(.*)"$/, "$1");
        if (!answer) break;
        if (!isAbsolute(answer)) {
          deps.log("  Use a full path.");
          continue;
        }
        if (!deps.isDirectory(answer)) {
          deps.log("  That folder doesn't exist from here.");
          continue;
        }
        mapped[library.id] = answer;
        break;
      }
    }
    if (Object.keys(mapped).length === 0) {
      deps.log("Map at least one library, or this node has nothing it can encode.");
      continue;
    }
    return { serverUrl, token, libraries: mapped };
  }
}

export async function promptForRole(deps: SetupDeps, config: Config): Promise<Role> {
  const mode = await askChoice(deps);
  if (mode === "node") return { mode, node: await askNode(deps) };
  if (mode === "server") {
    deps.log("Create a token for each node under Settings > Remote Workers, then pick Node when setting up that machine.");
    if (config.queue.tempDirectory?.trim()) {
      deps.log("Note: queue.tempDirectory is set, and the server hands out no jobs to nodes while it is.");
    }
  }
  return { mode };
}

function openBrowser(url: string): void {
  const [command, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // The URL is printed either way.
  }
}

/**
 * The default command: runs this machine's saved role, asking for one on
 * first run or with --setup. Without a terminal to ask in, it starts
 * all-in-one, as `start` does.
 */
export async function runLaunch(options: { port: number; setup?: boolean; open?: boolean }): Promise<void> {
  const config = getConfig();
  let role = config.role;
  if (!role || options.setup) {
    if (!process.stdin.isTTY) {
      if (options.setup) {
        console.error("[shrinkarr] --setup needs an interactive terminal");
        process.exitCode = 1;
        return;
      }
      console.log("[shrinkarr] No role chosen yet; starting all-in-one. Run with --setup in a terminal to pick one.");
      role = { mode: "all-in-one" };
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        role = await promptForRole({
          ask: (question) => rl.question(question),
          log: (line) => console.log(line),
          fetchLibraries: fetchServerLibraries,
          isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
        }, config);
      } finally {
        rl.close();
      }
      updateConfig({ ...config, role });
      console.log(`Saved. This machine starts as ${role.mode} from now on; run with --setup to change it.\n`);
    }
  }

  if (role.mode === "node" && role.node) {
    console.log(`[shrinkarr] Starting as a node for ${role.node.serverUrl}`);
    const maps = parseWorkerMaps(Object.entries(role.node.libraries).map(([id, path]) => `${id}=${path}`));
    await runRemoteWorker({ coordinator: role.node.serverUrl, token: role.node.token, maps });
    return;
  }
  if (role.mode === "server") {
    console.log("[shrinkarr] Starting as a server; nodes do the encoding");
    await startServer(options.port);
  } else {
    await runStart(options.port);
  }
  if (options.open) openBrowser(`http://localhost:${options.port}`);
}
