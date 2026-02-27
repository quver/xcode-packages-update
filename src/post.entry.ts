import { setFailed } from '@actions/core';
import { run } from './post.js';

run().catch(setFailed);
