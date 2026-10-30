/** A table as a query names it: its schema, if the name is qualified, and its name. */
export type TableName = {
  schema: string | null;
  name: string;
};
