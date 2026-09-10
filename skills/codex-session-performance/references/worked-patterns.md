# Worked reasoning patterns

These examples are generalized from tooling-upgrade work. Use their reasoning, not their specific remedies, in other domains.

## Same revision, restarted CI

Evidence: draft creation triggers a workflow; marking it ready shortly afterward triggers another for the same head; cancellation leaves one old job running and the new workflow pending. No product edit separates the runs.

Intervention: a PR lifecycle helper can inspect the workflow's trigger policy and report which transition would invalidate current checks. A repository can make duplicate events idempotent or remove a redundant trigger if no readiness-specific check requires it. A skill can teach the agent to recognize this condition before transitioning state. Preserve exact-head verification and required checks.

Measure duplicate executions and time from the reviewed head becoming available to its final gate. Do not assume waiting longer before marking ready fixes a workflow that always retriggers on readiness. Classify cancellation before diagnosing cancelled jobs as application failures.

## Worktree setup creates unrelated failures

Evidence: generated bindings are absent before type-aware lint; subprocess paths retain URL escapes; hook-launched fixture repositories inherit Git environment variables. Multiple validation failures follow the setup boundary.

Intervention: put deterministic setup knowledge in a small repository bootstrap/doctor command and a short documented prerequisite graph. Return structured missing prerequisites and a next action. Fix path decoding and child-environment isolation in the tooling itself. A skill should explain when to run the helper, not preserve a transcript of failed shell attempts.

Separate code defects discovered and repaired in the session from still-open documentation/tooling improvements. Setup and targeted validation should prevent later broad-suite failure, but do not assume every test failure is environmental.

## A browser suite dominates a delegated turn

Evidence: a multi-minute suite runs alongside heavy local jobs; one assertion times out during loading and passes a focused rerun. This suggests a readiness or resource issue but does not prove CPU contention or flakiness.

Intervention: measure the suite under representative solo and concurrent loads; inspect readiness signals and per-test setup. Reuse equivalent build artifacts and remove repeated startup only if that setup is actually measured. Prefer semantic readiness with a bounded timeout to arbitrary sleeps. Do not raise worker count or timeout blindly; both can make diagnosis or latency worse.

If the child still finishes well before the parent, report the benefit as child latency/resource savings, not parent savings. An independent reviewer overlapping the suite is not an additional serial delay unless the join evidence shows otherwise.

## Tool migration requires rediscovering semantics

Evidence: migration commands return no useful artifact, a guessed config serialization fails on cycles, or converted rules silently change file scope. The agent spends decisions reconstructing a compatibility map.

Intervention: a migration tool could return mapped rules/scopes/ignores, unsupported behavior, prerequisites, exit status, and an explicit generated-file manifest. An optional migration skill can route to that tool and specify a few negative behavior probes. Verify installed CLI usage before assuming a no-op means success; preserve unsupported behavior explicitly.

Benchmark equivalent checks after compatibility is established. A formatter that saves seconds may be useful across many iterations while doing little for a turn blocked by CI. Avoid hardcoding tool names or versions as universal recommendations.

## Late integration and benchmark reconstruction

Evidence: the base changes after visual references and broad validation; merge conflicts force a repeat. A later benchmark recreates only part of the baseline and omits ignore configuration, causing a scan of dependencies.

Intervention: establish the merge base before expensive final validation and carry forward evidence for unchanged contracts. Preserve an exact baseline with its lockfile, config, ignores, runtime and revision when performance comparison is part of the task. A reusable benchmark harness can reject mismatched file sets or failed commands before timing repeated runs.

Do not count all post-merge validation as waste: actual base changes require checks. Separate preventable doomed runs from necessary verification of the integrated result, and include baseline setup cost in the comparison workflow.
