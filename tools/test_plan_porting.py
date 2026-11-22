"""Offline tests for immutable upstream work selection and porting readiness."""

import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location("plan_porting", Path(__file__).with_name("plan-porting.py"))
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


class DefaultBranchSelection(unittest.TestCase):
    def test_default_branch_is_resolved_with_its_exact_immutable_commit(self):
        sha = "a" * 40
        result = planner.parse_default_advertisement(f"ref: refs/heads/main\tHEAD\n{sha}\tHEAD\n".encode())
        self.assertEqual(result, {"repository": "pingdotgg/t3code", "branch": "main", "commit": sha,
                                  "selection": "advertised-default-branch"})
        for advertisement in [f"{sha}\tHEAD\n", "ref: refs/heads/main\tHEAD\n",
                              f"ref: refs/tags/main\tHEAD\n{sha}\tHEAD\n",
                              f"ref: refs/heads/main\tHEAD\n{'A' * 40}\tHEAD\n",
                              f"ref: refs/heads/main\tHEAD\n{sha}\tHEAD\n{sha}\tHEAD\n",
                              f"ref: refs/heads/../main\tHEAD\n{sha}\tHEAD\n"]:
            with self.subTest(advertisement=advertisement), self.assertRaises(planner.nightly.TrackingError):
                planner.parse_default_advertisement(advertisement.encode())

    def test_metadata_fetch_uses_only_the_pinned_upstream_commit(self):
        sha = "a" * 40
        with patch.object(planner, "bounded_git", side_effect=[None, b"", b"commit\n"]) as git:
            planner.ensure_metadata(Path("/fixture"), sha, True)
        self.assertEqual(git.call_args_list[1].args,
                         (Path("/fixture"), "-c", "core.hooksPath=/dev/null", "fetch", "--filter=blob:none",
                          "--no-tags", "--no-write-fetch-head", "--depth=1", planner.nightly.REMOTE, sha))
        with patch.object(planner, "bounded_git", return_value=None) as git:
            with self.assertRaisesRegex(planner.nightly.TrackingError, "before an offline plan"):
                planner.ensure_metadata(Path("/fixture"), sha, False)
            self.assertEqual(git.call_count, 1)
        with patch.object(planner, "bounded_git") as git:
            with self.assertRaises(planner.nightly.TrackingError):
                planner.ensure_metadata(Path("/fixture"), "main", True)
            git.assert_not_called()

    def test_git_network_wait_is_bounded_and_failures_do_not_expose_stderr(self):
        with patch.object(planner.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 60)) as run:
            with self.assertRaisesRegex(planner.nightly.TrackingError, "did not complete"):
                planner.resolve_default(Path("/fixture"))
            self.assertEqual(run.call_args.kwargs["timeout"], 60)
        result = SimpleNamespace(returncode=1, stdout=b"", stderr=b"private credential")
        with patch.object(planner.subprocess, "run", return_value=result):
            with self.assertRaises(planner.nightly.TrackingError) as error:
                planner.resolve_default(Path("/fixture"))
            self.assertNotIn("private credential", str(error.exception))


