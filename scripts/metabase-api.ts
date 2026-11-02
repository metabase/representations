// Calls to Metabase's API, shared by lint-parity.ts and record-corpus.ts.
import { isRecord } from "../src/values.js";
import { describeRefusal, type TestRefusal } from "./parity.js";

/**
 * Metabase's answer: its status, and its body parsed as JSON, or undefined when
 * the body is not JSON. Metabase answers some refusals, such as a 403, in plain
 * text, which `text` keeps.
 */
export type Answer = { status: number; json: unknown; text: string };

/** The answer as a failure message names it: its status and its body. */
export const describe = (answer: Answer) =>
  `${answer.status} ${answer.text.trim() || "(empty body)"}`;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Metabase's answer to creating a transform test. */
export type Probe =
  | { kind: "accepted" }
  /**
   * Refused with a transform-test error code; `tables` when the refusal lists
   * them. Metabase names the query an unremapped-reference refusal is about
   * only in its localized message, so `refusal.onTransform` is false until
   * locateRefusal sets it.
   */
  | { kind: "refused"; refusal: TestRefusal; tables: string[] | null }
  /** Anything else, such as a 403: the probe did not run. */
  | { kind: "failed"; answer: string };

/** An expectation whose SQL reads no table, which no test is refused for. */
export const NO_TABLE_EXPECTATION = {
  type: "empty",
  name: "probe",
  sql: "SELECT 1 WHERE 1 = 0",
};

/** `refusal` with `onTransform` set, or the answer of a locate probe that did not run. */
export type Located =
  | { kind: "located"; refusal: TestRefusal }
  | { kind: "failed"; answer: string };

/** How Metabase's import of a branch ended. */
export type ImportOutcome =
  | { status: "successful" }
  /** `ended` is the task's final status, such as `errored`. */
  | { status: "failed"; ended: string; message: string | null };

/** The calls lint-parity.ts and record-corpus.ts make to the Metabase at `url`. */
export function createMetabase(url: string, apiKey: string) {
  const headers = { "X-API-Key": apiKey, "Content-Type": "application/json" };

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer> {
    const response = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  }

  /** Metabase's answer to deleting a test, or null when it deleted it. */
  async function deleteTest(id: number): Promise<string | null> {
    const answer = await api("DELETE", `/api/ee/transform-test/${id}`);
    return answer.status >= 200 && answer.status < 300
      ? null
      : `DELETE /api/ee/transform-test/${id} answered ${describe(answer)}`;
  }

  async function probe(test: {
    transform_id: number;
    inputs: unknown;
    expectations: unknown;
  }): Promise<Probe> {
    const answer = await api("POST", "/api/ee/transform-test", {
      name: "lint parity probe",
      ...test,
    });
    const json = isRecord(answer.json) ? answer.json : {};
    if (answer.status === 200 && typeof json.id === "number") {
      const refused = await deleteTest(json.id);
      return refused === null
        ? { kind: "accepted" }
        : {
            kind: "failed",
            answer: `200, but the created test was not deleted: ${refused}`,
          };
    }
    const code = json["error-code"] ?? json.error_code;
    if (typeof code === "string" && code.startsWith("transform-test.")) {
      return {
        kind: "refused",
        refusal: {
          code,
          message: typeof json.message === "string" ? json.message : null,
          onTransform: false,
        },
        tables: isStringArray(json.tables) ? json.tables : null,
      };
    }
    return { kind: "failed", answer: describe(answer) };
  }

  /**
   * `refusal` of `test`, located on the transform or on an expectation. Metabase
   * checks the transform's SQL before the expectations', and names the query an
   * unremapped-reference refusal is about only in its localized message. The
   * test with only an expectation that reads no table tells: Metabase refuses it
   * with the same code when the transform's SQL is at fault, and accepts it when
   * an expectation is. Any other answer is a failure.
   */
  async function locateRefusal(
    refusal: TestRefusal,
    test: { transform_id: number; inputs: unknown },
  ): Promise<Located> {
    if (refusal.code !== "transform-test.unremapped-reference") {
      return { kind: "located", refusal };
    }
    const answer = await probe({
      ...test,
      expectations: [NO_TABLE_EXPECTATION],
    });
    if (answer.kind === "accepted") {
      return { kind: "located", refusal };
    }
    if (answer.kind === "refused" && answer.refusal.code === refusal.code) {
      return { kind: "located", refusal: { ...refusal, onTransform: true } };
    }
    return {
      kind: "failed",
      answer:
        answer.kind === "failed"
          ? answer.answer
          : `a refusal with ${describeRefusal(answer.refusal)}`,
    };
  }

  /**
   * Imports `branch` of the git sync repository, replacing what the last
   * import loaded, and waits for the import to end. Metabase loads the whole
   * branch in one transaction, so an import that fails loads nothing, and its
   * message names the first file or entity it could not load.
   */
  async function importBranch(branch: string): Promise<ImportOutcome> {
    const started = await api("POST", "/api/ee/remote-sync/import", {
      branch,
      force: true,
    });
    const taskId = isRecord(started.json) ? started.json.task_id : undefined;
    if (started.status !== 200 || typeof taskId !== "number") {
      throw new Error(
        `POST /api/ee/remote-sync/import answered ${describe(started)}`,
      );
    }
    for (let polls = 0; polls < 600; polls++) {
      const task = await api("GET", "/api/ee/remote-sync/current-task");
      const json = isRecord(task.json) ? task.json : {};
      if (json.id === taskId && json.status !== "running") {
        return json.status === "successful"
          ? { status: "successful" }
          : {
              status: "failed",
              ended: String(json.status),
              message:
                typeof json.error_message === "string"
                  ? json.error_message
                  : null,
            };
      }
      await Bun.sleep(500);
    }
    throw new Error(`Import of ${branch} did not end in 300 seconds`);
  }

  return { api, deleteTest, probe, locateRefusal, importBranch };
}
