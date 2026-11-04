import { writeFileSync } from 'node:fs';
import { serializeJson } from '../core/raw-json';
import { generateProjectJsonSchema } from '../core/schemas/project';

writeFileSync('schema/blueprint-project.schema.json', serializeJson(generateProjectJsonSchema()));
