import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveSafeTempDir } from '../src/temp-dir.js';

let root: string;
let workspace: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-packages-temp-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveSafeTempDir', () => {
    test('accepts a nested path whose parents do not exist yet', () => {
        expect(resolveSafeTempDir('build/checkouts', workspace)).toBe(
            path.join(fs.realpathSync(workspace), 'build', 'checkouts')
        );
    });

    test('rejects a path through a symlinked parent outside the workspace', () => {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(path.join(outside, 'checkouts'), { recursive: true });
        fs.symlinkSync(outside, path.join(workspace, 'build'));

        expect(() => resolveSafeTempDir('build/checkouts', workspace)).toThrow(
            'must resolve to a subdirectory inside the workspace'
        );
        expect(fs.existsSync(path.join(outside, 'checkouts'))).toBe(true);
    });

    test('uses the real destination of a symlinked parent inside the workspace', () => {
        const build = path.join(workspace, 'build');
        fs.mkdirSync(build);
        fs.symlinkSync(build, path.join(workspace, 'alias'));

        expect(resolveSafeTempDir('alias/checkouts', workspace)).toBe(path.join(fs.realpathSync(build), 'checkouts'));
    });

    test('unlinks a leaf symlink without deleting its target', () => {
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(workspace, '.spm-tmp'));

        fs.rmSync(resolveSafeTempDir('.spm-tmp', workspace), { recursive: true, force: true });

        expect(fs.existsSync(outside)).toBe(true);
        expect(fs.existsSync(path.join(workspace, '.spm-tmp'))).toBe(false);
    });

    test('rejects lexical paths outside the workspace', () => {
        expect(() => resolveSafeTempDir('..', workspace)).toThrow(
            'must resolve to a subdirectory inside the workspace'
        );
    });
});
