import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import yaml from "js-yaml";
import { join, resolve } from "path";

import { isRecord } from "./values.js";

const WORKFLOWS = resolve(import.meta.dirname, "..", ".github", "workflows");

type Step = Record<string, unknown>;
type RunStep = {
  workflow: string;
  job: string;
  step: string;
  run: string;
  shell: string | null;
};

/** Every job of every workflow, with its steps; throws on a file that is not a map of jobs. */
function workflowJobs(): { workflow: string; job: string; steps: Step[] }[] {
  return readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .flatMap((workflow) => {
      const doc: unknown = yaml.load(
        readFileSync(join(WORKFLOWS, workflow), "utf8"),
      );
      if (!isRecord(doc) || !isRecord(doc.jobs)) {
        throw new Error(`${workflow} has no map of jobs`);
      }
      return Object.entries(doc.jobs).map(([job, body]) => {
        if (!isRecord(body) || !Array.isArray(body.steps)) {
          throw new Error(`${workflow} ${job} has no list of steps`);
        }
        const steps: unknown[] = body.steps;
        return { workflow, job, steps: steps.filter(isRecord) };
      });
    });
}

/** Every `run` script of every workflow, with where it sits. */
function runSteps(): RunStep[] {
  return workflowJobs().flatMap(({ workflow, job, steps }) =>
    steps.flatMap((step, i) =>
      typeof step.run === "string"
        ? [
            {
              workflow,
              job,
              step: typeof step.name === "string" ? step.name : `#${i}`,
              run: step.run,
              shell: typeof step.shell === "string" ? step.shell : null,
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
      typeof step.uses === "string" && step.uses.startsWith(`${action}@`)
        ? [{ workflow, job, inputs: isRecord(step.with) ? step.with : {} }]
        : [],
    ),
  );
}

/**
 * A simple command of a shell script: its words with quotes removed, and the
 * control operators (`&&`, `||`, `|`, `;`, `&`, or a line break as `;`) on
 * either side of it, null at the script's ends.
 */
type Command = { words: string[]; before: string | null; after: string | null };

/** Words that open or close a compound command, and so start no command. */
const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "{",
  "}",
]);

/**
 * The simple commands of `script`, in order. Reads quotes, backslash escapes,
 * line continuations, comments and `$( )`, enough for the scripts of these
 * workflows; leading reserved words and variable assignments are dropped, and
 * a command substitution stays inside its word.
 */
function commandsOf(script: string): Command[] {
  const commands: Command[] = [];
  let words: string[] = [];
  let word: string | null = null;
  let before: string | null = null;
  let i = 0;

  const endWord = () => {
    if (word !== null) {
      words.push(word);
    }
    word = null;
  };
  const endCommand = (operator: string | null) => {
    endWord();
    let start = 0;
    while (
      start < words.length &&
      (RESERVED.has(words[start] ?? "") ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? ""))
    ) {
      start++;
    }
    const rest = words.slice(start);
    if (rest.length > 0) {
      commands.push({ words: rest, before, after: operator });
      before = operator;
    } else if (operator !== ";" && operator !== null) {
      before = operator;
    }
    words = [];
  };
  /** The text of a `$( )` starting at `i`, up to its closing paren. */
  const substitution = (): string => {
    const start = i;
    let depth = 0;
    let quote: string | null = null;
    for (; i < script.length; i++) {
      const c = script[i];
      if (quote === "'") {
        if (c === "'") {
          quote = null;
        }
      } else if (c === "\\") {
        i++;
      } else if (quote === '"') {
        if (c === '"') {
          quote = null;
        }
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")" && --depth === 0) {
        i++;
        return script.slice(start, i);
      }
    }
    throw new Error(`unclosed $( in ${script}`);
  };

  while (i < script.length) {
    const c = script[i] ?? "";
    const next = script[i + 1] ?? "";
    if (c === "\\" && next === "\n") {
      i += 2;
    } else if (c === "\\") {
      word = (word ?? "") + next;
      i += 2;
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      if (end < 0) {
        throw new Error(`unclosed ' in ${script}`);
      }
      word = (word ?? "") + script.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      word = word ?? "";
      i++;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === "\\") {
          word += script[i + 1] ?? "";
          i += 2;
        } else if (script[i] === "$" && script[i + 1] === "(") {
          word += substitution();
        } else {
          word += script[i];
          i++;
        }
      }
      i++;
    } else if (c === "$" && next === "(") {
      word = (word ?? "") + substitution();
    } else if (c === "#" && word === null) {
      while (i < script.length && script[i] !== "\n") {
        i++;
      }
    } else if ((c === "&" || c === "|") && next === c) {
      endCommand(c + c);
      i += 2;
    } else if (c === "|" || c === "&" || c === ";" || c === "\n") {
      endCommand(c === "\n" ? ";" : c);
      i++;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  endCommand(null);
  return commands;
}

