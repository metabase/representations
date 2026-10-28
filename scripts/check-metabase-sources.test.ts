import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

import { readVendorSources, VENDOR_DIR } from "../src/vendor-sources.js";

const ROOT = resolve(import.meta.dirname, "..");
const SQL_TOOLS = readFileSync(resolve(VENDOR_DIR, "sql_tools.py"));
const { sqlTools, sqlglot } = readVendorSources();

const pyproject = (pin: string) =>
  `[project]\ndependencies = [\n    "sqlglot==${pin}",\n]\n`;

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** Runs the check against a fake raw.githubusercontent.com serving `files` at master. */
async function runCheck(
  files: Record<string, Uint8Array | string>,
): Promise<{ exitCode: number; output: string }> {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      const prefix = `/${sqlTools.repository}/master/`;
      const file = path.startsWith(prefix)
        ? files[path.slice(prefix.length)]
        : undefined;
      return file === undefined
        ? new Response("404: Not Found", { status: 404 })
        : new Response(file);
    },
  });
  const child = Bun.spawn(
    [
      "bun",
      "run",
      resolve(ROOT, "scripts/check-metabase-sources.ts"),
      "--base-url",
      `http://localhost:${server.port}`,
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

describe("check-metabase-sources", () => {
  it("passes when sql_tools.py and the SQLGlot pin equal Metabase's", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject(sqlglot.version),
    });
    expect(output).not.toContain("FAIL");
    expect(exitCode).toBe(0);
  });

  it("fails when sql_tools.py differs from Metabase's by one byte", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: new Uint8Array([...SQL_TOOLS, 0x0a]),
      [sqlglot.pin]: pyproject(sqlglot.version),
    });
    expect(output).toContain(
      "FAIL  vendor/sql_tools.py differs from Metabase's",
    );
    expect(exitCode).toBe(1);
  });

  it("fails when Metabase pins another SQLGlot", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject("99.0.0"),
    });
    expect(output).toContain(
      `FAIL  Metabase pins sqlglot 99.0.0; vendor/ holds ${sqlglot.version}`,
    );
    expect(exitCode).toBe(1);
  });

  it("fails when it cannot read Metabase's files", async () => {
    const { exitCode, output } = await runCheck({
      [sqlglot.pin]: "[project]\n",
    });
    expect(output).toContain(`FAIL  ${sqlTools.path}: 404`);
    expect(output).toContain(`FAIL  ${sqlglot.pin} pins no sqlglot`);
    expect(exitCode).toBe(1);
  });
});
