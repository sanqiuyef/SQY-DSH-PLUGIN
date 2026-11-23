/**
 * dsh-skill-manager — Host half.
 *
 * Mounts nothing but the HTTP surface: the panel reads and writes skill files on
 * disk, and the host's own `skill-filesystem` provider watches those roots, so a
 * change made here reaches the next model step without a restart.
 *
 * Config (all optional; every field has a default in the environment):
 *   dshHome          - harness config root (default `$DSH_HOME` or `~/.dsh`)
 *   agentsHome       - shared agents root (default `$DSH_AGENTS_HOME` or `~/.agents`)
 *   zcodeHome        - ZCode root (default `$ZCODE_HOME` or `~/.zcode`)
 *   customSkillDirs  - extra roots scanned at rank 300
 *   marketDir        - local skills market clone (default `<dshHome>/skills-management/market`)
 *   bundledSkillDir  - read-only bundled root at rank 600 (default `$DSH_BUNDLED_SKILL_DIR`)
 */

import { registerRoutes } from './routes.js';

/** Loader entry id, matching this bundle's `cordis.patch.yml`. */
export const name = 'skill-manager';

/** Host services this plugin needs; all of them must exist for it to mount. */
export const inject = ['webServer', 'connection', 'workingDirectory'];

/** Trim a config value to `undefined` unless it is a non-empty string. */
function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Normalize the row's `config` into the shape the routes expect. */
export function resolveOptions(config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {};
  return {
    dshHome: optionalText(source.dshHome),
    agentsHome: optionalText(source.agentsHome),
    zcodeHome: optionalText(source.zcodeHome),
    customSkillDirs: Array.isArray(source.customSkillDirs)
      ? source.customSkillDirs.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      : [],
    marketDir: optionalText(source.marketDir),
    bundledSkillDir: optionalText(source.bundledSkillDir),
  };
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx - Cordis plugin context (`webServer`, `connection`, `workingDirectory`)
 * @param {object} [config] - optional row config, see the module header
 */
export function apply(ctx, config = {}) {
  const options = resolveOptions(config);
  ctx.effect(() => {
    const disposers = registerRoutes(ctx, options);
    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose?.();
        } catch {
          /* one failing route must not keep the others mounted */
        }
      }
    };
  }, 'skill-manager: http routes');
}

export default { name, inject, apply, resolveOptions };
