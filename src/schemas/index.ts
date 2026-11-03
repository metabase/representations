import type { JsonObject } from "../json.js";
import { actionSchema } from "./action.js";
import { cardSchema } from "./card.js";
import { channelSchema } from "./channel.js";
import { collectionSchema } from "./collection.js";
import { idSchema } from "./common/id.js";
import { parameterSchema } from "./common/parameter.js";
import { querySchema } from "./common/query.js";
import { refSchema } from "./common/ref.js";
import { temporalBucketingSchema } from "./common/temporal-bucketing.js";
import { dashboardSchema } from "./dashboard.js";
import { dataAppSchema } from "./data-app.js";
import { databaseSchema } from "./database.js";
import { documentSchema } from "./document.js";
import { fieldUserSettingsSchema } from "./field-user-settings.js";
import { fieldValuesSchema } from "./field-values.js";
import { fieldSchema } from "./field.js";
import { glossarySchema } from "./glossary.js";
import { toInstanceSchemas } from "./instance.js";
import { measureSchema } from "./measure.js";
import { metabotSchema } from "./metabot.js";
import { pythonLibrarySchema } from "./python-library.js";
import { segmentSchema } from "./segment.js";
import { snippetSchema } from "./snippet.js";
import { tableSchema } from "./table.js";
import { timelineSchema } from "./timeline.js";
import { transformJobSchema } from "./transform-job.js";
import { transformTagSchema } from "./transform-tag.js";
import { transformTestSchema } from "./transform-test.js";
import { transformSchema } from "./transform.js";

/**
 * JSON Schemas of the portable format, keyed by the name their `$ref`s use,
 * such as `card.json` or `common/query.json`.
 */
export const portableSchemas: Readonly<Record<string, JsonObject>> = {
  "action.json": actionSchema,
  "card.json": cardSchema,
  "channel.json": channelSchema,
  "collection.json": collectionSchema,
  "dashboard.json": dashboardSchema,
  "data_app.json": dataAppSchema,
  "database.json": databaseSchema,
  "document.json": documentSchema,
  "field.json": fieldSchema,
  "field_user_settings.json": fieldUserSettingsSchema,
  "field_values.json": fieldValuesSchema,
  "glossary.json": glossarySchema,
  "measure.json": measureSchema,
  "metabot.json": metabotSchema,
  "python_library.json": pythonLibrarySchema,
  "segment.json": segmentSchema,
  "snippet.json": snippetSchema,
  "table.json": tableSchema,
  "timeline.json": timelineSchema,
  "transform.json": transformSchema,
  "transform_job.json": transformJobSchema,
  "transform_tag.json": transformTagSchema,
  "transform_test.json": transformTestSchema,
  "common/id.json": idSchema,
  "common/parameter.json": parameterSchema,
  "common/query.json": querySchema,
  "common/ref.json": refSchema,
  "common/temporal_bucketing.json": temporalBucketingSchema,
};

/**
 * JSON Schemas of the instance format: the portable schemas with every
 * foreign key a numeric instance id, keyed like {@link portableSchemas}.
 */
export const instanceSchemas: Readonly<Record<string, JsonObject>> =
  toInstanceSchemas(portableSchemas);
