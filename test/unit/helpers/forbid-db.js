// Preloaded with `node --import` for the unit suite (see package.json "test:unit").
import { register } from 'node:module';

register('./forbid-db-loader.js', import.meta.url);
