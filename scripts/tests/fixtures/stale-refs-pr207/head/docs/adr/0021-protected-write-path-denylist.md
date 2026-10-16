|---|---|
| `.git/` | any path **segment** equal to `.git` (root or nested repository metadata) |
| `.github/`, `scripts/`, `config/`, `prompts/` | root-level prefix, or the bare directory name |
| `checkpoints/`, `metrics/`, `observability/` | root-level prefix, or the bare directory name |
| `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `.npmrc`, `.yarnrc`, `.yarnrc.yml` | file name at **any** depth (workspace manifests and nested rc files are install surface too) |

The path is normalized before matching: backslashes → `/`, `path.posix.normalize` (collapses `//`, `.` segments), leading `./` stripped, then lower-cased. `..` and absolute paths are still rejected earlier by the ADR-0003 check. The returned `targetPath` is unchanged for accepted paths.

Because validation works on the path string, `writeGeneratedFiles()` also resolves the real path before writing: it refuses a write whose nearest existing parent directory resolves (through a symlink already in the checkout) outside the repository or into `.git/`, and refuses to overwrite a file that is itself a symlink.
