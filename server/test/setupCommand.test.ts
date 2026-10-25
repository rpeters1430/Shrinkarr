import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";
import { normalizeServerUrl, promptForRole, SetupRequestError, type ServerLibrary, type SetupDeps } from "../src/cli/setupCommand.js";

const LIBRARIES: ServerLibrary[] = [
  { id: "tv", name: "TV Shows", path: "/volume1/Media/TV Shows" },
  { id: "movies", name: "Movies", path: "/volume1/Media/Movies" },
];

const abs = (path: string) => (process.platform === "win32" ? `Z:\\${path}` : `/mnt/${path}`);

function scripted(answers: string[], overrides: Partial<SetupDeps> = {}): SetupDeps & { output: string[]; asked: string[] } {
  const output: string[] = [];
  const asked: string[] = [];
  return {
    output,
    asked,
    ask: async (question) => {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`Ran out of answers at "${question}"`);
      return answer;
    },
    log: (line) => output.push(line),
    fetchLibraries: async () => LIBRARIES,
    isDirectory: () => true,
    ...overrides,
  };
}

describe("normalizeServerUrl", () => {
  it("adds a scheme and drops trailing slashes", () => {
    expect(normalizeServerUrl("192.168.1.50:3000")).toBe("http://192.168.1.50:3000");
    expect(normalizeServerUrl("https://nas.local:3000/")).toBe("https://nas.local:3000");
    expect(normalizeServerUrl("  ")).toBeNull();
    expect(normalizeServerUrl("http://")).toBeNull();
  });
});

describe("promptForRole", () => {
  it("defaults to all-in-one on Enter", async () => {
    expect(await promptForRole(scripted([""]), getDefaultConfig())).toEqual({ mode: "all-in-one" });
  });

  it("re-asks on an invalid choice and picks server", async () => {
    const deps = scripted(["4", "2"]);
    expect(await promptForRole(deps, getDefaultConfig())).toEqual({ mode: "server" });
    expect(deps.output).toContain("Type 1, 2 or 3.");
  });

  it("sets up a node, mapping only the libraries given a path", async () => {
    const deps = scripted(["3", "nas:3000", "tok", abs("TV"), ""]);
    const role = await promptForRole(deps, getDefaultConfig());
    expect(role).toEqual({ mode: "node", node: { serverUrl: "http://nas:3000", token: "tok", libraries: { tv: abs("TV") } } });
    expect(ConfigSchema.safeParse({ ...getDefaultConfig(), role }).success).toBe(true);
  });

  it("asks for the token again when the server rejects it", async () => {
    let calls = 0;
    const deps = scripted(["3", "nas:3000", "bad", "good", abs("TV"), abs("Movies")], {
      fetchLibraries: async (_url, token) => {
        calls++;
        if (token === "bad") throw new SetupRequestError("The server rejected that token", true);
        return LIBRARIES;
      },
    });
    const role = await promptForRole(deps, getDefaultConfig());
    expect(calls).toBe(2);
    expect(role.node?.token).toBe("good");
    expect(Object.keys(role.node!.libraries)).toEqual(["tv", "movies"]);
  });

  it("asks for the address again when the server can't be reached", async () => {
    const deps = scripted(["3", "wrong:3000", "tok", "nas:3000", "tok", abs("TV"), ""], {
      fetchLibraries: async (url) => {
        if (url.includes("wrong")) throw new SetupRequestError("Could not reach http://wrong:3000");
        return LIBRARIES;
      },
    });
    const role = await promptForRole(deps, getDefaultConfig());
    expect(role.node?.serverUrl).toBe("http://nas:3000");
  });

  it("rejects relative and missing folders", async () => {
    const deps = scripted(["3", "nas:3000", "tok", "TV", abs("Nope"), abs("TV"), ""], {
      isDirectory: (path) => !path.includes("Nope"),
    });
    const role = await promptForRole(deps, getDefaultConfig());
    expect(role.node?.libraries).toEqual({ tv: abs("TV") });
    expect(deps.output).toContain("  Use a full path.");
    expect(deps.output).toContain("  That folder doesn't exist from here.");
  });

  it("warns a server that nodes get no jobs while tempDirectory is set", async () => {
    const config = getDefaultConfig();
    config.queue.tempDirectory = "D:\\cache";
    const deps = scripted(["2"]);
    await promptForRole(deps, config);
    expect(deps.output.some((line) => line.includes("tempDirectory"))).toBe(true);
  });
});

describe("role schema", () => {
  it("requires node settings for a node", () => {
    expect(ConfigSchema.safeParse({ ...getDefaultConfig(), role: { mode: "node" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...getDefaultConfig(), role: { mode: "server" } }).success).toBe(true);
  });
});
