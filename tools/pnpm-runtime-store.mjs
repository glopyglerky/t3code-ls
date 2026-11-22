import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

function within(parent, child) {
  const relative = NodePath.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

// Bootstrap cannot import yaml until the application's own yaml instance is linked.
function storeReference(metadata) {
  const text = metadata.toString("utf8");
  let reference;
  try {
    reference = JSON.parse(text)?.virtualStoreDir;
  } catch {
    const entries = [...text.matchAll(/^virtualStoreDir:\s*(.+)$/gm)];
    NodeAssert.equal(entries.length, 1, "Expected one configured pnpm virtual store");
    reference = entries[0][1].trim();
    if (reference.startsWith('"')) reference = JSON.parse(reference);
    else if (reference.startsWith("'")) {
      NodeAssert.ok(reference.endsWith("'"), "Invalid pnpm virtual store scalar");
      reference = reference.slice(1, -1).replaceAll("''", "'");
    }
  }
  NodeAssert.ok(
    typeof reference === "string" && reference.length > 0 && !/[\0\r\n]/.test(reference),
    "Missing configured pnpm virtual store",
  );
  return reference;
}

export async function resolvePnpmVirtualStore(directory) {
  const checkout = await NodeFSP.realpath(directory);
  const modules = await NodeFSP.realpath(NodePath.join(checkout, "node_modules"));
  NodeAssert.ok(within(checkout, modules), "Use the workspace installation inside this checkout");
  const metadata = await NodeFSP.readFile(NodePath.join(modules, ".modules.yaml"));
  const declared = NodePath.resolve(modules, storeReference(metadata));
  const virtualStore = await NodeFSP.realpath(declared);
  if (declared === modules || within(modules, declared)) {
    NodeAssert.ok(
      within(modules, virtualStore),
      "The declared internal pnpm store resolves outside node_modules",
    );
  }
  await NodeFSP.access(NodePath.join(virtualStore, "lock.yaml"));
  return { checkout, modules, virtualStore, metadata };
}
