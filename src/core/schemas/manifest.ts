import * as z from 'zod/v4';
import { schemaVersionSchema, stringListSchema } from './common';
import { named } from './registry';

export const boardKindSchema = z.enum(['primitives', 'screens']);

export const prototypeHostPolicySchema = named('prototypeHost', z.object({
  /** Relative directories that may contain prototype assets. */
  assetRoots: stringListSchema,
  network: z.literal('deny'),
  scripts: z.literal('none')
}));

export const projectManifestSchema = named('project', z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  owner: z.string(),
  sourceRoot: z.string()
}));

export const boardSchema = named('board', z.object({
  id: z.string(),
  kind: boardKindSchema,
  name: z.string(),
  description: z.string()
}));

export const framePresetSchema = named('framePreset', z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['mobile', 'desktop']),
  width: z.number(),
  height: z.number(),
  safeArea: z.object({
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
    left: z.number()
  })
}));

export const manifestSchema = named('manifest', z.object({
  schemaVersion: schemaVersionSchema,
  handoffContractVersion: z.string().optional(),
  project: projectManifestSchema,
  defaultBoardId: z.string(),
  boards: z.array(boardSchema),
  framePresets: z.array(framePresetSchema),
  prototypeHost: prototypeHostPolicySchema
}));

export type BoardKind = z.infer<typeof boardKindSchema>;
export type PrototypeHostPolicy = z.infer<typeof prototypeHostPolicySchema>;
export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export type BoardDefinition = z.infer<typeof boardSchema>;
export type FramePreset = z.infer<typeof framePresetSchema>;
export type BlueprintManifest = z.infer<typeof manifestSchema>;
