import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Defaults to the main build output; the benchmark build passes its own target.
const outDir = process.argv[2] ?? "dist/db";

mkdirSync(outDir, { recursive: true });
copyFileSync("src/db/schema.sql", join(outDir, "schema.sql"));
