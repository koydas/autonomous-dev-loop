# ADR-0044: Protected write paths: hard-coded floor plus per-repository config

- **Date:** 2026-10-20
- **Status:** Accepted

## Context

`PROTECTED_WRITE_PATHS` (ADR-0021) mixes three kinds of entries in one constant fixed to this repository's tree:

- **Universal floor** (execution with secrets, installation, git metadata): `.git/`, `.github/`, `package.json`, lock files, `.npmrc`, `.yarnrc*`.
- **Pipeline self-protection:** `scripts/`, `config/`, `prompts/`, `checkpoints/`, `metrics/`, `observability/` — the pipeline's own code and state (ADR-0021, ADR-0023).
- **Governance:** `docs/`, `README.md` (ADR-0021 amendment, incident #173).

On a repository the pipeline works on, `scripts/`, `config/` or `docs/` are ordinary code. Deterministic generation blocking (`generation_blocked.mjs`, ADR-0029) and auto-fix would refuse them wrongly, and the .NET and Python install surface (`*.csproj`, `requirements*.txt`, …) was not protected at all.

## Decision

1. **Floor, hard-coded, not overridable** (`PROTECTED_FLOOR` in `scripts/lib/protected_paths.mjs`):
   - Node, unchanged: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`; and `.git/`, `.github/`.
   - `config/protected-paths.yaml`: the per-repository list itself. A PR could otherwise drop an entry from it; a human merging that diff would be the only barrier (the ADR-0021 "merged unread" argument).
   - .NET: `*.csproj`, `*.fsproj`, `*.vbproj` (hold the `PackageReference`s, the .NET `package.json`); `Directory.Packages.props` (central versions); `Directory.Build.props`, `Directory.Build.targets` (imported by every project, run MSBuild tasks at build and restore); `NuGet.config` (package sources, the `.npmrc` equivalent); `global.json` (SDK selection and MSBuild SDKs resolved from NuGet); `packages.lock.json` (lock file).
   - Python: `requirements*.txt`, `pyproject.toml`, `poetry.lock`, `Pipfile`, `Pipfile.lock`, `uv.lock` (install inputs); `setup.py` (executes at install), `setup.cfg`; `pip.conf` (index override, the `.npmrc` equivalent).
   - Not covered (add per repository through the config): Go, Rust, Java and other ecosystems; `.claude/`, `AGENTS.md`, `CLAUDE.md` (open audit item F16).
2. **Per-repository additions** in `config/protected-paths.yaml`, key `protected_paths` (list or `[]`). The effective list is **floor ∪ config**, never a subtraction: there is no syntax to remove an entry, and the floor is always present whatever the file contains (`resolveProtectedPaths`). Entries are de-duplicated ignoring case; directory entries are ordered first, so for this repository the entry reported in an error message is unchanged.
3. **Entry grammar.** `dir/` root-level directory; `a/b.json` exact root-relative file; `name` file name at any depth, with at most one `*` standing for any run of non-`/` characters (`*.csproj`, `requirements*.txt`). The last two forms are new (exact path, wildcard). Everything else is rejected rather than matched silently never: absolute or `..` paths, backslashes, `./`, `//`, other glob characters, `*` outside a bare file name or alone, inline comments. `*` must be quoted in the file (a YAML alias otherwise).
4. **Fail-fast, deterministic.** The file is parsed at import of `output_writer.mjs` (`PROTECTED_WRITE_PATHS` stays an eager, frozen export). Invalid content throws `config/protected-paths.yaml: protected_paths[2] "…" …` with the field path; an unknown or duplicate key, a missing `protected_paths` key and a scalar value are errors too, so a typo cannot drop protection silently. A **missing** file means floor only; any other read error propagates.
5. **Where the file is read.** Next to the pipeline scripts, like `config.mjs`: workflows run the scripts from the default branch (ADR-0023), so a PR changing the file takes effect only once merged.
6. **One source.** `output_writer.findProtectedPathEntry` is the only matcher. `generation_blocked.findDeterministicBlock` calls `protectedPathEntry`; `static_verifier.guardrailRules` classifies the writer's `protected path` rejection. `protectedPathEntry` keeps its signature.
7. **This repository** declares `scripts/`, `config/`, `prompts/`, `checkpoints/`, `metrics/`, `observability/`, `docs/`, `README.md`. `scripts/tests/protected_paths.test.mjs` fails if the file is missing or lacks one of them, so the self-protection cannot be removed silently.
8. **Prompts** keep a static list (floor plus this repository's entries) and tell the model that the config can add more. `smoke.test.mjs` fails when either prompt misses an entry of the effective list, so a repository that changes its config must update its prompts.

## Alternatives Considered

- **Per-repo list in `models.yaml` or extending `yaml.mjs` with lists:** `models.yaml` is parsed flat into model defaults and `yaml.mjs` has no list support; changing a shared parser touches unrelated consumers. A dedicated file with a strict parser follows `review-evidence.yaml`.
- **Config able to override the floor (opt-in flag):** rejected in ADR-0021 and still rejected: a flag left on reopens the hole.
- **Prompt list interpolated at run time (`{{protected_paths}}`):** always in sync, but changes both prompts' callers and the `smoke.test.mjs` check. Deferred.
- **Floor without wildcards (`requirements.txt`, no `*.csproj`):** leaves `requirements-dev.txt` and every .NET project file writable.
- **Amend ADR-0021 only:** the change adds a trust surface (the config file), a file format and a matching grammar. ADR-0021 gets a pointer.

## Consequences

- ✅ Behavior is identical on this repository: same effective list, same error messages, no existing test changed.
- ✅ A repository without the file protects the floor only; `scripts/`, `config/`, `docs/` are writable there.
- ✅ A config cannot remove `.github/` or any other floor entry (tested).
- ⚠️ The default of a repository with no config is weaker than ADR-0021's single list: the default-protect posture became "floor, then opt in". The self-protection of this repository now depends on `config/protected-paths.yaml` (pinned by test and protected by the floor).
- ⚠️ In a repository without a `README.md` entry, the shrink guard (ADR-0021 amendment) is the only defense against a stubbed README.
- ⚠️ File names are matched at any depth, so `global.json` or `pyproject.toml` in an unrelated folder is blocked too: a false block, never a bypass.
- ⚠️ A repository with a broken config fails at startup of every script importing `output_writer.mjs` (generation, auto-fix, and anything importing `static_verifier.mjs`).
