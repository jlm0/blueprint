import { a } from './cycle-a';

export const b = (): number => a() + 1;
