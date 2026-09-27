import * as path from "path";
import { getConfigRoot } from "./paths";

/**
 * Named omp profile that may pass through to spawned omp processes.
 *
 * omp-web strips OMP_PROFILE/PI_PROFILE from its omp children because it reads
 * sessions from PI_CODING_AGENT_DIR (default `~/.omp/agent`) while a profiled
 * omp would use `~/.omp/profiles/<name>/agent` — the two would disagree. When
 * PI_CODING_AGENT_DIR pins omp-web to exactly the profile's agent dir they
 * agree, and keeping the profile lets omp also load that profile's plugins,
 * marketplaces, and caches, which live beside `agent/`.
 *
 * Mirrors omp's precedence: OMP_PROFILE wins; an explicitly empty OMP_PROFILE
 * selects the default profile.
 */
export function passthroughProfile(env: NodeJS.ProcessEnv): string | undefined {
  const profile = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (!profile || !agentDir) return undefined;
  const profileAgentDir = path.join(getConfigRoot(), "profiles", profile, "agent");
  return path.resolve(agentDir) === profileAgentDir ? profile : undefined;
}
