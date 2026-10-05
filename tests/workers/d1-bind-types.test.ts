/**
 * What the real D1 binding accepts and refuses in `.bind()`, run in workerd.
 *
 * The unit suite runs the same assertions against its in-memory fake
 * (`tests/d1-memory-bind-parity.test.ts`); this file is what ties them to D1
 * itself.
 *
 * @version v1.5.0-beta
 */

import { env } from "cloudflare:workers";

import { describeD1Binds } from "../helpers/d1-bind-cases";

describeD1Binds("D1 in workerd", () => env.DB);
