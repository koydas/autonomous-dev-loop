# Autonomous Dev Loop

## Flow Diagram

```mermaid
graph TD
    A[Issue Created] --> B[Validate Issue]
    B --> C{Valid?}
    C -->|Yes| D[Generate PR]
    C -->|No| E[Reject Issue]

    D --> F[Create PR]
    F --> G[Review PR]
    G --> H{Approved?}
    H -->|Yes| I[Merge PR]
    H -->|No| J[Auto-Fix Attempts]

    J --> K[Apply Fixes]
    K --> L{Success?}
    L -->|Yes| I
    L -->|No| M[Exhausted Attempts]
```

### Flow Details
1. **Issue Validation**: Automated validation of new issues
2. **Issue to PR**: Conversion of validated issues to pull requests
3. **PR Review**: Automated review process
4. **Auto-Fix Attempts**: Automated fixing of review issues