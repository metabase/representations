import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import yaml from "js-yaml";
import { join, resolve } from "path";

import { isRecord } from "./values.js";

const WORKFLOWS = resolve(import.meta.dirname, "..", ".github", "workflows");

type RunStep = { workflow: string; job: string; step: string; run: string };

/** Every job of every workflow, with its steps. */
function workflowJobs(): { workflow: string; job: string; steps: unknown[] }[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith(".yml"))
    .sort()
    .flatMap((workflow) => {
      const doc: unknown = yaml.load(
        readFileSync(join(WORKFLOWS, workflow), "utf8"),
      );
      const jobs = isRecord(doc) && isRecord(doc.jobs) ? doc.jobs : {};
      return Object.entries(jobs).map(([job, body]) => {
        const steps: unknown[] =
          isRecord(body) && Array.isArray(body.steps) ? body.steps : [];
        return { workflow, job, steps };
      });
    });
}

/** Every `run` script of every workflow, with where it sits. */
function runSteps(): RunStep[] {
  return workflowJobs().flatMap(({ workflow, job, steps }) =>
    steps.flatMap((step, i) =>
      isRecord(step) && typeof step.run === "string"
        ? [
            {
              workflow,
              job,
              step: typeof step.name === "string" ? step.name : `#${i}`,
              run: step.run,
            },
          ]
        : [],
    ),
  );
}

type ActionStep = {
  workflow: string;
  job: string;
  inputs: Record<string, unknown>;
};

/** Every step of every workflow that uses `action`, with its `with` inputs. */
function actionSteps(action: string): ActionStep[] {
  return workflowJobs().flatMap(({ workflow, job, steps }) =>
    steps.flatMap((step) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith(`${action}@`)
        ? [{ workflow, job, inputs: isRecord(step.with) ? step.with : {} }]
        : [],
    ),
  );
}

const where = ({ workflow, job, step }: RunStep) =>
  `${workflow} ${job}: ${step}`;

describe("workflows", () => {
  const steps = runSteps();

  it("have run scripts to check", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  // GitHub pastes an expression's value into the script before the shell
  // reads it, so a branch name such as `a$(curl …)` runs as code. A value
  // passed through `env:` reaches the shell as a variable and is never parsed.
  it("pass no expression into a run script", () => {
    expect(steps.filter((s) => s.run.includes("${{")).map(where)).toEqual([]);
  });

  // Lifecycle scripts in the checked-out package.json would run with the
  // publish token in the environment.
  it("publish to npm without running lifecycle scripts", () => {
    const publishes = steps.filter((s) => /\bnpm publish\b/.test(s.run));
    expect(publishes.length).toBeGreaterThan(0);
    expect(
      publishes.filter((s) => !s.run.includes("--ignore-scripts")).map(where),
    ).toEqual([]);
  });

  // A checkout leaves the job's GitHub token in .git/config, where the build
  // scripts of the checked-out code could read it.
  it("check out without keeping credentials in a job that publishes", () => {
    const publishingJobs = new Set(
      steps
        .filter((s) => /\bnpm publish\b/.test(s.run))
        .map((s) => `${s.workflow} ${s.job}`),
    );
    expect(publishingJobs.size).toBeGreaterThan(0);
    const keeping = actionSteps("actions/checkout")
      .filter((c) => publishingJobs.has(`${c.workflow} ${c.job}`))
      .filter((c) => c.inputs["persist-credentials"] !== false)
      .map((c) => `${c.workflow} ${c.job}`);
    expect(keeping).toEqual([]);
  });

  it("compute the alpha version with the tested script", () => {
    expect(
      steps
        .filter((s) => s.run.includes("scripts/alpha-version.sh"))
        .map(where),
    ).toEqual([
      "release-alpha.yml publish-alpha: Compute alpha version and dist-tag",
    ]);
  });

  // With `latest`, a new Bun release can change a build or a test result with
  // no change in the repository.
  it("set up one exact Bun version everywhere", () => {
    const versions = actionSteps("oven-sh/setup-bun").map(
      (s) => s.inputs["bun-version"],
    );
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.filter((v) => !/^\d+\.\d+\.\d+$/.test(String(v)))).toEqual(
      [],
    );
    expect(new Set(versions).size).toBe(1);
  });

  // Without it, bun install rewrites bun.lock when package.json disagrees with
  // it, instead of failing.
  it("install dependencies from bun.lock as it is", () => {
    const installs = steps.filter((s) => /\bbun install\b/.test(s.run));
    expect(installs.length).toBeGreaterThan(0);
    expect(
      installs.filter((s) => !s.run.includes("--frozen-lockfile")).map(where),
    ).toEqual([]);
  });
});
