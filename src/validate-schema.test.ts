import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { validateSchema } from "./validate-schema.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

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

    it("fails files missing serdes/meta", () => {
      mkdirSync(join(workdir, "collections", "main"), { recursive: true });
      writeFileSync(
        join(workdir, "collections", "main", "broken.yaml"),
        "name: Broken\n",
      );

      const { passed, failed, results } = validateSchema({ folder: workdir });
      expect(passed).toBe(0);
      expect(failed).toBe(1);
      expect(results[0].status).toBe("fail");
      if (results[0].status === "fail") {
        expect(results[0].errors[0].message).toMatch(/serdes\/meta/);
      }
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
      writeFileSync(join(workdir, ...dirs, file), "name: Broken\n");

      const { failed, results } = validateSchema({ folder: workdir });
      expect(failed).toBe(1);
      expect(results[0].file).toBe(join(...dirs, file));
    });

    describe("actions", () => {
      const example = (file: string): Record<string, unknown> =>
        yaml.load(
          readFileSync(
            join(EXAMPLES, "collections", "main", "queries", file),
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

      const { failed, results } = validateSchema({ folder: workdir });
      expect(failed).toBe(1);
      if (results[0].status === "fail") {
        expect(results[0].errors[0].message).toMatch(/unknown model/);
      }
    });
  });
});
