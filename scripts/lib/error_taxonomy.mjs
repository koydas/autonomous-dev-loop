export const ERROR_TYPES = {
  TRANSIENT: ['timeout', '429', '5xx'],
  PERMANENT: ['401', '403', '400'],
  UNKNOWN: []
};

export function classifyError(error) {
  if (ERROR_TYPES.TRANSIENT.includes(error)) {
    return 'TRANSIENT';
  } else if (ERROR_TYPES.PERMANENT.includes(error)) {
    return 'PERMANENT';
  } else {
    return 'UNKNOWN';
  }
}