class PortingPlans(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.root = self.directory / "repo"
        self.root.mkdir()
        self.git("init", "--quiet")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Porting tests")
        for path, contents in {
            "apps/server/policy.ts": "policy\n",
            "apps/server/other.ts": "other\n",
            "apps/desktop/app.ts": "desktop\n",
            "apps/mobile/app.ts": "mobile\n",
            "packages/client-runtime/src/connection/session.ts": "connection\n",
            "packages/provider-fixture/adapter.ts": "provider\n",
            "apps/web/clean.ts": "clean\n",
            "apps/web/conflict.ts": "conflict\n",
            "apps/web/missing.ts": "missing\n",
            "apps/web/already.ts": "already\n",
            "apps/web/removed.ts": "removed\n",
            "packages/contracts/types.ts": "contracts\n",
            "packages/shared/adapter.ts": "shared adapter\n",
            "package.json": "{}\n",
            "AGENTS.md": "upstream guidance\n",
        }.items():
            self.write(path, contents)
        self.base = self.commit("upstream base")
        self.lock = {"schema_version": 1, "upstream": {"repository": "pingdotgg/t3code", "commit": self.base,
                     "root_tree": self.git("rev-parse", f"{self.base}^{{tree}}")},
                     "qualification": {"last_qualified_commit": None}}
        self.mapping = {"schema_version": 1, "integrated_upstream_commit": self.base,
                        "source_history": [self.base],
                        "supported_targets": ["linux-x64", "win32-x64", "browser"],
                        "ports": [self.port("policy", "apps/server/policy.ts")]}

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL).decode().strip()

    def write(self, path, contents):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(contents)

    def commit(self, message):
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", message)
        return self.git("rev-parse", "HEAD")

    def port(self, identifier, source):
        return {"id": identifier, "state": "integrated", "domain_owner": "apps/server",
                "reviewed_upstream_commit": self.base,
                "upstream_sources": [{"path": source, "blob": self.git("rev-parse", f"{self.base}:{source}")}],
                "adapter_paths": ["packages/shared/adapter.ts"], "retired_paths": [],
                "rust_paths": [f"crates/core/src/{identifier}.rs"], "rust_crates": ["crates/core"],
                "acceptance_tests": [f"tools/check-{identifier}.mjs"],
                "platform_routes": [{"targets": ["linux-x64"], "state": "integrated", "implementation": "rust",
                                     "compiler_route": "lustr-bluefe-compatibility", "acceptance_evidence": {}},
                                    {"targets": ["win32-x64"], "state": "integrated", "implementation": "upstream",
                                     "compiler_route": "node-upstream", "acceptance_evidence": {}}]}

    def upstream(self, edits):
        self.git("checkout", "--quiet", "--detach", self.base)
        for path, content in edits.items():
            if content is None:
                (self.root / path).unlink()
            else:
                self.write(path, content)
        return self.commit("upstream change")

    def fork(self, edits=None):
        self.git("checkout", "--quiet", "--detach", self.base)
        for path, content in (edits or {}).items():
            if content is None:
                (self.root / path).unlink()
            else:
                self.write(path, content)
        self.write("port-map.json", json.dumps(self.mapping, indent=2) + "\n")
        self.write("upstream.lock.json", json.dumps(self.lock, indent=2) + "\n")
        return self.commit("fork")

    def plan(self, head):
        return planner.build_plan(self.root, {"repository": "pingdotgg/t3code", "branch": None,
                                             "commit": head, "selection": "explicit-immutable-commit"})

    def test_three_way_comparison_separates_clean_imports_conflicts_and_missing_source(self):
        head = self.upstream({"apps/web/clean.ts": "upstream clean\n", "apps/web/conflict.ts": "upstream conflict\n",
                              "apps/web/missing.ts": "upstream missing\n", "apps/web/new.ts": "new\n",
                              "apps/web/already.ts": "upstream already\n", "package.json": '{"new":true}\n',
                              "AGENTS.md": "new upstream guidance\n"})
        fork = self.fork({"apps/web/conflict.ts": "fork conflict\n", "apps/web/missing.ts": None,
                          "apps/web/already.ts": "upstream already\n"})
        result = self.plan(head)
        changes = {item["path"]: item for item in result["changes"]}
        for path in ("apps/web/clean.ts", "apps/web/new.ts"):
            self.assertEqual(changes[path]["classification"], "mechanical-import-candidate")
        for path in ("apps/web/conflict.ts", "apps/web/missing.ts"):
            self.assertEqual(changes[path]["classification"], "fork-conflict")
        self.assertIsNone(changes["apps/web/missing.ts"]["fork"])
        self.assertEqual(changes["apps/web/already.ts"]["classification"], "already-matches-upstream")
        self.assertEqual(changes["package.json"]["classification"], "integration-boundary-review")
        self.assertEqual(changes["AGENTS.md"]["classification"], "fork-policy-review")
        self.assertEqual(result["revisions"], {"integrated_upstream": self.base, "trusted_upstream": head,
                                              "fork": fork, "qualified_upstream": None})
        self.assertFalse(result["trust"]["upstream_tests_required"])

    def test_added_persistence_sources_require_review_by_the_native_port(self):
        migration = "apps/server/src/persistence/Migrations/105_TaskFolders.ts"
        store = "apps/server/src/workspace/TaskFolderStore.ts"
        reference = ".repos/effect/packages/effect/src/Effect.ts"
        head = self.upstream({
            migration: "new database table",
            store: "new database repository",
            reference: "upstream reference",
        })
        self.mapping["ports"].append(self.port("redb-persistence", "apps/server/other.ts"))
        self.fork()
        result = self.plan(head)
        changes = {item["path"]: item for item in result["changes"]}
        for path in (migration, store):
            self.assertEqual(changes[path]["classification"], "translation-review")
            self.assertEqual(changes[path]["ports"], ["redb-persistence"])
        self.assertEqual(changes[reference]["classification"], "fork-policy-review")
        task = next(item for item in result["queue"] if item["id"] == "port:redb-persistence")
        self.assertEqual(task["upstream_paths"], [migration, store])
        self.assertTrue(task["blocks_upstream_integration"])

    def test_mode_changes_are_not_mistaken_for_identical_source(self):
        (self.root / "apps/web/clean.ts").chmod(0o755)
        head = self.commit("upstream mode")
        self.fork()
        change = next(item for item in self.plan(head)["changes"] if item["path"] == "apps/web/clean.ts")
        self.assertEqual(change["classification"], "mechanical-import-candidate")
        self.assertEqual(change["before"]["oid"], change["after"]["oid"])
        self.assertNotEqual(change["before"]["mode"], change["after"]["mode"])

    def test_removed_and_retired_sources_keep_translation_ownership(self):
        head = self.upstream({"apps/server/policy.ts": "new upstream policy\n", "apps/web/removed.ts": None})
        self.mapping["ports"][0]["state"] = "retired"
        self.mapping["ports"][0]["retired_paths"] = [{"path": "apps/server/policy.ts", "source_commit": self.base,
                                                      "source_blob": self.git("rev-parse", f"{self.base}:apps/server/policy.ts")}]
        self.fork({"apps/server/policy.ts": None, "apps/web/removed.ts": None})
        result = self.plan(head)
        changes = {item["path"]: item for item in result["changes"]}
        self.assertEqual(changes["apps/server/policy.ts"]["classification"], "translation-review")
        self.assertEqual(changes["apps/server/policy.ts"]["ports"], ["policy"])
        self.assertEqual(changes["apps/web/removed.ts"]["classification"], "upstream-removal-review")
        self.assertFalse(result["automation"]["retirement"])

    def test_exact_blob_rename_candidates_keep_old_and_new_paths_with_the_port(self):
        head = self.upstream({"apps/server/policy.ts": None, "apps/server/renamed.ts": "policy\n"})
        self.fork()
        result = self.plan(head)
        renamed = next(item for item in result["changes"] if item["path"] == "apps/server/renamed.ts")
        self.assertEqual(renamed["possible_rename_sources"], ["apps/server/policy.ts"])
        self.assertEqual(renamed["classification"], "translation-review")
        task = next(item for item in result["queue"] if item["id"] == "port:policy")
        self.assertEqual(task["upstream_paths"], ["apps/server/policy.ts", "apps/server/renamed.ts"])

    def test_shared_contract_and_adapter_changes_alert_every_rust_owner(self):
        head = self.upstream({"packages/contracts/types.ts": "new contract\n", "packages/shared/adapter.ts": "new adapter\n"})
        self.mapping["ports"].append(self.port("other", "apps/server/other.ts"))
        self.fork()
        result = self.plan(head)
        for item in result["queue"]:
            self.assertEqual(item["priority"], 10)
            self.assertEqual(item["action"], "adapt-rust-to-upstream")
            self.assertEqual(item["shared_contract_paths"], ["packages/contracts/types.ts"])
            self.assertEqual(item["compiler_routes"], ["lustr-bluefe-compatibility"])
        self.assertEqual(len(result["queue"]), 2)

    def test_contract_rename_keeps_all_owners_even_when_new_path_sorts_first(self):
        head = self.upstream({"packages/contracts/types.ts": None, "apps/server/moved-contract.ts": "contracts\n"})
        self.mapping["ports"].append(self.port("other", "apps/server/other.ts"))
        self.fork()
        result = self.plan(head)
        moved = next(item for item in result["changes"] if item["path"] == "apps/server/moved-contract.ts")
        self.assertEqual(moved["ports"], ["other", "policy"])
        self.assertEqual(moved["classification"], "translation-review")

    def test_backlog_reports_missing_platform_evidence_without_promoting_ports(self):
        self.mapping["ports"].append(self.port("candidate", "apps/server/other.ts"))
        self.mapping["ports"][1]["state"] = "candidate"
        self.fork()
        result = self.plan(self.base)
        self.assertEqual(result["status"], "current")
        self.assertEqual([item["action"] for item in result["queue"]],
                         ["qualify-integrated-port", "integrate-candidate-port"])
        for item in result["queue"]:
            self.assertFalse(item["blocks_upstream_integration"])
            self.assertFalse(item["retirement"]["automatic"])
            self.assertEqual(item["retirement"]["missing_rust_targets"], ["win32-x64", "browser"])
            self.assertEqual(item["retirement"]["missing_receipt_targets"], ["linux-x64", "win32-x64", "browser"])

    def test_reports_are_deterministic_and_do_not_touch_fork_source_or_pins(self):
        head = self.upstream({"apps/web/clean.ts": "new upstream\n"})
        fork = self.fork()
        self.write("apps/web/clean.ts", "uncommitted local work\n")
        before = self.git("status", "--porcelain")
        one, two = self.plan(head), self.plan(head)
        self.assertEqual(one, two)
        self.assertEqual(self.git("status", "--porcelain"), before)
        self.assertEqual(self.git("rev-parse", "HEAD"), fork)
        self.assertEqual((self.root / "apps/web/clean.ts").read_text(), "uncommitted local work\n")
        output = self.directory / "plan.json"
        summary = self.directory / "summary.md"
        args = ["--repo-root", str(self.root), "--upstream-commit", head, "--output", str(output), "--summary", str(summary)]
        self.assertEqual(planner.main(args), 0)
        timestamp = output.stat().st_mtime_ns
        self.assertEqual(planner.main(args), 0)
        self.assertEqual(output.stat().st_mtime_ns, timestamp)
        self.assertEqual(json.loads(output.read_text()), one)
        self.assertIn("Rust porting queue", summary.read_text())
        self.assertEqual(self.git("status", "--porcelain"), before)

    def test_exact_mechanical_merge_generates_an_applicable_metadata_patch(self):
        head = self.upstream({"apps/web/clean.ts": "changed upstream\n", "apps/web/new.ts": "new\n"})
        fork = self.fork({"apps/web/conflict.ts": "existing fork change\n"})
        self.git("merge", "--no-commit", head)
        index = self.git("write-tree")
        before = self.git("status", "--porcelain")
        patch = self.directory / "metadata.patch"
        report = self.directory / "plan.json"
        args = ["--repo-root", str(self.root), "--upstream-commit", head, "--output", str(report),
                "--mechanical-metadata-patch", str(patch)]
        self.assertEqual(planner.main(args), 0)
        self.assertEqual(self.git("status", "--porcelain"), before)
        self.assertEqual(self.git("write-tree"), index)
        self.assertEqual(self.git("rev-parse", "HEAD"), fork)
        self.git("apply", "--index", str(patch))
        mapping = json.loads((self.root / "port-map.json").read_text())
        lock = json.loads((self.root / "upstream.lock.json").read_text())
        self.assertEqual(mapping["source_history"], [self.base, head])
        self.assertEqual(mapping["integrated_upstream_commit"], head)
        self.assertEqual(mapping["ports"][0]["reviewed_upstream_commit"], head)
        self.assertEqual(mapping["ports"][0]["upstream_sources"], self.mapping["ports"][0]["upstream_sources"])
        self.assertEqual(lock["upstream"]["commit"], head)
        self.assertIn('"path_prefixes": ["apps/server/"],',
                      (self.root / "upstream.lock.json").read_text())
        self.assertEqual(lock["qualification"]["status"], "unqualified")
        self.assertIsNone(lock["qualification"]["last_qualified_commit"])

    def test_reviewed_merge_binds_the_resolution_and_refreshes_the_upstream_blob(self):
        path = "apps/server/policy.ts"
        head = self.upstream({path: "changed upstream policy\n"})
        fork = self.fork()
        self.git("merge", "--no-commit", head)
        self.write(path, "reviewed Rust policy adapter\n")
        self.git("add", path)
        plan = self.plan(head)
        staged_blob = self.git("rev-parse", ":" + path)
        upstream_blob = self.git("rev-parse", f"{head}:{path}")
        index = self.git("write-tree")
        with self.assertRaisesRegex(planner.nightly.TrackingError, "explicit source review"):
            planner.mechanical_metadata_patch(self.root, plan)
        with self.assertRaisesRegex(planner.nightly.TrackingError, "staged merge differs"):
            planner.mechanical_metadata_patch(self.root, plan, {path: upstream_blob})
        patch = self.directory / "metadata.patch"
        report = self.directory / "plan.json"
        self.assertEqual(planner.main([
            "--repo-root", str(self.root), "--upstream-commit", head, "--output", str(report),
            "--mechanical-metadata-patch", str(patch), "--reviewed-translation", f"{path}={staged_blob}",
        ]), 0)
        self.assertEqual(self.git("write-tree"), index)
        self.assertEqual(self.git("rev-parse", "HEAD"), fork)
        self.git("apply", "--index", str(patch))
        mapping = json.loads((self.root / "port-map.json").read_text())
        self.assertEqual(mapping["ports"][0]["upstream_sources"], [{"path": path, "blob": upstream_blob}])
        self.assertEqual(mapping["source_history"], [self.base, head])
        self.assertEqual(self.git("rev-parse", ":" + path), staged_blob)

    def test_reviewed_fork_conflict_requires_the_exact_resolved_blob(self):
        path = "apps/web/conflict.ts"
        head = self.upstream({path: "upstream change\n"})
        self.fork({path: "fork change\n"})
        subprocess.run(["git", "merge", "--no-commit", head], cwd=self.root,
                       capture_output=True, check=False)
        self.write(path, "fork and upstream change\n")
        self.git("add", path)
        plan = self.plan(head)
        staged_blob = self.git("rev-parse", ":" + path)
        upstream_blob = self.git("rev-parse", f"{head}:{path}")
        with self.assertRaisesRegex(planner.nightly.TrackingError, "explicit source review"):
            planner.mechanical_metadata_patch(self.root, plan)
        with self.assertRaisesRegex(planner.nightly.TrackingError, "staged merge differs"):
            planner.mechanical_metadata_patch(self.root, plan, {path: upstream_blob})
        patch = planner.mechanical_metadata_patch(self.root, plan, {path: staged_blob})
        self.assertIn(f'"commit": "{head}"', patch)
        self.assertEqual(self.git("rev-parse", ":" + path), staged_blob)

    def test_mechanical_metadata_refuses_staged_mode_or_unrelated_changes(self):
        head = self.upstream({"apps/web/clean.ts": "changed upstream\n"})
        self.fork()
        self.git("merge", "--no-commit", head)
        plan = self.plan(head)
        self.git("update-index", "--chmod=+x", "apps/web/clean.ts")
        with self.assertRaises(planner.nightly.TrackingError):
            planner.mechanical_metadata_patch(self.root, plan)
        self.git("update-index", "--chmod=-x", "apps/web/clean.ts")
        self.write("apps/web/extra.ts", "unreviewed\n")
        self.git("add", "apps/web/extra.ts")
        with self.assertRaisesRegex(planner.nightly.TrackingError, "staged merge differs"):
            planner.mechanical_metadata_patch(self.root, plan)

    def test_mechanical_metadata_refuses_policy_changes_and_multiple_merge_parents(self):
        head = self.upstream({"AGENTS.md": "changed upstream policy\n"})
        self.fork()
        self.git("merge", "--no-commit", head)
        plan = self.plan(head)
        with self.assertRaisesRegex(planner.nightly.TrackingError, "explicit source review"):
            planner.mechanical_metadata_patch(self.root, plan)
        merge_head = self.root / self.git("rev-parse", "--git-path", "MERGE_HEAD")
        merge_head.write_text(f"{head}\n{self.base}\n")
        with self.assertRaisesRegex(planner.nightly.TrackingError, "exact planned upstream"):
            planner.mechanical_metadata_patch(self.root, plan)

    def test_uncommitted_metadata_and_in_checkout_reports_are_rejected(self):
        self.fork()
        mapping = copy.deepcopy(self.mapping)
        mapping["ports"][0]["state"] = "accepted"
        self.write("port-map.json", json.dumps(mapping))
        with self.assertRaisesRegex(planner.nightly.TrackingError, "Commit port-map"):
            self.plan(self.base)
        for name in ("plan.json", "upstream.lock.json", "port-map.json", ".git/plan.json"):
            with self.subTest(name=name), self.assertRaises(planner.nightly.TrackingError):
                planner.output_path(self.root, self.root / name)


if __name__ == "__main__":
    unittest.main()
