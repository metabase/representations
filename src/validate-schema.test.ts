import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { lint } from "./lint.js";
import { loadSchemas } from "./schemas.js";
import {
  checkSchema,
  entityFiles,
  IMPORTED_MODELS,
  validateSchema,
} from "./validate-schema.js";
import { isRecord } from "./values.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

describe("IMPORTED_MODELS", () => {
  it("holds every model a schema describes", () => {
    const imported = new Set<string>(IMPORTED_MODELS);
    expect(
      [...loadSchemas().models.keys()].filter((model) => !imported.has(model)),
    ).toEqual([]);
  });
});

describe("validateSchema", () => {
  it("validates all bundled example files", () => {
    const { results, passed, failed } = validateSchema({ folder: EXAMPLES });
    expect(results.length).toBeGreaterThan(0);
    expect(failed).toBe(0);
    expect(passed).toBe(results.length);
  });

  describe("with an ad-hoc folder", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-validate-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("returns zero results when no YAML files are present", () => {
      const { results, passed, failed } = validateSchema({ folder: workdir });
      expect(results).toEqual([]);
      expect(passed).toBe(0);
      expect(failed).toBe(0);
    });

    it.each([
      ["a map with no serdes/meta", "name: Notes\n"],
      ["a map whose serdes/meta is null", "name: Notes\nserdes/meta:\n"],
      ["an empty file", ""],
      ["a file that holds only a comment", "# notes\n"],
    ])("passes %s, which Metabase skips, with a warning", (_, content) => {
      mkdirSync(join(workdir, "collections", "main"), { recursive: true });
      writeFileSync(
        join(workdir, "collections", "main", "notes.yaml"),
        content,
      );

      expect(validateSchema({ folder: workdir })).toEqual({
        results: [
          {
            file: join("collections", "main", "notes.yaml"),
            status: "skipped",
            warning: "Metabase skips this file because it has no serdes/meta",
          },
        ],
        passed: 0,
        failed: 0,
        skipped: 1,
        unchecked: 0,
      });
    });

    it.each([
      [
        "a data app's collection",
        ["collections", "data_apps", "data_app__shop"],
        "broken.yaml",
      ],
      ["a data app's manifest", ["data_apps", "shop"], "data_app.yaml"],
      ["actions", ["actions"], "broken.yaml"],
    ])("validates %s", (_, dirs, file) => {
      mkdirSync(join(workdir, ...dirs), { recursive: true });
      writeFileSync(
        join(workdir, ...dirs, file),
        "name: 5\nserdes/meta:\n- model: Collection\n",
      );

      const { failed, results } = validateSchema({ folder: workdir });
      expect(failed).toBe(1);
      expect(results[0].file).toBe(join(...dirs, file));
    });

    describe("which files it reads", () => {
      const write = (file: string, content: string): void => {
        mkdirSync(join(workdir, file, ".."), { recursive: true });
        writeFileSync(join(workdir, file), content);
      };
      const table = yaml.dump({
        name: "ORDERS",
        db_id: "Sample Database",
        "serdes/meta": [
          { model: "Database", id: "Sample Database" },
          { model: "Table", id: "ORDERS" },
        ],
      });
      const transform = readFileSync(
        join(EXAMPLES, "collections", "transforms", "native_transform.yaml"),
        "utf8",
      );
      const collection = yaml.dump({
        name: "Archive",
        entity_id: "cOlArChIvE000ExAmPlx2",
        "serdes/meta": [{ model: "Collection" }],
      });
      const statuses = (): string[] =>
        validateSchema({ folder: workdir }).results.map((r) =>
          [r.file, "model" in r ? r.model : "", r.status].join(" "),
        );

      it("checks a file against the schema of its model, wherever it sits under an imported folder", () => {
        write("collections/odd/place/orders.yaml", table);
        write("snippets/elsewhere/report.yaml", transform);
        write(
          "databases/db/fields/ID.yaml",
          "name: 5\nserdes/meta:\n- model: Field\n",
        );

        expect(statuses()).toEqual([
          "collections/odd/place/orders.yaml Table ok",
          "databases/db/fields/ID.yaml Field fail",
          "snippets/elsewhere/report.yaml Transform ok",
        ]);
      });

      it("reads a file under a dot folder, and a data app manifest at any depth", () => {
        write("collections/.archive/archive.yaml", collection);
        write("data_apps/data_app.yaml", collection);
        write("data_apps/group/shop/data_app.yaml", collection);

        expect(statuses()).toEqual([
          "collections/.archive/archive.yaml Collection ok",
          "data_apps/data_app.yaml Collection ok",
          "data_apps/group/shop/data_app.yaml Collection ok",
        ]);
      });

      it("follows no symbolic link to a folder, and fails one to a file without reading it", () => {
        const outside = mkdtempSync(join(tmpdir(), "representations-linked-"));
        try {
          mkdirSync(join(outside, "group"));
          writeFileSync(join(outside, "linked.yaml"), collection);
          writeFileSync(join(outside, "group", "nested.yaml"), collection);
          write("collections/real/real.yaml", collection);
          symlinkSync(outside, join(workdir, "collections", "linked"));
          symlinkSync(outside, join(workdir, "transforms"));
          symlinkSync(
            join(outside, "linked.yaml"),
            join(workdir, "collections", "file.yaml"),
          );

          expect(statuses()).toEqual([
            "collections/file.yaml  fail",
            "collections/real/real.yaml Collection ok",
          ]);
          expect(validateSchema({ folder: workdir }).results[0]).toEqual({
            file: "collections/file.yaml",
            status: "fail",
            errors: [
              {
                path: "/",
                message:
                  "a symbolic link: remote sync reads the link's text, not the file it points to; replace the link with the file",
              },
            ],
          });
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      });

      it("fails a file it cannot read, and reads the others", () => {
        write("collections/locked.yaml", collection);
        write("collections/real.yaml", collection);
        chmodSync(join(workdir, "collections", "locked.yaml"), 0o000);
        try {
          expect(validateSchema({ folder: workdir }).results).toEqual([
            {
              file: "collections/locked.yaml",
              status: "fail",
              errors: [{ path: "/", message: "cannot read the file (EACCES)" }],
            },
            {
              file: "collections/real.yaml",
              model: "Collection",
              status: "ok",
            },
          ]);
        } finally {
          chmodSync(join(workdir, "collections", "locked.yaml"), 0o644);
        }
      });

      it("fails a folder it cannot read, and reads the others", () => {
        write("collections/locked/inside.yaml", collection);
        write("collections/real.yaml", collection);
        write("transforms/t.yaml", collection);
        const locked = join(workdir, "collections", "locked");
        chmodSync(locked, 0o000);
        try {
          expect(validateSchema({ folder: workdir }).results).toEqual([
            {
              file: "collections/locked",
              status: "fail",
              errors: [
                { path: "/", message: "cannot read the folder (EACCES)" },
              ],
            },
            {
              file: "collections/real.yaml",
              model: "Collection",
              status: "ok",
            },
            {
              file: "transforms/t.yaml",
              model: "Collection",
              status: "ok",
            },
          ]);
        } finally {
          chmodSync(locked, 0o755);
        }
      });

      it("matches folder and file names in their exact case, as Metabase does", () => {
        write("collections/Upper.YAML", collection);
        write("TRANSFORMS/t.yaml", collection);
        write("data_apps/shop/DATA_APP.yaml", collection);
        write("collections/lower.yaml", collection);

        expect(statuses()).toEqual(["collections/lower.yaml Collection ok"]);
      });

      it("fails a symbolic link to nothing, which remote sync reads as text", () => {
        write("collections/real.yaml", collection);
        symlinkSync(
          join(workdir, "nonexistent.yaml"),
          join(workdir, "collections", "broken.yaml"),
        );

        expect(statuses()).toEqual([
          "collections/broken.yaml  fail",
          "collections/real.yaml Collection ok",
        ]);
      });

      it("skips the files Metabase does not import", () => {
        write("collection.yaml", collection);
        write("notes/collection.yaml", collection);
        write("collections/collection.yml", collection);
        write("collections/.collection.yaml", collection);
        write("data_apps/shop/settings.yaml", collection);
        mkdirSync(join(workdir, "collections", "folder.yaml"));

        expect(statuses()).toEqual([]);
      });
    });

    describe("actions", () => {
      const example = (file: string): Record<string, unknown> =>
        yaml.load(
          readFileSync(
            file === "apply_discount.yaml"
              ? join(EXAMPLES, "collections", "data_actions", file)
              : join(EXAMPLES, "collections", "main", "queries", file),
            "utf8",
          ),
        ) as Record<string, unknown>; // Example actions are YAML maps.

      const validateAction = (action: Record<string, unknown>) => {
        mkdirSync(join(workdir, "actions"), { recursive: true });
        writeFileSync(
          join(workdir, "actions", "action.yaml"),
          yaml.dump(action),
        );
        return validateSchema({ folder: workdir });
      };

      it.each([
        ["an unknown type", { ...example("create_order.yaml"), type: "magic" }],
        [
          "the removed http type",
          { ...example("apply_discount.yaml"), type: "http" },
        ],
        [
          "an implicit type but no model",
          (({ model_id: _modelId, ...action }) => action)(
            example("create_order.yaml"),
          ),
        ],
        [
          "an unknown implicit kind",
          {
            ...example("create_order.yaml"),
            implicit: [{ kind: "row/upsert" }],
          },
        ],
        [
          "a query action without its query",
          { ...example("apply_discount.yaml"), query: [] },
        ],
      ])("rejects an action with %s", (_, action) => {
        expect(validateAction(action).failed).toBe(1);
      });

      it.each([
        ["a query action without a model", example("apply_discount.yaml")],
        [
          "a query action with a null model",
          { ...example("apply_discount.yaml"), model_id: null },
        ],
        [
          "a query action still on a model",
          {
            ...example("apply_discount.yaml"),
            model_id: "4eroqa4ZYl4WkNjP8XTvu",
          },
        ],
      ])("accepts %s", (_, action) => {
        expect(validateAction(action).failed).toBe(0);
      });
    });

    describe("transform tests", () => {
      /** `value` as a map; throws when it is not one. */
      const mapOf = (value: unknown): Record<string, unknown> => {
        if (!isRecord(value)) {
          throw new Error("not a YAML map");
        }
        return value;
      };
      /** The maps of the list `value`; throws when it is not a list of maps. */
      const mapsOf = (value: unknown): Record<string, unknown>[] => {
        if (!Array.isArray(value)) {
          throw new Error("not a YAML list");
        }
        return value.map(mapOf);
      };

      const example = mapOf(
        yaml.load(
          readFileSync(
            join(
              EXAMPLES,
              "collections",
              "transforms",
              "native_transform",
              "product_revenue_report__category_totals.yaml",
            ),
            "utf8",
          ),
        ),
      );

      const validateTransformTest = (
        transformTest: Record<string, unknown>,
      ) => {
        mkdirSync(join(workdir, "collections", "transforms"), {
          recursive: true,
        });
        writeFileSync(
          join(workdir, "collections", "transforms", "test.yaml"),
          yaml.dump(transformTest),
        );
        return validateSchema({ folder: workdir });
      };

      const [rowsInput, sqlInput] = mapsOf(example.inputs);
      const [equals, empty] = mapsOf(example.expectations);

      it("accepts the example", () => {
        expect(validateTransformTest(example).failed).toBe(0);
      });

      it.each([
        [
          "no transform",
          (({ transform_id: _transformId, ...test }) => test)(example),
        ],
        [
          "an unknown input format",
          { ...example, inputs: [{ ...sqlInput, format: "csv" }] },
        ],
        [
          "a rows input without columns",
          {
            ...example,
            inputs: [(({ columns: _columns, ...input }) => input)(rowsInput)],
          },
        ],
        [
          "a sql input with rows",
          { ...example, inputs: [{ ...sqlInput, rows: [] }] },
        ],
        [
          "a column without a cast type",
          {
            ...example,
            inputs: [{ ...rowsInput, columns: [{ name: "ID" }] }],
          },
        ],
        [
          "a table with an unknown key",
          {
            ...example,
            inputs: [{ ...sqlInput, table: { name: "ORDERS", db: "x" } }],
          },
        ],
        [
          "an unknown expectation type",
          { ...example, expectations: [{ ...empty, type: "contains" }] },
        ],
        [
          "an empty expectation with a format",
          { ...example, expectations: [{ ...empty, format: "sql" }] },
        ],
        [
          "an equals expectation without a format",
          {
            ...example,
            expectations: [(({ format: _format, ...e }) => e)(equals)],
          },
        ],
        [
          "an expectation without a name",
          {
            ...example,
            expectations: [(({ name: _name, ...e }) => e)(empty)],
          },
        ],
      ])("rejects a transform test with %s", (_, transformTest) => {
        expect(validateTransformTest(transformTest).failed).toBe(1);
      });

      it("accepts an equals expectation over a SQL query", () => {
        expect(
          validateTransformTest({
            ...example,
            expectations: [
              {
                type: "equals",
                name: "same as the query",
                format: "sql",
                sql: "SELECT 'Gadget' AS CATEGORY",
              },
            ],
          }).failed,
        ).toBe(0);
      });
    });

    describe("serdes/meta", () => {
      const collection = {
        name: "Reports",
        entity_id: "cOlRePorTs000ExAmPlx2",
      };

      it.each([
        ["only the model", [{ model: "Collection" }]],
        [
          "the full identity path of older exports",
          [
            {
              id: "cOlRePorTs000ExAmPlx2",
              label: "reports",
              model: "Collection",
            },
          ],
        ],
      ])("accepts %s", (_, serdesMeta) => {
        mkdirSync(join(workdir, "collections", "main"), { recursive: true });
        writeFileSync(
          join(workdir, "collections", "main", "reports.yaml"),
          yaml.dump({ ...collection, "serdes/meta": serdesMeta }),
        );

        expect(validateSchema({ folder: workdir }).failed).toBe(0);
      });

      it("rejects an entry without a model", () => {
        mkdirSync(join(workdir, "collections", "main"), { recursive: true });
        writeFileSync(
          join(workdir, "collections", "main", "reports.yaml"),
          yaml.dump({
            ...collection,
            "serdes/meta": [{ model: "Collection" }, { id: "x" }],
          }),
        );

        expect(validateSchema({ folder: workdir }).failed).toBe(1);
      });
    });

    it("fails a file with a duplicate key, naming its position", () => {
      mkdirSync(join(workdir, "collections", "main"), { recursive: true });
      writeFileSync(
        join(workdir, "collections", "main", "duplicate.yaml"),
        "name: a\nslug: a\nname: b\n",
      );

      const [result] = validateSchema({ folder: workdir }).results;
      expect(result.status === "fail" && result.errors).toEqual([
        {
          path: "/",
          message: expect.stringMatching(
            /^invalid YAML: duplicated mapping key \(3:1\)/,
          ),
        },
      ]);
    });

    // validate-schema checks the format; the lint predicts what Metabase does,
    // and Metabase keeps the last value.
    it("fails a file with a duplicate key that the lint warns on, as the docs say", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "transforms/transform_tags/duplicate.yaml";
      writeFileSync(
        join(workdir, file),
        "name: daily\nname: daily2\nentity_id: dUW7nvQHQBdA0Rx0gJckX\nbuilt_in_type: null\nserdes/meta:\n- model: TransformTag\n",
      );

      const validated = validateSchema({ folder: workdir }).results.filter(
        (r) => r.status === "fail",
      );
      const { findings } = await lint({ folder: workdir });
      expect(validated.map((r) => r.file)).toEqual([file]);
      expect(
        findings
          .filter((f) => f.file === file)
          .map((f) => `${f.severity} ${f.rule}`),
      ).toEqual(["warning duplicate-yaml-key"]);
      expect(
        readFileSync(resolve(EXAMPLES, "..", "..", "docs", "lint.md"), "utf8"),
      ).toContain(
        "`validate-schema` checks that a file is well formed, and `lint` predicts what Metabase does with it",
      );
    }, 60_000);

    it.each([
      ["Reports", 0],
      ["yes", 1],
      ["on", 1],
      ["1:30", 1],
    ])(
      "reads a name of %s as Metabase does, failing %p file(s)",
      (name, failed) => {
        mkdirSync(join(workdir, "collections", "main"), { recursive: true });
        writeFileSync(
          join(workdir, "collections", "main", "reports.yaml"),
          [
            `name: ${name}`,
            "entity_id: cOlRePorTs000ExAmPlx2",
            "serdes/meta:",
            "- model: Collection",
            "",
          ].join("\n"),
        );

        expect(validateSchema({ folder: workdir }).failed).toBe(failed);
      },
    );

    it("passes a file of a model Metabase imports and no schema describes, as not checked", () => {
      const files = [
        ["custom_viz_plugins/plugin/plugin.yaml", "CustomVizPlugin"],
        ["databases/db/tables/t/dimensions/d.yaml", "Dimension"],
        ["databases/db/tables/t/t__settings.yaml", "TableUserSettings"],
        ["embedding_themes/theme.yaml", "EmbeddingTheme"],
        ["osi_ai_context/context.yaml", "OsiAiContext"],
      ];
      for (const [file, model] of files) {
        mkdirSync(join(workdir, file, ".."), { recursive: true });
        writeFileSync(
          join(workdir, file),
          yaml.dump({ name: 5, "serdes/meta": [{ model }] }),
        );
      }

      expect(validateSchema({ folder: workdir })).toEqual({
        results: files.map(([file, model]) => ({
          file,
          model,
          status: "unchecked",
        })),
        passed: 0,
        failed: 0,
        skipped: 0,
        unchecked: files.length,
      });
    });

    it.each(["Setting", "DashboardCard"])(
      "fails a file of model %s, which is not among the models Metabase exports to entity files, as an unknown model",
      (model) => {
        mkdirSync(join(workdir, "collections"), { recursive: true });
        writeFileSync(
          join(workdir, "collections", "entity.yaml"),
          yaml.dump({ name: "Entity", "serdes/meta": [{ model, id: "x" }] }),
        );

        expect(validateSchema({ folder: workdir }).results).toEqual([
          {
            file: join("collections", "entity.yaml"),
            model,
            status: "fail",
            errors: [{ path: "/", message: `unknown model "${model}"` }],
          },
        ]);
      },
    );

    describe("times", () => {
      const resultOf = (lines: string[]) => {
        mkdirSync(join(workdir, "collections"), { recursive: true });
        writeFileSync(
          join(workdir, "collections", "entity.yaml"),
          [...lines, ""].join("\n"),
        );
        return validateSchema({ folder: workdir }).results[0];
      };

      it("fails a file whose time Metabase cannot read, with or without serdes/meta", () => {
        expect(resultOf(["name: Notes", "created_at: nope"])).toEqual({
          file: join("collections", "entity.yaml"),
          status: "fail",
          errors: [
            {
              path: "/created_at",
              message: 'Metabase cannot read created_at as a time: "nope"',
            },
          ],
        });
        expect(
          resultOf([
            "name: Archive",
            "entity_id: cOlArChIvE000ExAmPlx2",
            "last_analyzed: 2024-13-01",
            "serdes/meta:",
            "- model: Collection",
          ]).status,
        ).toBe("fail");
      });

      it("fails a time that YAML reads as no text, such as an unquoted timestamp", () => {
        for (const value of ["2024-01-05T10:00:00Z", "5", "true"]) {
          expect(
            resultOf(["name: Notes", `updated_at: ${value}`]),
          ).toMatchObject({
            status: "fail",
            errors: [
              {
                path: "/updated_at",
                message:
                  "updated_at is not text, which Metabase reads as a time; quote it",
              },
            ],
          });
        }
      });

      it("reads a time Metabase reads, null, and a blank one", () => {
        for (const value of [
          "'2025-05-28T17:49:20.649159Z'",
          "'2024-01-05'",
          "'2024-01-05 10:00:00+0200'",
          "'2024-01-05T10:00:00 America/New_York'",
          "'10:30'",
          "null",
          "''",
        ]) {
          expect(resultOf(["name: Notes", `created_at: ${value}`]).status).toBe(
            "skipped",
          );
        }
      });

      it("fails a file with a top-level key that is not text, as Metabase's time reading does", () => {
        for (const key of ["1", "true", "~"]) {
          expect(
            resultOf([
              "name: Archive",
              `${key}: x`,
              "serdes/meta:",
              "- model: Collection",
            ]),
          ).toMatchObject({
            status: "fail",
            errors: [
              {
                path: `/${key}`,
                message: `the top-level key ${key} is not text, which Metabase requires; quote it`,
              },
            ],
          });
        }
        expect(
          resultOf([
            "name: Archive",
            "'1': x",
            "serdes/meta:",
            "- model: Collection",
          ]),
        ).not.toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({ path: "/1" }),
          ]),
        });
      });

      // Each answer is Metabase's `u.date/parse` formatter's, run on
      // OpenJDK 25.0.1 (tzdb 2025b).
      it.each([
        ["EST", false],
        ["MST", false],
        ["PST", false],
        ["UT", true],
        ["UTC+01:00", true],
        ["UTC", true],
        ["GMT", true],
        ["GMT0", true],
        ["GMT+5", false],
        ["GMT+05", true],
        ["GMT+05:00:30", true],
        // Metabase adds the colon to a trailing +HHmm before it parses.
        ["UTC+0100", true],
        ["GMT-0530", true],
        ["UT-03:00", true],
        ["UTC+19:00", false],
        ["UTC-18:00", true],
        ["UTC+1:00", false],
        ["UTC0", false],
        ["UTCX", false],
        ["GMT-0", false],
        ["utc", true],
        ["America/New_York", true],
        ["america/new_york", true],
        ["[America/New_York]", true],
        ["Europe/Paris]", true],
        ["[Europe/Paris", true],
        ["Etc/GMT+5", true],
        ["EST5EDT", true],
        ["SystemV/EST5", true],
        ["Europe/Kiev", true],
        ["Z", true],
        ["z", true],
        ["[Z]", true],
        ["[+05:00]", true],
        ["Nowhere/City", false],
      ])("reads the zone %p as Java does: %p", (zone, reads) => {
        expect(
          resultOf(["name: Notes", `created_at: '2024-01-05T10:00:00 ${zone}'`])
            .status,
        ).toBe(reads ? "skipped" : "fail");
      });

      it("fails a time in a zone that does not exist", () => {
        expect(
          resultOf(["name: Notes", "created_at: '2024-01-05 Nowhere/Land'"])
            .status,
        ).toBe("fail");
      });
    });

    it("fails a file that is not valid UTF-8, saying so", () => {
      mkdirSync(join(workdir, "collections"), { recursive: true });
      writeFileSync(
        join(workdir, "collections", "binary.yaml"),
        Buffer.from([0xff, 0xfe, 0x00, 0x41]),
      );
      expect(validateSchema({ folder: workdir }).results).toEqual([
        {
          file: join("collections", "binary.yaml"),
          status: "fail",
          errors: [{ path: "/", message: "not valid UTF-8" }],
        },
      ]);
    });

    it("says what an entity id needs, and how to make one", () => {
      mkdirSync(join(workdir, "collections"), { recursive: true });
      const write = (entityId: string) =>
        writeFileSync(
          join(workdir, "collections", "c.yaml"),
          yaml.dump({
            name: "C",
            entity_id: entityId,
            "serdes/meta": [{ model: "Collection" }],
          }),
        );
      const errorsOf = () => {
        const [result] = validateSchema({ folder: workdir }).results;
        return result.status === "fail" ? result.errors : [];
      };
      write("abc");
      expect(errorsOf()).toEqual([
        {
          path: "/entity_id",
          message:
            'must be an entity id: 21 characters of A-Z, a-z, 0-9, _ and -; got 3 characters. Run "representations generate-entity-id" for a new one',
        },
      ]);
      write("abc.efghijklmnopqrstu");
      expect(errorsOf()[0].message).toContain("got a character outside them");
    });

    it("says what an entity id needs where a schema refers to it by a relative path", () => {
      const file = join(
        "collections",
        "main",
        "queries",
        "source_card_reference.yaml",
      );
      mkdirSync(join(workdir, "collections", "main", "queries"), {
        recursive: true,
      });
      writeFileSync(
        join(workdir, file),
        readFileSync(join(EXAMPLES, file), "utf8").replace(
          "source-card: h5F2EjHsRd73Dqqh8sAtd",
          "source-card: abc",
        ),
      );
      expect(validateSchema({ folder: workdir }).results).toEqual([
        {
          file,
          model: "Card",
          status: "fail",
          errors: [
            {
              path: "/dataset_query/stages/0/source-card",
              message:
                "must be an entity id: 21 characters of A-Z, a-z, 0-9, _ and -; got 3 characters",
            },
            {
              path: "/dataset_query/stages/0",
              message: 'must match "then" schema',
            },
          ],
        },
      ]);
    });

    it("counts a file's byte order mark toward the code-point limit", () => {
      mkdirSync(join(workdir, "collections"), { recursive: true });
      const statusOf = (codePoints: number) => {
        writeFileSync(
          join(workdir, "collections", "big.yaml"),
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(`a: ${"x".repeat(codePoints - 3)}`),
          ]),
        );
        return validateSchema({ folder: workdir }).results[0];
      };
      expect(statusOf(3_145_727).status).toBe("skipped");
      expect(statusOf(3_145_728)).toMatchObject({
        status: "fail",
        errors: [
          {
            path: "/",
            message:
              "invalid YAML: the document exceeds the limit of 3145728 code points (1:1)",
          },
        ],
      });
    });

    it("fails a YAML timestamp where the schema wants a map", () => {
      mkdirSync(join(workdir, "collections"), { recursive: true });
      const orders = readFileSync(
        resolve(
          import.meta.dir,
          "../examples/v1/collections/main/queries/orders_model.yaml",
        ),
        "utf8",
      );
      expect(orders).toContain("visualization_settings: {}");
      const write = (value: string) =>
        writeFileSync(
          join(workdir, "collections", "card.yaml"),
          orders.replace(
            "visualization_settings: {}",
            `visualization_settings: ${value}`,
          ),
        );
      write("{}");
      expect(validateSchema({ folder: workdir }).results[0].status).toBe("ok");
      write("2024-01-05");
      expect(validateSchema({ folder: workdir }).results[0]).toMatchObject({
        status: "fail",
        errors: [
          { path: "/visualization_settings", message: "must be object" },
        ],
      });
    });

    it("does not suggest a fresh entity id for a reference", () => {
      mkdirSync(join(workdir, "collections"), { recursive: true });
      writeFileSync(
        join(workdir, "collections", "c.yaml"),
        yaml.dump({
          name: "C",
          entity_id: "cOlArChIvE000ExAmPlx2",
          parent_id: "MissingParent",
          "serdes/meta": [{ model: "Collection" }],
        }),
      );
      const [result] = validateSchema({ folder: workdir }).results;
      expect(result).toMatchObject({
        status: "fail",
        errors: expect.arrayContaining([
          {
            path: "/parent_id",
            message:
              "must be an entity id: 21 characters of A-Z, a-z, 0-9, _ and -; got 13 characters",
          },
        ]),
      });
    });

    describe("collection namespace", () => {
      const validateCollection = (namespace: string) => {
        mkdirSync(join(workdir, "collections", "main"), { recursive: true });
        writeFileSync(
          join(workdir, "collections", "main", "reports.yaml"),
          yaml.dump({
            name: "Reports",
            entity_id: "cOlRePorTs000ExAmPlx2",
            namespace,
            "serdes/meta": [{ model: "Collection" }],
          }),
        );
        return validateSchema({ folder: workdir });
      };

      it("accepts data-actions", () => {
        expect(validateCollection("data-actions").failed).toBe(0);
      });

      it("rejects an unknown namespace", () => {
        expect(validateCollection("data_actions").failed).toBe(1);
      });
    });

    it("fails files with an unknown model", () => {
      mkdirSync(join(workdir, "collections", "main"), { recursive: true });
      writeFileSync(
        join(workdir, "collections", "main", "unknown.yaml"),
        [
          "name: Unknown",
          "serdes/meta:",
          "- id: abc",
          "  model: NotARealModel",
          "",
        ].join("\n"),
      );

      expect(validateSchema({ folder: workdir }).results).toEqual([
        {
          file: join("collections", "main", "unknown.yaml"),
          model: "NotARealModel",
          status: "fail",
          errors: [{ path: "/", message: 'unknown model "NotARealModel"' }],
        },
      ]);
    });

    it.each([
      ["a model that is not a string", "serdes/meta:\n- model: [Transform]\n"],
      ["an entry with no model", "serdes/meta:\n- id: x\n"],
      ["an empty serdes/meta", "serdes/meta: []\n"],
      ["a serdes/meta that is not a list", "serdes/meta: 5\n"],
    ])("fails a file with %s as having no model", (_, content) => {
      mkdirSync(join(workdir, "transforms"), { recursive: true });
      writeFileSync(join(workdir, "transforms", "listed.yaml"), content);

      expect(validateSchema({ folder: workdir }).results).toEqual([
        {
          file: join("transforms", "listed.yaml"),
          status: "fail",
          errors: [{ path: "/", message: "serdes/meta names no model" }],
        },
      ]);
    });

    it.each([
      ["an empty list", "[]\n"],
      ["an empty string", "''\n"],
    ])("skips a file whose YAML is %s, as Metabase does", (_, content) => {
      mkdirSync(join(workdir, "transforms"), { recursive: true });
      writeFileSync(join(workdir, "transforms", "empty.yaml"), content);

      expect(validateSchema({ folder: workdir }).results).toEqual([
        {
          file: join("transforms", "empty.yaml"),
          status: "skipped",
          warning: "Metabase skips this file because it has no serdes/meta",
        },
      ]);
    });

    it("fails a file that is a YAML list as not a map", () => {
      mkdirSync(join(workdir, "transforms"), { recursive: true });
      writeFileSync(
        join(workdir, "transforms", "listed.yaml"),
        "- serdes/meta\n",
      );

      expect(validateSchema({ folder: workdir }).results).toEqual([
        {
          file: join("transforms", "listed.yaml"),
          status: "fail",
          errors: [{ path: "/", message: "not a YAML map" }],
        },
      ]);
    });
  });
});

