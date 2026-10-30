import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
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

import { loadSchemas } from "./schemas.js";
import { IMPORTED_MODELS, validateSchema } from "./validate-schema.js";

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

      it("follows no symbolic link to a folder, and follows one to a file", () => {
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
            "collections/file.yaml Collection ok",
            "collections/real/real.yaml Collection ok",
          ]);
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      });

      it("matches folder and file names in their exact case, as Metabase does", () => {
        write("collections/Upper.YAML", collection);
        write("TRANSFORMS/t.yaml", collection);
        write("data_apps/shop/DATA_APP.yaml", collection);
        write("collections/lower.yaml", collection);

        expect(statuses()).toEqual(["collections/lower.yaml Collection ok"]);
      });

      it("skips a symbolic link to nothing, which is not a regular file", () => {
        write("collections/real.yaml", collection);
        symlinkSync(
          join(workdir, "nonexistent.yaml"),
          join(workdir, "collections", "broken.yaml"),
        );

        expect(statuses()).toEqual(["collections/real.yaml Collection ok"]);
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
      const example = yaml.load(
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
      ) as Record<string, any>; // The example transform test is a YAML map.

      const validateTransformTest = (transformTest: Record<string, any>) => {
        mkdirSync(join(workdir, "collections", "transforms"), {
          recursive: true,
        });
        writeFileSync(
          join(workdir, "collections", "transforms", "test.yaml"),
          yaml.dump(transformTest),
        );
        return validateSchema({ folder: workdir });
      };

      const [rowsInput, sqlInput] = example.inputs;
      const [equals, empty] = example.expectations;

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
      "fails a file of model %s, which Metabase loads from no file of its own, as an unknown model",
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

      it("fails a time in a zone that does not exist", () => {
        expect(
          resultOf(["name: Notes", "created_at: '2024-01-05 Nowhere/Land'"])
            .status,
        ).toBe("fail");
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
      ["a list in place of a map", "- serdes/meta\n"],
    ])("fails a file with %s as having no model", (_, content) => {
      mkdirSync(join(workdir, "transforms"), { recursive: true });
      writeFileSync(join(workdir, "transforms", "listed.yaml"), content);

      expect(validateSchema({ folder: workdir }).results).toEqual([
        {
          file: join("transforms", "listed.yaml"),
          status: "fail",
          errors: [{ path: "/", message: "missing serdes/meta or model" }],
        },
      ]);
    });
  });
});
