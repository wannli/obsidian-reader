#!/usr/bin/env node
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPlugin } from './build.mjs';
import { repository } from './sandbox.mjs';

await buildPlugin();
await copyFile(join(repository, 'dist', 'main.js'), join(repository, 'main.js'));
console.log('Updated root main.js for Obsidian Hot Reload');
