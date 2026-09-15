import { readYamlFile } from "../../config/infrastructure/read-yaml-file";
import {
  JobRadarConfig,
  JobRadarConfigSchema,
} from "../domain/job-radar-config";

export class JobRadarConfigValidationError extends Error {
  constructor(
    filePath: string,
    issues: readonly { path: PropertyKey[]; message: string }[],
  ) {
    super(
      `Invalid job radar config at ${filePath}:\n` +
        issues
          .map(
            (issue) =>
              `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("\n"),
    );
    this.name = "JobRadarConfigValidationError";
  }
}

export function loadJobRadarConfig(filePath: string): JobRadarConfig {
  const result = JobRadarConfigSchema.safeParse(readYamlFile(filePath));
  if (!result.success) {
    throw new JobRadarConfigValidationError(filePath, result.error.issues);
  }
  return result.data;
}