/** Whether `command` installs packages with Bun. */
const isBunInstall = ({ words }: Command) =>
  words[0] === "bun" && (words[1] === "install" || words[1] === "i");

/** Whether `command` publishes a package with npm, Bun, Yarn or pnpm. */
const isPublish = ({ words }: Command) =>
  ["npm", "bun", "yarn", "pnpm"].includes(words[0] ?? "") &&
  words.slice(1, 3).includes("publish");

const where = ({ workflow, job, step }: RunStep) =>
  `${workflow} ${job}: ${step}`;

/** The run steps that hold a command matching `matches`. */
const stepsWith = (steps: RunStep[], matches: (c: Command) => boolean) =>
  steps.filter((s) => commandsOf(s.run).some(matches));

describe("commandsOf", () => {
  it("splits on control operators and keeps them on each side", () => {
    expect(commandsOf("bun install --frozen-lockfile || bun install")).toEqual([
      {
        words: ["bun", "install", "--frozen-lockfile"],
        before: null,
        after: "||",
      },
      { words: ["bun", "install"], before: "||", after: null },
    ]);
  });

  it("joins continued lines and drops reserved words, assignments and comments", () => {
    expect(
      commandsOf(
        'if [ -n "$X" ]; then # note\n  FOO=1 npm \\\n    publish --tag "$TAG"\nfi',
      ).map((c) => c.words),
    ).toEqual([
      ["[", "-n", "$X", "]"],
      ["npm", "publish", "--tag", "$TAG"],
    ]);
  });

  it("keeps a command substitution, quotes and all, inside its word", () => {
    expect(
      commandsOf(
        `X=$(jq -r '.a | .b' f) && echo "v=$(cat "$F" | wc -l)" | tee -a out`,
      ),
    ).toEqual([
      { words: ["echo", 'v=$(cat "$F" | wc -l)'], before: "&&", after: "|" },
      { words: ["tee", "-a", "out"], before: "|", after: null },
    ]);
  });
});

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
  it("publish without running lifecycle scripts", () => {
    const publishes = steps.flatMap((s) =>
      commandsOf(s.run)
        .filter(isPublish)
        .map((c) => ({ where: where(s), words: c.words })),
    );
    expect(publishes.length).toBeGreaterThan(0);
    expect(
      publishes
        .filter((p) => !p.words.includes("--ignore-scripts"))
        .map((p) => p.where),
    ).toEqual([]);
  });

  // A checkout leaves the job's GitHub token in .git/config, where the build
  // scripts of the checked-out code could read it.
  it("check out without keeping credentials in a job that publishes", () => {
    const publishingJobs = new Set(
      stepsWith(steps, isPublish).map((s) => `${s.workflow} ${s.job}`),
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

  // Without pipefail, a pipeline into $GITHUB_OUTPUT succeeds when its first
  // command fails, and later steps read an empty output.
  it("write step outputs through a pipe only with pipefail", () => {
    const piped = stepsWith(
      steps,
      (c) => c.before === "|" && c.words.includes("$GITHUB_OUTPUT"),
    );
    expect(piped.length).toBeGreaterThan(0);
    expect(piped.filter((s) => s.shell !== "bash").map(where)).toEqual([]);
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

  // Without --frozen-lockfile, bun install rewrites bun.lock when package.json
  // disagrees with it, instead of failing; a `||` after it hides that failure.
  it("install dependencies from bun.lock as it is", () => {
    const installs = steps.flatMap((s) =>
      commandsOf(s.run)
        .filter(isBunInstall)
        .map((c) => ({ where: where(s), command: c })),
    );
    expect(installs.length).toBeGreaterThan(0);
    expect(
      installs
        .filter(
          ({ command }) =>
            !command.words.includes("--frozen-lockfile") ||
            command.before === "||" ||
            command.after === "||",
        )
        .map((i) => i.where),
    ).toEqual([]);
  });
});
