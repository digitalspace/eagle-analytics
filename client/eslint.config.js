import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // TypeScript resolves identifiers itself, and no-undef has no browser globals to check against here.
  { rules: { 'no-undef': 'off' } },
);
