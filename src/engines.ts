/**
 * What a Metabase driver declares that the lint checks. The features are as
 * `driver/database-supports?` answers them: a feature a driver does not
 * declare is false (`src/metabase/driver.clj:1092-1093`), except `schemas`,
 * which is true (`src/metabase/driver.clj:1101`).
 */
export type EngineFacts = {
  /** Whether its native queries are SQL: the driver descends from `:sql`. */
  nativeSql: boolean;
  /**
   * Whether the lint takes the database's default schema as null without
   * being told, because the driver's `driver.sql/default-schema` is a fixed nil.
   */
  nullDefaultSchema: boolean;
  /** Whether the database has schemas; null when the driver decides per database. */
  schemas: boolean | null;
  /** Whether it runs a query transform. */
  "transforms/table": boolean;
  /** Whether it runs a Python transform. */
  "transforms/python": boolean;
  /** Whether it runs a transform test. */
  "transforms/testing": boolean;
};

/** A driver that declares no transform feature: all are false. */
const NO_TRANSFORMS = {
  "transforms/table": false,
  "transforms/python": false,
  "transforms/testing": false,
} as const;

/** A driver that declares every transform feature true. */
const ALL_TRANSFORMS = {
  "transforms/table": true,
  "transforms/python": true,
  "transforms/testing": true,
} as const;

// Copied from each driver on Metabase `master`; paths below are relative to
// Metabase's repository, and `modules/drivers/X` is shortened to `X`. A driver
// that is not listed is unknown to the lint. `nullDefaultSchema` is false
// unless a comment cites the driver's `default-schema`. `nativeSql` is true
// for each driver whose `driver/register!` names a parent under `:sql`
// (`:sql-jdbc`, `:postgres`, `:hive-like`, or `:sql` itself), and false for
// mongo, which registers with no parent.
const ENGINE_FACTS: Readonly<Record<string, EngineFacts>> = {
  // src/metabase/driver/postgres.clj:98-103
  postgres: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...ALL_TRANSFORMS,
  },
  // redshift/src/metabase/driver/redshift.clj:81-83; schemas from its parent, postgres
  redshift: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...ALL_TRANSFORMS,
  },
  // src/metabase/driver/mysql.clj:91, 108-110, 1370-1372
  mysql: {
    nativeSql: true,
    nullDefaultSchema: true,
    schemas: false,
    ...ALL_TRANSFORMS,
  },
  // src/metabase/driver/h2.clj:106; schemas by default
  h2: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...NO_TRANSFORMS,
    "transforms/testing": true,
  },
  // src/metabase/driver/sqlite.clj:60, 624-626; no transform feature
  sqlite: {
    nativeSql: true,
    nullDefaultSchema: true,
    schemas: false,
    ...NO_TRANSFORMS,
  },
  // mongo/src/metabase/driver/mongo.clj:53 (no parent), 535, 540; default
  // schema from the :default method, src/metabase/driver/sql/normalize.clj:57-59
  mongo: {
    nativeSql: false,
    nullDefaultSchema: true,
    schemas: false,
    ...NO_TRANSFORMS,
    "transforms/python": true,
  },
  // bigquery-cloud-sdk/src/metabase/driver/bigquery_cloud_sdk.clj:1148-1150, 1512-1514
  "bigquery-cloud-sdk": {
    nativeSql: true,
    nullDefaultSchema: true,
    schemas: true,
    ...ALL_TRANSFORMS,
    "transforms/testing": false,
  },
  // snowflake/src/metabase/driver/snowflake.clj:130-132
  snowflake: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...ALL_TRANSFORMS,
    "transforms/testing": false,
  },
  // clickhouse/src/metabase/driver/clickhouse.clj:78, 85-87
  clickhouse: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...ALL_TRANSFORMS,
  },
  // sqlserver/src/metabase/driver/sqlserver.clj:79-82
  sqlserver: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...ALL_TRANSFORMS,
  },
  // athena/src/metabase/driver/athena.clj:63-65: schemas unless the connection names a database
  athena: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: null,
    ...NO_TRANSFORMS,
  },
  // No transform feature, schemas by default: databricks/src/metabase/driver/databricks.clj,
  // druid-jdbc/src/metabase/driver/druid_jdbc.clj, oracle/src/metabase/driver/oracle.clj,
  // presto-jdbc/src/metabase/driver/presto_jdbc.clj, sparksql/src/metabase/driver/sparksql.clj,
  // starburst/src/metabase/driver/starburst.clj, vertica/src/metabase/driver/vertica.clj
  databricks: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...NO_TRANSFORMS,
  },
  "druid-jdbc": {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...NO_TRANSFORMS,
  },
  oracle: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...NO_TRANSFORMS,
  },
  "presto-jdbc": {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...NO_TRANSFORMS,
  },
  sparksql: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...NO_TRANSFORMS,
  },
  starburst: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...NO_TRANSFORMS,
  },
  vertica: {
    nativeSql: true,
    nullDefaultSchema: false,
    schemas: true,
    ...NO_TRANSFORMS,
  },
};

/** What the driver named `engine` declares; null for an engine the lint does not know, or none. */
export function engineFacts(engine: string | null): EngineFacts | null {
  return engine !== null && Object.hasOwn(ENGINE_FACTS, engine)
    ? ENGINE_FACTS[engine]
    : null;
}

/**
 * Whether the native queries of a database whose engine is `engine` are SQL:
 * true unless the engine's driver says otherwise, so an unknown engine's
 * queries are read as SQL.
 */
export function nativeQueriesAreSql(engine: string | null): boolean {
  return engineFacts(engine)?.nativeSql !== false;
}
