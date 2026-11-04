declare module 'postcss/lib/tokenize' {
  import type { Input } from 'postcss';

  interface Tokenizer {
    endOfFile(): boolean;
    nextToken(): [type: string, text: string, start?: number, end?: number];
  }

  export default function tokenize(input: Input): Tokenizer;
}
