import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "path";

const SCRIPT = resolve(import.meta.dirname, "wait-for-import.sh");

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/**
 * Runs wait-for-import.sh for task 7 against a fake Metabase whose
 * current-task endpoint answers each of `answers` in turn, then the last one
 * again.
 */
async function waitFor(
  answers: readonly unknown[],
): Promise<{ exitCode: number; output: string; keys: string[] }> {
  let call = 0;
  const keys: string[] = [];
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      keys.push(request.headers.get("X-API-Key") ?? "");
      if (
        new URL(request.url).pathname !== "/api/ee/remote-sync/current-task"
      ) {
        return new Response("Not found.", { status: 404 });
      }
      const answer = answers[Math.min(call, answers.length - 1)];
      call++;
      return Response.json(answer);
    },
  });
  const child = Bun.spawn(["bash", SCRIPT, "7"], {
    env: {
      ...process.env,
      MB_URL: `http://localhost:${server.port}`,
      API_KEY: "key",
      POLL_SECONDS: "0",
      TIMEOUT_SECONDS: "2",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: stdout + stderr, keys };
}

const task = (id: number, status: string) => ({
  id,
  sync_task_type: "import",
  status,
});

describe("wait-for-import.sh", () => {
  it("waits while the task runs, and passes when it succeeds", async () => {
    const { exitCode, output, keys } = await waitFor([
      task(7, "running"),
      task(7, "running"),
      task(7, "successful"),
    ]);
    expect(output).toBe("Import 7 succeeded\n");
    expect(exitCode).toBe(0);
    expect(keys.length).toBe(3);
    expect(keys.every((k) => k === "key")).toBe(true);
  });

  it("waits through an earlier task and no task at all", async () => {
    const { exitCode, output, keys } = await waitFor([
      task(6, "errored"),
      null,
      task(7, "successful"),
    ]);
    expect(output).toBe("Import 7 succeeded\n");
    expect(exitCode).toBe(0);
    expect(keys.length).toBe(3);
  });

  it("fails, printing the task, when the import ends otherwise", async () => {
    const errored = { ...task(7, "errored"), error_message: "Import failed" };
    const { exitCode, output } = await waitFor([errored]);
    expect(output).toBe(
      `${JSON.stringify(errored)}\nImport 7 ended with status errored\n`,
    );
    expect(exitCode).toBe(1);
  });

  it("fails, printing the last answer, when the task does not end in time", async () => {
    const { exitCode, output } = await waitFor([task(7, "running")]);
    expect(output).toBe(
      `${JSON.stringify(task(7, "running"))}\nImport 7 did not finish in time\n`,
    );
    expect(exitCode).toBe(1);
  }, 10_000);
});
