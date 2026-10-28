import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { type Document, isMap, isNode, isScalar, Scalar } from "yaml";

import type { DefaultSchemas } from "./default-schemas.js";
import {
  displayName,
  type Doc,
  isPythonSource,
  isQueryTransformDoc,
  loadDocs,
  type RowsData,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { LintEntity, LintFinding, LintRule } from "./findings.js";
import { entityOf, lint } from "./lint.js";
import { loadSchemas } from "./schemas.js";
import { tableLabel } from "./tables.js";
import { nativeOnlyStage } from "./transform-checks.js";
import { errorMessage, stringOrNull } from "./values.js";
import { editYamlText } from "./yaml-edit.js";

/** The injector cannot plant a defect: an unknown name or entity, or no place in the folder takes it. */
export class InjectError extends Error {
  override name = "InjectError";
}

export type InjectOptions = {
  folder: string;
  /** The name of one of `DEFECTS`. */
  defect: string;
  /** The entity_id of the document to plant the defect in; the first that takes it, when absent. */
  entity?: string;
  /** As `lint` takes them, for the lint that checks each place. */
  defaultSchemas?: DefaultSchemas;
};

export type Injection = {
  defect: LintRule;
  /** The file of the document the defect is planted in. */
  file: string;
  entity: LintEntity;
  /** What the edit did. */
  change: string;
  /** The files the edit wrote, changed or created. */
  files: string[];
  /** The findings the lint reports after the edit and not before. */
  findings: LintFinding[];
};

/** A file's new text. */
type FileEdit = { file: string; text: string };

/** A place a defect can go: the document it is planted in, and the edit. */
type Site = { doc: Doc; change: string; edits: readonly FileEdit[] };

/** A folder's documents, with what a defect needs to propose sites. */
type Folder = {
  docs: readonly Doc[];
  tests: readonly TestDoc[];
  transforms: readonly ValidDoc<"Transform">[];
  text: (file: string) => string;
  exists: (file: string) => boolean;
  /** Whether a file of the folder has this entity_id. */
  holds: (entityId: string) => boolean;
};

type TestDoc = ValidDoc<"TransformTest">;
type TestInput = TestDoc["body"]["inputs"][number];
type YamlPath = readonly (string | number)[];

/** A defect: the lint rule it makes fire, and where it can go in a folder. */
export type DefectInfo = {
  name: LintRule;
  description: string;
  /** What a folder must hold for the defect to have a place. */
  needs: string;
};

type Defect = DefectInfo & { sites: (folder: Folder) => Site[] };

const MISSING_TRANSFORM_ID = "MissingTransform00000";
const MISSING_COLLECTION_ID = "MissingCollection0000";
const MISSING_SNIPPET = "No Such Snippet";

/** A site whose edit is `change` applied to `doc`'s own file. */
function siteIn(
  folder: Folder,
  doc: Doc,
  change: string,
  edit: (yaml: Document) => void,
): Site {
  return {
    doc,
    change,
    edits: [
      { file: doc.file, text: editYamlText(folder.text(doc.file), edit) },
    ],
  };
}

/** Sets `value` at `path`, keeping the style of a scalar it replaces. */
function setIn(yaml: Document, path: YamlPath, value: unknown): void {
  yaml.setIn(
    path,
    typeof value === "object" && value !== null
      ? yaml.createNode(value)
      : value,
  );
}

/** Appends a copy of the node at `from` to the list at `list`. */
function addCopy(yaml: Document, from: YamlPath, list: YamlPath): void {
  const node = yaml.getIn(from, true);
  if (isNode(node)) {
    yaml.addIn(list, node.clone());
  }
}

/** Renames the key `from` of the map at `path` to `to`, in place. */
function renameKey(
  yaml: Document,
  path: YamlPath,
  from: string,
  to: string,
): void {
  const map = yaml.getIn(path, true);
  const pair = isMap(map)
    ? map.items.find((p) => isScalar(p.key) && p.key.value === from)
    : undefined;
  if (pair !== undefined) {
    pair.key = new Scalar(to);
  }
}

/** `name` with its second-to-last character dropped: TOTAL becomes TOTL. */
const typo = (name: string): string =>
  name.length < 2 ? `${name}${name}` : `${name.slice(0, -2)}${name.slice(-1)}`;

/**
 * `sql`, made to read `table` as well, keeping its result columns. One line
 * stays one line, unless a `--` comment would swallow the rest.
 */
function alsoReading(sql: string, table: string): string {
  const query = sql.trimEnd().replace(/;$/, "");
  const end = sql.endsWith("\n") ? "\n" : "";
  const gap = /\n|--/.test(query) ? "\n" : "";
  return `SELECT * FROM (${gap}${query}${gap}) AS planted WHERE EXISTS (SELECT 1 FROM ${table})${end}`;
}

const inputLabel = (input: TestInput): string =>
  tableLabel({ schema: input.table.schema ?? null, name: input.table.name });

const targetLabel = (transform: ValidDoc<"Transform">): string =>
  tableLabel({
    schema: transform.body.target.schema ?? null,
    name: transform.body.target.name,
  });

/** `file` with `_copy` before its extension. */
const copyPath = (file: string): string =>
  file.replace(/\.yaml$/, "_copy.yaml");

/** The SQL of a transform whose query is one native stage; null for another. */
function nativeSql(transform: ValidDoc<"Transform">): string | null {
  if (!isQueryTransformDoc(transform)) {
    return null;
  }
  return stringOrNull(nativeOnlyStage(transform.body.source)?.native);
}

const NATIVE_PATH = ["source", "query", "stages", 0, "native"];

/** Sites that rewrite the SQL of each transform whose query is one native stage. */
function nativeSites(
  folder: Folder,
  change: (transform: ValidDoc<"Transform">) => string,
  rewrite: (sql: string, transform: ValidDoc<"Transform">) => string,
): Site[] {
  return folder.transforms.flatMap((transform) => {
    const sql = nativeSql(transform);
    return sql === null
      ? []
      : [
          siteIn(folder, transform, change(transform), (yaml) =>
            setIn(yaml, NATIVE_PATH, rewrite(sql, transform)),
          ),
        ];
  });
}

/** The sites `sites` gives for each input of each test. */
function inputSites(
  folder: Folder,
  sites: (
    test: TestDoc,
    input: TestInput,
    path: YamlPath,
  ) => Site | readonly Site[],
): Site[] {
  return folder.tests.flatMap((test) =>
    test.body.inputs.flatMap((input, i) => sites(test, input, ["inputs", i])),
  );
}

/** Each test's data written out as rows: its inputs, then its expectations. */
function rowsData(
  test: TestDoc,
): { data: RowsData; path: YamlPath; label: string }[] {
  const { inputs, expectations } = test.body;
  return [
    ...inputs.map((input, i) => ({
      data: input,
      path: ["inputs", i],
      label: `the input for ${inputLabel(input)}`,
    })),
    ...expectations.map((expectation, i) => ({
      data: expectation,
      path: ["expectations", i],
      label: `expectation "${expectation.name}"`,
    })),
  ].flatMap(({ data, path, label }) =>
    "format" in data && data.format === "rows" ? [{ data, path, label }] : [],
  );
}

/** A site that sets `test`'s transform_id to `id`, which names `what`. */
function transformIdSite(
  folder: Folder,
  test: TestDoc,
  id: string,
  what: string,
): Site {
  return siteIn(folder, test, `transform_id is ${id}, ${what}`, (yaml) =>
    setIn(yaml, ["transform_id"], id),
  );
}

/** Sites that set each Database file's engine to `engine`. */
function engineSites(folder: Folder, engine: string): Site[] {
  return validDocsOf(folder.docs, "Database").map((database) =>
    siteIn(folder, database, `engine is ${engine}`, (yaml) =>
      setIn(yaml, ["engine"], engine),
    ),
  );
}

const DATABASE_ENGINE_NEEDS =
  "a Database file (databases/<slug>/<slug>.yaml) for a transform's database";

const DEFECT_LIST: readonly Defect[] = [
  {
    name: "schema",
    description: "A test's expectation has a type the schema does not allow.",
    needs: "a transform test with an expectation",
    sites: (folder) =>
      folder.tests.flatMap((test) =>
        test.body.expectations
          .slice(0, 1)
          .map((expectation) =>
            siteIn(
              folder,
              test,
              `expectation "${expectation.name}" has type "contains", which the schema does not allow`,
              (yaml) => setIn(yaml, ["expectations", 0, "type"], "contains"),
            ),
          ),
      ),
  },
  {
    name: "duplicate-entity-id",
    description: "A test file is copied, entity_id and all.",
    needs: "a transform test",
    sites: (folder) =>
      folder.tests.flatMap((test) => {
        const copy = copyPath(test.file);
        return folder.exists(copy)
          ? []
          : [
              {
                doc: test,
                change: `copied to ${copy}, with the same entity_id`,
                edits: [{ file: copy, text: folder.text(test.file) }],
              },
            ];
      }),
  },
  {
    name: "dangling-transform-id",
    description: "A test's transform_id names no entity.",
    needs: "a transform test",
    sites: (folder) =>
      folder.holds(MISSING_TRANSFORM_ID)
        ? []
        : folder.tests.map((test) =>
            transformIdSite(
              folder,
              test,
              MISSING_TRANSFORM_ID,
              "which no file holds",
            ),
          ),
  },
  {
    name: "wrong-type-transform-id",
    description:
      "A test's transform_id names an entity that is not a transform.",
    needs:
      "a transform test, and another file with an entity_id that is not a transform",
    sites: (folder) =>
      folder.tests.flatMap((test) => {
        const other = folder.docs.find(
          (doc) =>
            doc !== test &&
            doc.model !== "Transform" &&
            stringOrNull(doc.body.entity_id) !== null,
        );
        const id = stringOrNull(other?.body.entity_id);
        return other === undefined || id === null
          ? []
          : [
              transformIdSite(
                folder,
                test,
                id,
                `the entity_id of ${other.model ?? "a file"} ${displayName(other)}`,
              ),
            ];
      }),
  },
  {
    name: "transform-cycle",
    description: "A native transform's SQL also reads its own target.",
    needs: "a transform whose query is one native SQL stage",
    sites: (folder) =>
      nativeSites(
        folder,
        (transform) =>
          `its SQL also reads its own target, ${targetLabel(transform)}`,
        (sql, transform) => alsoReading(sql, targetLabel(transform)),
      ),
  },
  {
    name: "transform-collection",
    description:
      "A transform's collection_id names a collection not in the folder.",
    needs: "a transform",
    sites: (folder) =>
      folder.holds(MISSING_COLLECTION_ID)
        ? []
        : folder.transforms.map((transform) =>
            siteIn(
              folder,
              transform,
              `collection_id is ${MISSING_COLLECTION_ID}, which no file holds`,
              (yaml) => setIn(yaml, ["collection_id"], MISSING_COLLECTION_ID),
            ),
          ),
  },
  {
    name: "missing-incremental-table-tag",
    description:
      "A native transform writes an incremental table, with no table variable for the range filter.",
    needs: "a transform whose query is one native SQL stage, writing a table",
    sites: (folder) =>
      folder.transforms.flatMap((transform) =>
        nativeSql(transform) === null || transform.body.target.type !== "table"
          ? []
          : [
              siteIn(
                folder,
                transform,
                "writes an incremental table, and its SQL has no table variable",
                (yaml) => {
                  setIn(yaml, ["target", "type"], "table-incremental");
                  setIn(yaml, ["source", "source-incremental-strategy"], {
                    type: "checkpoint",
                  });
                },
              ),
            ],
      ),
  },
  {
    name: "missing-target-schema",
    description:
      "A transform's target drops its schema, on an engine with schemas.",
    needs:
      "a transform whose target names a schema, on a database whose engine has schemas, given by a Database file or the settings file",
    sites: (folder) =>
      folder.transforms.flatMap((transform) =>
        transform.body.target.schema === undefined ||
        transform.body.target.schema === null
          ? []
          : [
              siteIn(folder, transform, "its target names no schema", (yaml) =>
                yaml.deleteIn(["target", "schema"]),
              ),
            ],
      ),
  },
  {
    name: "unsupported-transform-engine",
    description:
      "A database's engine is H2, which runs no query or Python transform.",
    needs: DATABASE_ENGINE_NEEDS,
    sites: (folder) => engineSites(folder, "h2"),
  },
  {
    name: "untestable-engine",
    description:
      "A database's engine is Snowflake, which runs no transform test.",
    needs: `${DATABASE_ENGINE_NEEDS} that has a test`,
    sites: (folder) => engineSites(folder, "snowflake"),
  },
  {
    name: "missing-input",
    description: "A test drops the input for a table its transform reads.",
    needs:
      "a transform test with an input for a table its transform reads, which no expectation reads",
    sites: (folder) =>
      inputSites(folder, (test, input, path) =>
        siteIn(
          folder,
          test,
          `removed the input for ${inputLabel(input)}`,
          (yaml) => yaml.deleteIn(path),
        ),
      ),
  },
  {
    name: "unused-input",
    description:
      "A test gains an input for a table its transform does not read.",
    needs:
      "a transform test with an input, in a database whose tables the lint does not check against table files",
    sites: (folder) =>
      inputSites(folder, (test, input, path) => {
        const name = `${input.table.name}_unused`;
        return siteIn(
          folder,
          test,
          `added an input for ${tableLabel({ schema: input.table.schema ?? null, name })}, which its transform does not read`,
          (yaml) => {
            addCopy(yaml, path, ["inputs"]);
            setIn(
              yaml,
              ["inputs", test.body.inputs.length, "table", "name"],
              name,
            );
          },
        );
      }),
  },
  {
    name: "untestable-transform",
    description:
      "A test's transform_id names a Python transform, which Metabase cannot test.",
    needs: "a transform test and a Python transform",
    sites: (folder) => {
      const python = folder.transforms.find((t) =>
        isPythonSource(t.body.source),
      );
      return python === undefined
        ? []
        : folder.tests.map((test) =>
            transformIdSite(
              folder,
              test,
              python.body.entity_id,
              `the Python transform ${python.body.name}`,
            ),
          );
    },
  },
  {
    name: "duplicate-input",
    description: "A test declares a second input for the same table.",
    needs: "a transform test with an input",
    sites: (folder) =>
      inputSites(folder, (test, input, path) =>
        siteIn(
          folder,
          test,
          `added a second input for ${inputLabel(input)}`,
          (yaml) => addCopy(yaml, path, ["inputs"]),
        ),
      ),
  },
  {
    name: "expectation-reads-other-table",
    description:
      "A test's SQL expectation also reads a table that is neither the output nor an input.",
    needs: "a transform test with a SQL expectation",
    sites: (folder) =>
      folder.tests.flatMap((test) =>
        test.body.expectations.flatMap((expectation, i) => {
          if (!("sql" in expectation)) {
            return [];
          }
          const other = tableLabel({
            schema: test.body.inputs[0]?.table.schema ?? null,
            name: "planted_other",
          });
          return [
            siteIn(
              folder,
              test,
              `expectation "${expectation.name}" also reads ${other}, which is neither the output nor an input`,
              (yaml) =>
                setIn(
                  yaml,
                  ["expectations", i, "sql"],
                  alsoReading(expectation.sql, other),
                ),
            ),
          ];
        }),
      ),
  },
  {
    name: "row-columns-mismatch",
    description: "A row of a test's data misspells a column.",
    needs: "a transform test with an input or expectation of at least one row",
    sites: (folder) =>
      folder.tests.flatMap((test) =>
        rowsData(test).flatMap(({ data, path, label }) => {
          const [row] = data.rows;
          const [key] = row === undefined ? [] : Object.keys(row);
          if (key === undefined) {
            return [];
          }
          const misspelled = typo(key);
          return misspelled in row
            ? []
            : [
                siteIn(
                  folder,
                  test,
                  `the first row of ${label} spells ${key} as ${misspelled}`,
                  (yaml) =>
                    renameKey(yaml, [...path, "rows", 0], key, misspelled),
                ),
              ];
        }),
      ),
  },
  {
    name: "duplicate-expectation-name",
    description: "A test's second expectation takes the first one's name.",
    needs: "a transform test with two expectations",
    sites: (folder) =>
      folder.tests.flatMap((test) => {
        const [first, second] = test.body.expectations;
        return second === undefined
          ? []
          : [
              siteIn(
                folder,
                test,
                `expectation "${second.name}" is renamed "${first.name}", the name of the first`,
                (yaml) => setIn(yaml, ["expectations", 1, "name"], first.name),
              ),
            ];
      }),
  },
  {
    name: "no-expectations",
    description: "A test loses its expectations, so it checks nothing.",
    needs: "a transform test with an expectation",
    sites: (folder) =>
      folder.tests.flatMap((test) =>
        test.body.expectations.length === 0
          ? []
          : [
              siteIn(folder, test, "removed every expectation", (yaml) =>
                setIn(yaml, ["expectations"], []),
              ),
            ],
      ),
  },
  {
    name: "reads-not-checked",
    description:
      "A native transform uses a snippet no file holds, so its reads are unknown.",
    needs: "a transform whose query is one native SQL stage",
    sites: (folder) =>
      nativeSites(
        folder,
        () =>
          `its SQL uses the snippet "${MISSING_SNIPPET}", which no file holds`,
        (sql) =>
          `${sql.trimEnd()}\n{{snippet: ${MISSING_SNIPPET}}}${sql.endsWith("\n") ? "\n" : ""}`,
      ),
  },
  {
    name: "input-missing-read-column",
    description: "A test's input drops a column its transform reads.",
    needs:
      "a transform test with an input of rows, for a table whose columns its transform reads",
    sites: (folder) =>
      inputSites(folder, (test, input, path) =>
        input.format !== "rows"
          ? []
          : input.columns.map(({ name }, c) =>
              siteIn(
                folder,
                test,
                `removed column ${name} from the input for ${inputLabel(input)}`,
                (yaml) => {
                  yaml.deleteIn([...path, "columns", c]);
                  input.rows.forEach((_, r) =>
                    yaml.deleteIn([...path, "rows", r, name]),
                  );
                },
              ),
            ),
      ),
  },
  {
    name: "live-sql-input",
    description:
      "A test's input of rows becomes SQL that reads the real table.",
    needs: "a transform test with an input of rows",
    sites: (folder) =>
      inputSites(folder, (test, input, path) =>
        input.format !== "rows"
          ? []
          : siteIn(
              folder,
              test,
              `the input for ${inputLabel(input)} is SQL that reads the real table`,
              (yaml) => {
                const columns = input.columns.map((c) => c.name).join(", ");
                setIn(yaml, [...path, "format"], "sql");
                yaml.deleteIn([...path, "columns"]);
                yaml.deleteIn([...path, "rows"]);
                setIn(
                  yaml,
                  [...path, "sql"],
                  `SELECT ${columns} FROM ${inputLabel(input)}`,
                );
              },
            ),
      ),
  },
  {
    name: "duplicate-target",
    description:
      "A transform file is copied with a new entity_id, so two transforms write one table.",
    needs: "a transform",
    sites: (folder) =>
      folder.transforms.flatMap((transform) => {
        const copy = copyPath(transform.file);
        const id = `${transform.body.entity_id.slice(0, 16)}_copy`;
        return folder.exists(copy) || folder.holds(id)
          ? []
          : [
              {
                doc: transform,
                change: `copied to ${copy}, with entity_id ${id} and the same target`,
                edits: [
                  {
                    file: copy,
                    text: editYamlText(folder.text(transform.file), (yaml) =>
                      setIn(yaml, ["entity_id"], id),
                    ),
                  },
                ],
              },
            ];
      }),
  },
];

/** Every defect `inject` can plant. */
export const DEFECTS: readonly DefectInfo[] = DEFECT_LIST;

/** The documents of `folder`, with what the defects' sites read. */
function openFolder(folder: string): Folder {
  const { docs } = loadDocs(folder, loadSchemas());
  const ids = new Set(docs.map((doc) => stringOrNull(doc.body.entity_id)));
  return {
    docs,
    tests: validDocsOf(docs, "TransformTest"),
    transforms: validDocsOf(docs, "Transform"),
    text: (file) => readFileSync(join(folder, file), "utf8"),
    exists: (file) => existsSync(join(folder, file)),
    holds: (entityId) => ids.has(entityId),
  };
}

const findingKey = (f: LintFinding): string =>
  JSON.stringify([f.rule, f.file, f.message, f.related]);

/** The findings of `after` that `before` lacks, counting repeats. */
function addedFindings(
  before: readonly LintFinding[],
  after: readonly LintFinding[],
): LintFinding[] {
  const left = before.map(findingKey);
  return after.filter((finding) => {
    const at = left.indexOf(findingKey(finding));
    if (at === -1) {
      return true;
    }
    left.splice(at, 1);
    return false;
  });
}

/** Writes `edits` into `folder`; returns a function that undoes them. */
function applyEdits(folder: string, edits: readonly FileEdit[]): () => void {
  const undo = edits.map(({ file }) => {
    const path = join(folder, file);
    const original = existsSync(path) ? readFileSync(path, "utf8") : null;
    return () =>
      original === null ? rmSync(path) : writeFileSync(path, original);
  });
  for (const { file, text } of edits) {
    writeFileSync(join(folder, file), text);
  }
  return () => undo.forEach((restore) => restore());
}

/** What the lint reported for a site that did not take the defect alone. */
function outcomeOf(findings: readonly LintFinding[]): string {
  return findings.length === 0
    ? "the lint reported nothing new"
    : `the lint reported ${[...new Set(findings.map((f) => f.rule))].join(", ")}`;
}

/**
 * Plants one defect in a folder of representation files, editing its files
 * in place, so that the lint reports findings of that rule and no other new
 * finding. Each place the defect could go, in path order of the files, is
 * tried on a copy of the folder, and the first the lint confirms is written.
 * The same folder and defect always give the same edit.
 *
 * Rejects with an `InjectError`, changing nothing, for an unknown defect or
 * entity, or when no place in the folder takes the defect alone; the message
 * says what the defect needs and what each place tried gave. Rejects as
 * `lint` does when the folder cannot be linted.
 */
export async function inject({
  folder,
  defect,
  entity,
  defaultSchemas,
}: InjectOptions): Promise<Injection> {
  const planted = DEFECT_LIST.find((d) => d.name === defect);
  if (planted === undefined) {
    throw new InjectError(
      `Unknown defect: ${defect}; one of ${DEFECT_LIST.map((d) => d.name).join(", ")}`,
    );
  }
  const opened = openFolder(folder);
  if (entity !== undefined && !opened.holds(entity)) {
    throw new InjectError(`No file in the folder has entity_id ${entity}`);
  }
  const sites = planted
    .sites(opened)
    .filter(
      (site) => entity === undefined || site.doc.body.entity_id === entity,
    );
  const scratch = mkdtempSync(join(tmpdir(), "representations-inject-"));
  try {
    cpSync(folder, scratch, {
      recursive: true,
      filter: (source) => basename(source) !== ".git",
    });
    const findings = async () =>
      (await lint({ folder: scratch, defaultSchemas })).findings;
    const before = await findings();
    const tried: string[] = [];
    for (const site of sites) {
      const undo = applyEdits(scratch, site.edits);
      let outcome: string;
      try {
        const added = addedFindings(before, await findings());
        if (added.length > 0 && added.every((f) => f.rule === defect)) {
          applyEdits(folder, site.edits);
          return {
            defect: planted.name,
            file: site.doc.file,
            entity: entityOf(site.doc),
            change: site.change,
            files: site.edits.map((e) => e.file),
            findings: added,
          };
        }
        outcome = outcomeOf(added);
        // eslint-disable-next-line no-restricted-syntax -- wraps a whole lint() call, which settles its own stand-in parser
      } catch (e) {
        outcome = `the lint could not run: ${errorMessage(e)}`;
      } finally {
        undo();
      }
      tried.push(`  ${site.doc.file}: ${site.change}; ${outcome}`);
    }
    throw new InjectError(
      [
        `No place in ${folder}${entity === undefined ? "" : ` (entity ${entity})`} takes ${defect} alone. It needs ${planted.needs}.`,
        ...(tried.length === 0 ? [] : ["Tried:", ...tried]),
      ].join("\n"),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
