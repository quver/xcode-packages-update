import { defineConfig } from 'vitest/config';
import { version } from './package.json';

export default defineConfig({
    // Mirrors esbuild's --define in the build script, so tests run the same code path as the bundle.
    define: {
        __PACKAGE_VERSION__: JSON.stringify(version)
    },
    test: {
        include: ['tests/**/*.test.ts'],
        reporters: ['verbose', ['junit', { outputFile: 'reports/junit.xml' }]],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.entry.ts'],
            reporter: ['lcov', 'text-summary']
        }
    }
});
