# Code Generation

## Overview

All scripts under `scripts/` must adhere to the following guidelines:

* Use Node.js built-ins only.
* No external runtime dependencies.
* Keep business logic in `scripts/lib/`, not in workflow YAML or entrypoint scripts.
* Prompts in `prompts/` as `.md` files, one per prompt.
* Secrets via GitHub Actions — never hardcode credentials.
* Unit tests present for new logic, with ≥80% coverage for all scripts, including new automation files beyond checkpoint.mjs.

## Unit Testing and Coverage

All new scripts must include unit tests and meet the ≥80% coverage threshold. This ensures that our automation logic is reliable and maintainable.