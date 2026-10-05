/**
 * Route modules export only React Router route members. Any other export
 * breaks the route module contract and the build's per-route code splitting.
 * Exports are read from the parsed module, so `export { a, b }`, re-exports
 * and multi-line declarations are all seen.
 *
 * The allowed names are the ones @react-router/dev recognises as route
 * exports (SERVER_ONLY_ROUTE_EXPORTS and CLIENT_ROUTE_EXPORTS in its vite
 * plugin, react-router 7.12).
 *
 * @version v1.5.0-beta
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const APP_DIR = path.resolve(__dirname, "../app");
const ROUTES_DIR = path.join(APP_DIR, "routes");
const ROOT_MODULE = path.join(APP_DIR, "root.tsx");

const ROUTE_MEMBERS = new Set([
  "default",
  "loader",
  "action",
  "middleware",
  "headers",
  "clientLoader",
  "clientAction",
  "clientMiddleware",
  "handle",
  "meta",
  "links",
  "shouldRevalidate",
  "ErrorBoundary",
  "HydrateFallback",
]);

// `Layout` wraps the document, so only the root route module may export it.
const ROOT_ONLY_MEMBERS = new Set(["Layout"]);

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind)
    : false;
}

/** Every name a binding introduces, through object and array patterns of any depth. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) =>
    ts.isOmittedExpression(el) ? [] : bindingNames(el.name),
  );
}

function exportedDeclarationNames(node: ts.Node): string[] {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((d) => bindingNames(d.name));
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)) &&
    node.name
  ) {
    return [node.name.text];
  }
  return [];
}

function valueExportsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names: string[] = [];
  for (const node of source.statements) {
    if (ts.isExportAssignment(node)) {
      names.push("default");
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) continue;
      if (!node.exportClause) names.push("*");
      else if (ts.isNamespaceExport(node.exportClause)) names.push(node.exportClause.name.text);
      else {
        for (const el of node.exportClause.elements) {
          if (!el.isTypeOnly) names.push(el.name.text);
        }
      }
    } else if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) names.push("default");
      else names.push(...exportedDeclarationNames(node));
    }
  }
  return names;
}

describe("route modules", () => {
  const files = [
    ...readdirSync(ROUTES_DIR)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => path.join(ROUTES_DIR, f)),
    ROOT_MODULE,
  ];

  it("finds the route modules", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("export only React Router route members", () => {
    const offenders = files.flatMap((f) =>
      valueExportsOf(f)
        .filter(
          (name) =>
            !ROUTE_MEMBERS.has(name) && !(f === ROOT_MODULE && ROOT_ONLY_MEMBERS.has(name)),
        )
        .map((name) => `${path.relative(path.dirname(APP_DIR), f)}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });
});
