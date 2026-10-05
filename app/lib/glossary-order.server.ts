/**
 * The order glossary.csv is written in: the document's order, `order_key`
 * ascending, then `id`, which is the order the collaboration room seeds the
 * glossary array in (`buildFromD1Rows`) and so the order the previews read.
 * Where ids share a published address the build keeps the first in the file,
 * so a publish that reads the rows in any other order can keep a different id
 * from the one the preview shows.
 *
 * @version v1.5.0-beta
 */

import { sql } from "drizzle-orm";
import { glossary_terms } from "~/db/schema";

export function glossarySheetOrder() {
  return sql`${glossary_terms.order_key} asc, ${glossary_terms.id} asc`;
}
