/**
 * The in-memory D1 fake accepts and refuses bound values as D1 does.
 *
 * `tests/workers/d1-bind-types.test.ts` runs the same assertions against the
 * real binding inside workerd, so the two cannot drift apart without one of
 * them failing.
 *
 * @version v1.5.0-beta
 */

import { afterAll } from "vitest";

import { asD1, createMemoryD1 } from "./helpers/d1-memory";
import { describeD1Binds } from "./helpers/d1-bind-cases";

const memory = createMemoryD1();
afterAll(() => memory.close());

describeD1Binds("the in-memory fake", () => asD1(memory));
