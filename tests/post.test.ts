import { vi, beforeEach, describe, test, expect } from 'vitest';
import type { run as RunFn } from '../src/post.js';

let mockGetState: ReturnType<typeof vi.fn>;
let mockSetFailed: ReturnType<typeof vi.fn>;
let mockRmSync: ReturnType<typeof vi.fn>;

beforeEach(() => {
    mockGetState = vi.fn();
    mockSetFailed = vi.fn();
    mockRmSync = vi.fn();
    vi.resetModules();

    vi.doMock('@actions/core', () => ({
        getState: mockGetState,
        setFailed: mockSetFailed
    }));

    vi.doMock('fs', () => ({
        default: {
            rmSync: mockRmSync
        }
    }));
});

async function loadRun(): Promise<typeof RunFn> {
    const { run } = await import('../src/post.js');
    return run;
}

describe('post', () => {
    test('removes tempDir when set', async () => {
        mockGetState.mockImplementation((key: string) => (key === 'temp_dir' ? '.spm-tmp' : ''));

        const run = await loadRun();
        await run();

        expect(mockRmSync).toHaveBeenCalledWith('.spm-tmp', { recursive: true, force: true });
    });

    test('removes currentPackage when set', async () => {
        mockGetState.mockImplementation((key: string) =>
            key === 'current_package' ? '/path/to/CurrentPackage.resolved' : ''
        );

        const run = await loadRun();
        await run();

        expect(mockRmSync).toHaveBeenCalledWith('/path/to/CurrentPackage.resolved', { force: true });
    });

    test('removes both when both are set', async () => {
        mockGetState.mockImplementation((key: string) => {
            if (key === 'temp_dir') return '.spm-tmp';
            if (key === 'current_package') return '/path/to/CurrentPackage.resolved';
            return '';
        });

        const run = await loadRun();
        await run();

        expect(mockRmSync).toHaveBeenCalledTimes(2);
    });

    test('does not call rmSync when both states are empty', async () => {
        mockGetState.mockReturnValue('');

        const run = await loadRun();
        await run();

        expect(mockRmSync).not.toHaveBeenCalled();
    });
});
