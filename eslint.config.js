const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
    },
    {
        ...js.recommended,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': 'error',
            'no-console': 'off',
            'eqeqeq': 'error',
            'prefer-const': 'error',
        },
    },
];
