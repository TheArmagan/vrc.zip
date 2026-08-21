/**
 * Migrations are imported as text so the shipped bundle carries the SQL inline and never reads
 * `.sql` files off disk. Bun understands `with { type: "text" }`; this tells `tsc` the same.
 */
declare module "*.sql" {
  const sql: string;
  export default sql;
}
