import { loadProjectFromFs } from '../../src/core/load';
import type { BlueprintProjectBundle, ValidationResult } from '../../src/core/types';
import type { ProjectValidator } from '../../src/mcp/project-validation';
import { projectFingerprint } from '../../src/mcp/project-validation-worker';

export function inProcessValidator(validate: (bundle: BlueprintProjectBundle) => ValidationResult): ProjectValidator {
  return {
    projected: async bundle => ({ ...validate(bundle), fingerprint: projectFingerprint(bundle) }),
    persisted: async (projectRoot, projectedFingerprint) => {
      const persisted = await loadProjectFromFs(projectRoot);
      return projectFingerprint(persisted) === projectedFingerprint ? { ok: true, errors: [] } : validate(persisted);
    }
  };
}
