### Added
- `scripts/measure_line_tolerance.mjs`: offline replay of a published `review` eval run through `substantiateFindings`, bucketing unverified blocking findings by distance to the nearest hunk (#333, ADR-0063). Measured on run 40161093183 (108 blocking findings, all supported, none unverified): the RV-05 location tolerance stays at 5. Not wired into any workflow; no eval threshold moves.
