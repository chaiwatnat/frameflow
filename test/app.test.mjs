import { test } from 'node:test';
import { checks } from './checks.mjs';
for (const [name, check] of checks) test(name, check);
