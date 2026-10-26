export function run(args) {
  return args.includes('--dry-run') ? 'dry' : 'run';
}
