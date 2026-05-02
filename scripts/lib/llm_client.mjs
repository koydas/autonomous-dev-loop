import { classifyError } from './error_taxonomy.mjs';

// ... existing content ...

// Modified to only fall back on TRANSIENT errors
if (classifyError(error) === 'TRANSIENT') {
  // fall back to secondary provider
}