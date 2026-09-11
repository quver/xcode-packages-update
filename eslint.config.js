import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig(
    {
        ignores: ['dist/**', 'coverage/**', 'eslint.config.js', 'vitest.config.ts']
    },
    tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            eqeqeq: 'error'
        }
    }
);
