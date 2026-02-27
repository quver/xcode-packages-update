import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        clearMocks: true,
        reporters: ['verbose', ['junit', { outputFile: 'reports/junit.xml' }]],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.entry.ts'],
            reporter: ['lcov', 'text-summary']
        }
    }
});
