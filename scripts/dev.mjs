#!/usr/bin/env node
import { buildPlugin } from './build.mjs';

// Setup opts an owned synthetic vault into Hot Reload; builds never seed, download or enable.
await buildPlugin({ development: true });
