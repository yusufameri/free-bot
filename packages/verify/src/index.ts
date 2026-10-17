import { join } from "node:path";

/** Run artifact directory for one feature: packages/verify/artifacts/<feature>/<sha>. */
export function artifactDir(repoRoot: string, feature: string, sha: string): string {
  return join(repoRoot, "packages", "verify", "artifacts", feature, sha);
}