describe("schema errors", () => {
  const schemas = loadSchemas();
  const messages = (value: Record<string, unknown>) => {
    const check = checkSchema({ value, nonStringKeys: [] }, schemas);
    return check.status === "checked"
      ? check.errors.map((e) => `${e.path} ${e.message}`)
      : check;
  };

  it("give the values an enum or a const allows", () => {
    expect(
      messages({
        name: "T",
        expectations: [{ type: "contains" }],
        "serdes/meta": [{ model: "TransformTest" }],
      }),
    ).toContain(
      '/expectations/0/type must be equal to one of the allowed values: "equals", "empty"',
    );
    expect(
      messages({
        "serdes/meta": [{ model: "Collection" }, { model: "DataApp" }],
      }),
    ).toContain('/serdes~1meta/0/model must be equal to constant: "DataApp"');
  });
});

// Each verdict is that of Java's DateTimeFormatter built as Metabase's
// `u.date/parse` builds it (`src/metabase/util/date_2/parse.clj`).
describe("time text", () => {
  const schemas = loadSchemas();
  const status = (text: string) =>
    checkSchema({ value: { created_at: text }, nonStringKeys: [] }, schemas)
      .status;

  it.each([
    "24:00",
    "24:00:00",
    "2024-01-05T24:00",
    "2024-01-05 24:00:00.000",
    "+12024-01-05",
    "-2024-01-05",
    "+999999999-01-01",
    "10:00+18:00",
    "10:00-18:00",
    "10:00+17:59:59",
    "10:00+18",
    "10:00+0530",
    "10:00+05:30:15",
    // A day past its month's end reads as the month's last day.
    "2024-02-30",
    "2023-02-29",
    "2024-04-31",
  ])("reads %p, as Metabase does", (text) => {
    expect(status(text)).toBe("skipped");
  });

  it.each([
    "24:30",
    "24:00:01",
    "24:00:00.5",
    "+2024-01-05",
    "12024-01-05",
    "1000000-01-01",
    "-024-01-05",
    "+1000000000-01-01",
    "10:00+18:30",
    "10:00+19:00",
    "10:00-18:01",
    "10:00+19",
    "10:00+053015",
    "10:00+05:3015",
    "2024-02-32",
  ])("refuses %p, as Metabase does", (text) => {
    expect(status(text)).toBe("bad-timestamp");
  });
});

// Remote sync's git source sorts the repository's file paths as strings
// (`remote_sync/source/git.clj` `list-files`): Java's String.compareTo, by
// UTF-16 code unit over the whole path, not folder by folder or by locale.
describe("entityFiles", () => {
  it("lists files in the order of their whole paths' UTF-16 code units", () => {
    const folder = mkdtempSync(join(tmpdir(), "representations-order-"));
    try {
      const files = [
        "transforms/transform_tags/mid.yaml",
        "transforms/transform_tags/a-b.yaml",
        "collections/a/b.yaml",
        "collections/a-b.yaml",
        "collections/a.yaml",
        "collections/B.yaml",
      ];
      for (const file of files) {
        mkdirSync(join(folder, file, ".."), { recursive: true });
        writeFileSync(join(folder, file), "");
      }
      // Folder by folder, a/b.yaml would come before a-b.yaml and a.yaml;
      // by locale, a.yaml would come before B.yaml.
      expect(entityFiles(folder)).toEqual([
        "collections/B.yaml",
        "collections/a-b.yaml",
        "collections/a.yaml",
        "collections/a/b.yaml",
        "transforms/transform_tags/a-b.yaml",
        "transforms/transform_tags/mid.yaml",
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
