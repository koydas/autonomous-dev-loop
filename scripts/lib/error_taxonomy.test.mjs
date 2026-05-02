import { classifyError } from './error_taxonomy.mjs';

// Unit tests for error classification
console.assert(classifyError('429') === 'TRANSIENT');
console.assert(classifyError('401') === 'PERMANENT');
console.assert(classifyError('unknown') === 'UNKNOWN');