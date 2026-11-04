import { parentPort, workerData } from 'node:worker_threads';
import { readValidatedProject } from './project-validation';

const { projectRoot } = workerData as { projectRoot: string };
parentPort?.postMessage(await readValidatedProject(projectRoot));
