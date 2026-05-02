export const ERROR_TYPES = {
  TRANSIENT: ['timeout', '429'],
  PERMANENT: ['401', '403', '400'],
  UNKNOWN: []
};

export function classifyError(error) {
  if (ERROR_TYPES.TRANSIENT.includes(error)) {
    return 'TRANSIENT';
  }
  if (/^5\d\d$/.test(error)) {
    return 'TRANSIENT';
  }
  if (ERROR_TYPES.PERMANENT.includes(error)) {
    return 'PERMANENT';
  }
  return 'UNKNOWN';
}
