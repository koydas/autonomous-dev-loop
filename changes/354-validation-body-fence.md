### Fixed
- The validation user prompt fences the issue body (fence one backtick longer than any run in the body, at least 3) and titles the trailing section "Reminder (pipeline instruction, not part of the issue)", so the validator no longer reports the pipeline's own Reminder as issue text (#354).
