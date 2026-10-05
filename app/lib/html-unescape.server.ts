/**
 * Installs `entities`' HTML5 decoder as html-unescape's decoder for named
 * references where there is no document. Importing this module is what makes a
 * server render decode every name as Python's `html.unescape` does; the client
 * never imports it, so the entity table stays out of the client bundle.
 *
 * @version v1.5.0-beta
 */

import { decodeHTML } from "entities/decode";
import { setNamedDecoder } from "~/lib/html-unescape";

setNamedDecoder(decodeHTML);
