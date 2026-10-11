#!/usr/bin/env node
import { buildPlugin } from './build.mjs';

// Watch mode rebuilds dist only; vault installation is a separate explicit action.
await buildPlugin();
