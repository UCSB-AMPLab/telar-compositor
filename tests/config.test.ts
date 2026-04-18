// Stubs — config save round-trip, lang allowlist
import { describe, it } from "vitest";

describe("config save action", () => {
  it.todo("form submit with lang='es' writes lang='es' to project_config in D1");
  it.todo("form submit with include_demo_content='true' writes true to project_config in D1");
  it.todo("form submit with include_demo_content='false' writes false to project_config in D1");
  it.todo("after save, loader returns the new lang value on next GET");
  it.todo("lang value outside allowlist ['en','es'] is rejected before D1 write");
  it.todo("invalid lang returns a form error, not a 500");
  it.todo("i18n.changeLanguage is triggered on the client after successful lang save");
});
