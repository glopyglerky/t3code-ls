#!/usr/bin/env python3
"""Plan fork integration and Rust port work from immutable, trusted upstream source."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import difflib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import nightly


POLICY_FILES = {"AGENTS.md", "CLAUDE.md", "README.md", "upstream-README.md", "LICENSE"}
POLICY_PREFIXES = (".github/", ".agents/", ".claude/", ".cursor/", ".repos/", "tools/")
PERSISTENCE_PREFIX = "apps/server/src/persistence/"
PERSISTENCE_CONSUMERS = {
    "apps/server/src/issue/linkedThreads.ts",
    "apps/server/src/orchestration-v2/ThreadIssueService.ts",
    "apps/server/src/workspace/TaskFolderStore.ts",
}
BOUNDARY_FILES = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs",
                  "Cargo.toml", "Cargo.lock", "tsconfig.base.json", "tsconfig.effect.json",
                  "vite.config.ts"}
ACCEPTED = {"accepted", "retired", "synced"}
RUST_ROUTES = {"rust", "rust-backed-client"}


def bounded_git(root: Path, *args: str, missing_ok: bool = False) -> bytes | None:
    try:
        result = subprocess.run(
            ["git", "--no-replace-objects", "-C", str(root), *args], check=False, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=60,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise nightly.TrackingError(f"git {args[0]} did not complete.") from error
    if result.returncode:
        if missing_ok:
            return None
        # Never include Git stderr, which can contain transport credentials.
        raise nightly.TrackingError(f"git {args[0]} failed.")
    return result.stdout


def parse_default_advertisement(raw: bytes) -> dict:
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeError as error:
        raise nightly.TrackingError("Invalid upstream HEAD advertisement.") from error
    branch, commit = None, None
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 2 or fields[1] != "HEAD":
            raise nightly.TrackingError("Unexpected upstream HEAD advertisement.")
        value = fields[0]
        if value.startswith("ref: refs/heads/"):
            if branch is not None:
                raise nightly.TrackingError("Ambiguous upstream default branch.")
            branch = nightly.require_relative_path(value.removeprefix("ref: refs/heads/"))
        else:
            if commit is not None:
                raise nightly.TrackingError("Ambiguous upstream HEAD commit.")
            commit = nightly.require_sha(value)
    if branch is None or commit is None:
        raise nightly.TrackingError("Upstream must advertise both its default branch and exact HEAD commit.")
    return {"repository": nightly.REPOSITORY, "branch": branch, "commit": commit,
            "selection": "advertised-default-branch"}


def resolve_default(root: Path) -> dict:
    return parse_default_advertisement(
        bounded_git(root, "ls-remote", "--symref", nightly.REMOTE, "HEAD"),
    )


def ensure_metadata(root: Path, commit: str, fetch: bool) -> None:
    nightly.require_sha(commit)
    kind = bounded_git(root, "cat-file", "-t", commit, missing_ok=True)
    if kind is None and fetch:
        bounded_git(root, "-c", "core.hooksPath=/dev/null", "fetch", "--filter=blob:none",
                    "--no-tags", "--no-write-fetch-head", "--depth=1", nightly.REMOTE, commit)
        kind = bounded_git(root, "cat-file", "-t", commit)
    if kind is None:
        raise nightly.TrackingError(f"Missing immutable source {commit}; fetch it before an offline plan.")
    if kind.strip() != b"commit":
        raise nightly.TrackingError("A source identity does not name a commit.")


def committed_metadata(root: Path, fork: str, path: str) -> dict:
    raw = bounded_git(root, "show", f"{fork}:{path}")
    try:
        # port_impact reads the checkout map; bind that read to the same committed input.
        if (root / path).read_bytes() != raw:
            raise nightly.TrackingError(f"Commit {path} before generating an immutable porting plan.")
        value = json.loads(raw)
    except (OSError, ValueError) as error:
        raise nightly.TrackingError(f"Could not read committed {path}.") from error
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise nightly.TrackingError(f"Unsupported {path} schema.")
    return value


def port_requirements(port: dict, targets: list[str]) -> dict:
    routes = {}
    compiler_routes = set()
    for route in port.get("platform_routes", []):
        if not isinstance(route, dict) or not isinstance(route.get("targets"), list):
            raise nightly.TrackingError("Invalid port platform route.")
        if route.get("implementation") in RUST_ROUTES:
            compiler_routes.add(route.get("compiler_route", "unspecified"))
        for target in route["targets"]:
            if target not in targets or target in routes:
                raise nightly.TrackingError("Unknown or duplicate port platform route.")
            routes[target] = route
    missing_rust, missing_receipts, unaccepted = [], [], []
    for target in targets:
        route = routes.get(target, {})
        if route.get("implementation") not in RUST_ROUTES:
            missing_rust.append(target)
        if not route.get("acceptance_evidence", {}).get(target):
            missing_receipts.append(target)
        if route.get("state") not in ACCEPTED:
            unaccepted.append(target)
    result = {}
    for key in ("rust_paths", "rust_crates", "acceptance_tests"):
        values = port.get(key)
        if not isinstance(values, list):
            raise nightly.TrackingError(f"Port {port['id']} requires {key}.")
        result[key] = sorted({nightly.require_relative_path(value) for value in values})
    return {**result, "compiler_routes": sorted(compiler_routes),
            "retirement": {"automatic": False, "missing_rust_targets": missing_rust,
                           "missing_receipt_targets": missing_receipts,
                           "unaccepted_targets": unaccepted,
                           "receipt_validity": "Not evaluated here; check-source must validate current evidence."}}


def classify(path: str, before: dict | None, after: dict | None, fork: dict | None,
             owners: list[str]) -> str:
    if owners:
        return "translation-review"
    if path in POLICY_FILES or path.startswith(POLICY_PREFIXES):
        return "fork-policy-review"
    if after is None:
        return "upstream-removal-review"
    if fork == after:
        return "already-matches-upstream"
    if fork != before:
        return "fork-conflict"
    if (path in BOUNDARY_FILES or path.startswith("patches/")
            or path.endswith(("/package.json", "/Cargo.toml"))):
        return "integration-boundary-review"
    return "mechanical-import-candidate"


def build_plan(root: Path, upstream: dict) -> dict:
    if upstream.get("repository") != nightly.REPOSITORY:
        raise nightly.TrackingError("Unexpected trusted upstream repository.")
    fork = nightly.require_sha(bounded_git(root, "rev-parse", "HEAD").decode().strip())
    mapping = committed_metadata(root, fork, "port-map.json")
    lock = committed_metadata(root, fork, "upstream.lock.json")
    if lock.get("upstream", {}).get("repository") != nightly.REPOSITORY:
        raise nightly.TrackingError("Unexpected integrated upstream repository.")
    base = nightly.require_sha(lock["upstream"].get("commit"))
    head = nightly.require_sha(upstream.get("commit"))
    before, after, fork_tree = (nightly.read_tree(root, commit) for commit in (base, head, fork))
    actual_base_tree = bounded_git(root, "rev-parse", f"{base}^{{tree}}").decode().strip()
    if actual_base_tree != lock["upstream"].get("root_tree"):
        raise nightly.TrackingError("Integrated upstream root tree does not match its pin.")
    changes = [{"path": path, "status": "added" if path not in before else
                "removed" if path not in after else "modified", "before": before.get(path),
                "after": after.get(path), "fork": fork_tree.get(path)}
               for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path)]
    impact = nightly.port_impact(root, base, changes)
    if impact["status"] != "mapped":
        raise nightly.TrackingError("A validated port map is required for porting work selection.")
    ports = mapping["ports"]
    targets = mapping.get("supported_targets")
    if (not isinstance(targets, list) or not targets or any(not isinstance(x, str) for x in targets)
            or len(set(targets)) != len(targets)):
        raise nightly.TrackingError("Port map requires unique supported targets.")
    owners = defaultdict(set)
    for port in ports:
        for source in port["upstream_sources"] + port.get("retired_paths", []):
            owners[source["path"]].add(port["id"])
        for path in port.get("adapter_paths", []):
            owners[path].add(port["id"])
    port_ids = {port["id"] for port in ports}
    removed_by_object = defaultdict(list)
    for change in changes:
        path = change["path"]
        if path.startswith("packages/contracts/"):
            owners[path].update(port_ids)
        # New persistence files have no upstream_sources entry yet. They may
        # change the native schema or require another adapter at startup.
        if "redb-persistence" in port_ids and (
            path.startswith(PERSISTENCE_PREFIX) or path in PERSISTENCE_CONSUMERS
        ):
            owners[path].add("redb-persistence")
        if change["status"] == "removed":
            source = change["before"]
            removed_by_object[(source["mode"], source["kind"], source["oid"])].append(change["path"])
    for change in changes:
        path = change["path"]
        matching_old_paths = []
        if change["status"] == "added":
            source = change["after"]
            matching_old_paths = removed_by_object.get((source["mode"], source["kind"], source["oid"]), [])
            for old in matching_old_paths:
                owners[path].update(owners[old])
        change["ports"] = sorted(owners[path])
        change["possible_rename_sources"] = sorted(matching_old_paths)
        change["classification"] = classify(path, change["before"], change["after"], change["fork"], change["ports"])
    queue = []
    shared_contracts = impact["shared_contract_paths"]
    for port in sorted(ports, key=lambda item: item["id"]):
        paths = [change["path"] for change in changes if port["id"] in change["ports"]]
        requirements = port_requirements(port, targets)
        if paths:
            priority, action = 10, "adapt-rust-to-upstream"
        elif port["state"] == "candidate":
            priority, action = 50, "integrate-candidate-port"
        elif (port["state"] not in ACCEPTED or requirements["retirement"]["unaccepted_targets"]
              or requirements["retirement"]["missing_rust_targets"]
              or requirements["retirement"]["missing_receipt_targets"]):
            priority, action = 40, "qualify-integrated-port"
        else:
            continue
        queue.append({"id": f"port:{port['id']}", "priority": priority, "action": action,
                      "port": port["id"], "state": port["state"], "domain_owner": port["domain_owner"],
                      "upstream_paths": paths, "shared_contract_paths": shared_contracts if paths else [],
                      "blocks_upstream_integration": bool(paths), **requirements})
    for category, priority, action in [
        ("fork-conflict", 20, "resolve-fork-conflicts"),
        ("fork-policy-review", 20, "preserve-fork-policy"),
        ("upstream-removal-review", 20, "record-upstream-removals"),
        ("integration-boundary-review", 20, "check-fork-integration-boundaries"),
        ("mechanical-import-candidate", 30, "integrate-trusted-upstream-files"),
    ]:
        paths = [change["path"] for change in changes if change["classification"] == category]
        if paths:
            queue.append({"id": f"upstream:{category}", "priority": priority, "action": action,
                          "upstream_paths": paths, "blocks_upstream_integration": True})
    queue.sort(key=lambda item: (item["priority"], item["id"]))
    return {
        "schema_version": 1,
        "status": "current" if base == head else "update-available",
        "upstream": upstream,
        "trust": {"upstream_working": True, "authority": "user-policy",
                  "upstream_tests_required": False,
                  "fork_validation": "Validate Rust replacements and changed integration boundaries."},
        "revisions": {"integrated_upstream": base, "trusted_upstream": head, "fork": fork,
                      "qualified_upstream": lock.get("qualification", {}).get("last_qualified_commit")},
        "source_inputs": "Committed Git trees and committed port map; uncommitted source is excluded.",
        "classification_counts": dict(sorted(Counter(change["classification"] for change in changes).items())),
        "changed_file_count": len(changes), "changes": changes, "queue": queue,
        "automation": {"source_writes": False, "pin_updates": False, "acceptance_promotion": False,
                       "retirement": False, "provider_requests": False,
                       "mechanical_imports": "Candidates only; integrate the complete change with the listed fork work."},
    }


def mechanical_metadata_patch(
    root: Path, plan: dict, reviewed_translations: dict[str, str] | None = None,
) -> str:
    """Render metadata for an exact staged merge and explicitly reviewed translations."""
    reviewed_translations = reviewed_translations or {}
    revisions = plan["revisions"]
    fork = revisions["fork"]
    base = revisions["integrated_upstream"]
    head = revisions["trusted_upstream"]
    merge_head = root / bounded_git(root, "rev-parse", "--git-path", "MERGE_HEAD").decode().strip()
    if base == head or not merge_head.is_file() or merge_head.read_bytes() != f"{head}\n".encode():
        raise nightly.TrackingError("Stage a merge from the exact planned upstream revision.")
    bounded_git(root, "merge-base", "--is-ancestor", base, head)
    if bounded_git(root, "diff", "--name-only", "-z"):
        raise nightly.TrackingError("Resolve all unstaged changes before preparing merge metadata.")

    expected = nightly.read_tree(root, fork)
    translations = {}
    for change in plan["changes"]:
        path = change["path"]
        entry = change["after"]
        category = change["classification"]
        if entry is None or entry["mode"] not in {"100644", "100755"}:
            raise nightly.TrackingError("The upstream change requires explicit source review.")
        if category == "translation-review" and path in reviewed_translations:
            before = change["before"]
            if before is None:
                raise nightly.TrackingError("A new port source needs explicit metadata review.")
            translations[path] = (before["oid"], entry["oid"])
            expected[path] = {**entry, "oid": nightly.require_sha(reviewed_translations[path])}
        elif category in {"mechanical-import-candidate", "already-matches-upstream"}:
            expected[path] = entry
        else:
            raise nightly.TrackingError("The upstream change requires explicit source review.")
    if set(translations) != set(reviewed_translations):
        raise nightly.TrackingError("A reviewed path is not a translation in this upstream merge.")
    staged = bounded_git(root, "write-tree").decode().strip()
    if nightly.read_tree(root, staged) != expected:
        raise nightly.TrackingError("The staged merge differs from the planned upstream source.")

    lock_path = "upstream.lock.json"
    map_path = "port-map.json"
    lock = committed_metadata(root, fork, lock_path)
    mapping = committed_metadata(root, fork, map_path)
    history = mapping.get("source_history")
    if (not isinstance(history, list) or not history or history[-1] != base or head in history
            or mapping.get("integrated_upstream_commit") != base
            or any(port.get("reviewed_upstream_commit") != base for port in mapping["ports"])):
        raise nightly.TrackingError("The port map needs explicit source history review.")

    next_lock = nightly.manifest(root, {
        **lock["upstream"], "commit": head,
        "source_url": f"https://github.com/pingdotgg/t3code/commit/{head}",
    }, head)
    old_map = (root / map_path).read_text()
    updated_map, replacements = re.subn(
        rf'("(?:integrated_upstream_commit|reviewed_upstream_commit)"\s*:\s*)"{base}"',
        lambda match: f'{match[1]}"{head}"', old_map,
    )
    updated_map, history_replacements = re.subn(
        rf'("source_history"\s*:\s*\[[^\]]*?)(\s*)"{base}"(\s*\])',
        lambda match: f'{match[1]}{match[2]}"{base}",{match[2]}"{head}"{match[3]}',
        updated_map, count=1,
    )
    mapping["integrated_upstream_commit"] = head
    history.append(head)
    for port in mapping["ports"]:
        port["reviewed_upstream_commit"] = head
        for source in port["upstream_sources"]:
            path = source["path"]
            if path in translations and "source_commit" not in source:
                before, after = translations[path]
                if source["blob"] != before:
                    raise nightly.TrackingError("A translated port source has an unexpected prior blob.")
                source["blob"] = after
    for path, (before, after) in translations.items():
        quoted_path = re.escape(json.dumps(path))
        updated_map = re.sub(
            rf'("path"\s*:\s*{quoted_path},\s*"blob"\s*:\s*)"{before}"(?=\s*}})',
            lambda match: f'{match[1]}"{after}"',
            updated_map,
        )
    if (replacements != len(mapping["ports"]) + 1 or history_replacements != 1
            or json.loads(updated_map) != mapping):
        raise nightly.TrackingError("Could not preserve the port map while updating its pins.")

    # Match the repository formatter's compact one-item prefix arrays so a
    # generated merge passes the same hook when reapplied from its first parent.
    updated_lock = re.sub(
        r'^([ ]+"path_prefixes": )\[\n +("[^"\n]*")\n +\],$',
        r"\1[\2],",
        json.dumps(next_lock, indent=2, ensure_ascii=True),
        flags=re.MULTILINE,
    )
    updates = {lock_path: updated_lock + "\n", map_path: updated_map}
    return "".join(
        line for path, updated in updates.items()
        for line in difflib.unified_diff(
            (root / path).read_text().splitlines(keepends=True),
            updated.splitlines(keepends=True), fromfile=f"a/{path}", tofile=f"b/{path}",
        )
    )


def markdown_summary(plan: dict) -> str:
    revisions = plan["revisions"]
    counts = plan["classification_counts"]
    lines = ["## Rust porting queue", "",
             f"Trusted upstream `{revisions['trusted_upstream']}`; integrated `{revisions['integrated_upstream']}`.",
             "Upstream is trusted as working. Checks target Rust replacements and fork integration.", "",
             f"Compared {plan['changed_file_count']} upstream paths across three immutable trees.", "",
             "| Classification | Paths |", "| --- | ---: |"]
    lines.extend(f"| {category} | {count} |" for category, count in counts.items())
    lines.extend(["", "| Priority | Work | Changed paths |", "| ---: | --- | ---: |"])
    lines.extend(f"| {item['priority']} | {item['id']}: {item['action']} | {len(item['upstream_paths'])} |"
                 for item in plan["queue"])
    lines.extend(["", "The JSON artifact contains exact source identities, Rust owners, tests, compiler routes,",
                  "and missing platform receipts. This plan does not change source, pins, acceptance, or retire files.", ""])
    return "\n".join(lines)


def output_path(root: Path, path: Path) -> Path:
    resolved = path.resolve()
    if resolved == root or root in resolved.parents:
        raise nightly.TrackingError("Porting reports must be outside the source checkout.")
    return resolved


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--upstream-commit", help="Already-fetched immutable snapshot of trusted upstream.")
    selection.add_argument("--fetch-default", action="store_true", help="Resolve default HEAD once and fetch immutable tree metadata.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, help="Optional Markdown job summary outside source.")
    parser.add_argument("--mechanical-metadata-patch", type=Path,
                        help="Write a Git patch for an exact staged merge's metadata.")
    parser.add_argument("--reviewed-translation", action="append", default=[], metavar="PATH=STAGED_BLOB",
                        help="Bind a manually reviewed translation to the exact staged blob.")
    args = parser.parse_args(argv)
    try:
        root = args.repo_root.resolve()
        destination = output_path(root, args.output)
        summary = output_path(root, args.summary) if args.summary else None
        patch_path = (output_path(root, args.mechanical_metadata_patch)
                      if args.mechanical_metadata_patch else None)
        outputs = [path for path in (destination, summary, patch_path) if path is not None]
        if len(outputs) != len(set(outputs)):
            raise nightly.TrackingError("Porting reports and the metadata patch need different files.")
        fork = nightly.require_sha(bounded_git(root, "rev-parse", "HEAD").decode().strip())
        lock = committed_metadata(root, fork, "upstream.lock.json")
        base = nightly.require_sha(lock.get("upstream", {}).get("commit"))
        upstream = resolve_default(root) if args.fetch_default else {
            "repository": nightly.REPOSITORY, "branch": None,
            "commit": nightly.require_sha(args.upstream_commit), "selection": "explicit-immutable-commit",
        }
        for commit in dict.fromkeys([base, upstream["commit"]]):
            ensure_metadata(root, commit, args.fetch_default)
        plan = build_plan(root, upstream)
        reviewed_translations = {}
        for review in args.reviewed_translation:
            path, separator, blob = review.rpartition("=")
            if not patch_path or not separator or not path or path in reviewed_translations:
                raise nightly.TrackingError("Review each translation once using PATH=STAGED_BLOB and a metadata patch.")
            reviewed_translations[path] = nightly.require_sha(blob)
        metadata_patch = (mechanical_metadata_patch(root, plan, reviewed_translations)
                          if patch_path else None)
        nightly.write_json(destination, plan)
        if patch_path:
            patch_path.parent.mkdir(parents=True, exist_ok=True)
            patch_path.write_text(metadata_patch)
        if summary:
            summary.parent.mkdir(parents=True, exist_ok=True)
            summary.write_text(markdown_summary(plan))
        print(json.dumps({"status": plan["status"], "trusted_upstream": upstream["commit"],
                          "changed_file_count": plan["changed_file_count"],
                          "queue_items": len(plan["queue"])}))
        return 0
    except (nightly.TrackingError, OSError) as error:
        print(f"Porting plan failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
