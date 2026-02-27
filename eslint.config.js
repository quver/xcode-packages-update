import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    {
        ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'eslint.config.js', 'vitest.config.ts']
    },
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': 'error',
            eqeqeq: 'error',
            'prefer-const': 'error'
        }
    }
);
