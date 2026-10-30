import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { readVendorSources, VENDOR_DIR } from "../src/vendor-sources.js";

const ROOT = resolve(import.meta.dirname, "..");
const { sqlTools } = readVendorSources();
const MASTER = "0123456789abcdef0123456789abcdef01234567";

let server: ReturnType<typeof Bun.serve> | undefined;
let vendor: string;

beforeEach(() => {
  vendor = mkdtempSync(join(tmpdir(), "representations-vendor-"));
  for (const file of ["sources.json", "sql_tools.py"]) {
    cpSync(join(VENDOR_DIR, file), join(vendor, file));
  }
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  rmSync(vendor, { recursive: true, force: true });
});

/**
 * Runs the update against a fake GitHub whose master is `MASTER` (or
 * `master`) and whose raw files at that commit are `files`.
 */
async function runUpdate(
  files: Record<string, string>,
  master: string = MASTER,
): Promise<{ exitCode: number; output: string }> {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === `/repos/${sqlTools.repository}/commits/master`) {
        return new Response(master);
      }
      const prefix = `/${sqlTools.repository}/${master}/`;
      const file = path.startsWith(prefix)
        ? files[path.slice(prefix.length)]
        : undefined;
      return file === undefined
        ? new Response("404: Not Found", { status: 404 })
        : new Response(file);
    },
  });
  const url = `http://localhost:${server.port}`;
  const child = Bun.spawn(
    [
      "bun",
      "run",
      resolve(ROOT, "scripts/update-metabase-sources.ts"),
      "--vendor-dir",
      vendor,
      "--base-url",
      url,
      "--api-url",
      url,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: output + errors };
}

const recordedCommit = () =>
  (
    JSON.parse(readFileSync(join(vendor, "sources.json"), "utf8")) as {
      sqlTools: { commit: string };
    }
  ).sqlTools.commit;

describe("update-metabase-sources", () => {
  it("copies master's sql_tools.py, records its commit, and says so", async () => {
    const { exitCode, output } = await runUpdate({
      [sqlTools.path]: "# Metabase's new file\n",
    });
    expect(exitCode).toBe(0);
    expect(readFileSync(join(vendor, "sql_tools.py"), "utf8")).toBe(
      "# Metabase's new file\n",
    );
    expect(recordedCommit()).toBe(MASTER);
    expect(output).toContain(
      `vendor/sql_tools.py: copied Metabase's ${sqlTools.path} at ${MASTER}`,
    );
    expect(output).toContain(
      `vendor/sources.json: sqlTools.commit ${sqlTools.commit} -> ${MASTER}`,
    );
    const sources = readFileSync(join(vendor, "sources.json"), "utf8");
    expect(sources).toBe(
      readFileSync(join(VENDOR_DIR, "sources.json"), "utf8").replace(
        sqlTools.commit,
        MASTER,
      ),
    );
  });

  it("says when the file and the commit are already Metabase's", async () => {
    const { exitCode, output } = await runUpdate(
      {
        [sqlTools.path]: readFileSync(join(VENDOR_DIR, "sql_tools.py"), "utf8"),
      },
      sqlTools.commit,
    );
    expect(exitCode).toBe(0);
    expect(output).toContain("vendor/sql_tools.py: unchanged");
    expect(output).toContain("vendor/sources.json: sqlTools.commit unchanged");
  });

  it("changes nothing when it cannot read Metabase's file", async () => {
    writeFileSync(join(vendor, "sql_tools.py"), "# local\n");
    const { exitCode, output } = await runUpdate({});
    expect(exitCode).toBe(1);
    expect(output).toContain(`${sqlTools.path}: 404`);
    expect(readFileSync(join(vendor, "sql_tools.py"), "utf8")).toBe(
      "# local\n",
    );
    expect(recordedCommit()).toBe(sqlTools.commit);
  });
});
